// Turns the Tesla's afternoon charge schedule on or off, following the charging plan that
// fetch-prices.mjs writes into prices.json (see charging.mjs). The night schedule (02–06) is never touched.
//   - outside the afternoon window the afternoon schedule is off
//   - inside it, the schedule is on once today's plan says the afternoon is cheaper than the night
//
//   node scripts/tesla-charge.mjs          follow the plan and update the car if needed (the workflow runs this hourly)
//   node scripts/tesla-charge.mjs on|off   switch the afternoon schedule on or off right now
//   add --dry-run to print the decision without contacting the car
//
// The car is only woken when the schedule has to change, so most runs make no Tesla calls at all.
// Needs TESLA_CLIENT_ID, TESLA_VIN, TESLA_SCHEDULE_ID (the afternoon schedule's id, from
// `node scripts/tesla-setup.mjs schedules`) and tesla-control (TESLA_CONTROL, default on PATH).
// In the workflow also TESLA_REFRESH_TOKEN, TESLA_PRIVATE_KEY and GH_TOKEN; locally the token
// and key come from .tesla/ (see tesla-setup.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { copenhagenNow } from './time.mjs';
import { requireEnv, refreshAccessToken, wakeUp, chargeSchedules, formatMinutes } from './tesla.mjs';
import { AFTERNOON } from './charging.mjs';

const PRICES_FILE = 'data/prices.json';
// Remembers what the car was last set to and when the token was refreshed; never holds secrets, it's committed
const STATE_FILE = 'data/charge.json';
const LOCAL_TOKEN_FILE = '.tesla/token.json';
const LOCAL_KEY_FILE = '.tesla/private-key.pem';

// Refresh tokens expire after 3 months unused, so refresh at least this often even when idle
const REFRESH_EVERY_DAYS = 7;

const WEEKDAYS = ['Sun', 'Mon', 'Tues', 'Wed', 'Thurs', 'Fri', 'Sat'];
const inWorkflow = Boolean(process.env.GITHUB_ACTIONS);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const mode = args.find(a => !a.startsWith('--')) ?? 'auto';
if (!['auto', 'on', 'off'].includes(mode)) {
    throw new Error(`Unknown option "${mode}", expected on, off or nothing`);
}

if (inWorkflow && !process.env.TESLA_REFRESH_TOKEN) {
    console.log('TESLA_REFRESH_TOKEN is not set, skipping the Tesla schedule.');
    process.exit(0);
}

const data = JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8'));
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
const now = copenhagenNow();

const wanted = mode === 'auto' ? planned() : mode === 'on';
console.log(`Afternoon charging: ${wanted ? 'on' : 'off'} (car was last set ${describe(state.enabled)}).`);

const tokenIsOld = !state.tokenRefreshedAt
    || Date.now() - Date.parse(state.tokenRefreshedAt) > REFRESH_EVERY_DAYS * 24 * 3600 * 1000;

if (dryRun) {
    console.log(wanted === state.enabled && mode === 'auto' ? 'Nothing to change.' : 'Would update the car.');
} else {
    // Saved even when the car can't be reached, so a token refreshed before the failure is remembered
    try {
        if (wanted !== state.enabled || mode !== 'auto') {
            const accessToken = await accessTokenFor();
            await setAfternoonSchedule(accessToken, wanted);
            state.enabled = wanted;
        } else if (tokenIsOld) {
            await accessTokenFor();
            console.log('Refreshed the Tesla token to keep it from expiring.');
        }
    } finally {
        save();
    }
}

/** Whether the plan in prices.json has the afternoon schedule on right now */
function planned() {
    if (now.hour < AFTERNOON.from || now.hour >= AFTERNOON.until) return false;
    const decision = data.charging?.decision;
    if (decision?.date !== now.date) return false;
    console.log(`Today's plan: afternoon ${decision.afternoon.toFixed(2)} kr/kWh, tomorrow's night ${decision.night.toFixed(2)} kr/kWh.`);
    return decision.charge;
}

function describe(enabled) {
    return enabled === undefined ? 'never' : enabled ? 'on' : 'off';
}

/** A fresh access token; Tesla hands out a new single-use refresh token with it, which we keep */
async function accessTokenFor() {
    if (!inWorkflow) {
        const token = JSON.parse(fs.readFileSync(LOCAL_TOKEN_FILE, 'utf8'));
        if (token.expires_at > Date.now() + 5 * 60 * 1000) return token.access_token;
        const fresh = await refreshAccessToken(token.refresh_token);
        fs.writeFileSync(LOCAL_TOKEN_FILE, JSON.stringify({
            access_token: fresh.access_token,
            refresh_token: fresh.refresh_token,
            expires_at: Date.now() + fresh.expires_in * 1000
        }, null, 2) + '\n', { mode: 0o600 });
        return fresh.access_token;
    }

    const fresh = await refreshAccessToken(requireEnv('TESLA_REFRESH_TOKEN'));
    // Store the new refresh token before anything else can fail; the old one only lasts another 24 hours
    const result = spawnSync('gh', ['secret', 'set', 'TESLA_REFRESH_TOKEN', '--repo', requireEnv('GITHUB_REPOSITORY')], {
        input: fresh.refresh_token,
        encoding: 'utf8'
    });
    if (result.status !== 0) {
        throw new Error(`Couldn't save the new refresh token: ${result.stderr || result.error}`);
    }
    state.tokenRefreshedAt = new Date().toISOString();
    return fresh.access_token;
}

/** Re-saves the afternoon schedule exactly as it is in the car, only switching it on or off */
async function setAfternoonSchedule(accessToken, enabled) {
    const vin = requireEnv('TESLA_VIN');
    const id = Number(requireEnv('TESLA_SCHEDULE_ID'));

    await wakeUp(accessToken, vin);
    const schedule = (await chargeSchedules(accessToken, vin)).find(s => s.id === id);
    if (!schedule) {
        throw new Error(`The car has no charge schedule with id ${id}; run "node scripts/tesla-setup.mjs schedules" to find it`);
    }
    const times = `${schedule.start_enabled ? formatMinutes(schedule.start_time) : ''}-${schedule.end_enabled ? formatMinutes(schedule.end_time) : ''}`;
    if (schedule.start_time !== AFTERNOON.from * 60 || schedule.end_time !== AFTERNOON.until * 60) {
        console.warn(`The car's schedule runs ${times}, but this script compares prices for ${AFTERNOON.from}:00-${AFTERNOON.until}:00.`);
    }

    // tesla-control signs the command with our private key, which the car trusts once paired
    const files = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'tesla-'));
    try {
        const tokenFile = path.join(files, 'token');
        fs.writeFileSync(tokenFile, accessToken, { mode: 0o600 });
        let keyFile = LOCAL_KEY_FILE;
        if (inWorkflow) {
            keyFile = path.join(files, 'key.pem');
            fs.writeFileSync(keyFile, requireEnv('TESLA_PRIVATE_KEY'), { mode: 0o600 });
        }

        const result = spawnSync(process.env.TESLA_CONTROL ?? 'tesla-control', [
            '-vin', vin, '-key-file', keyFile, '-token-file', tokenFile,
            'charging-schedule-add', days(schedule.days_of_week), times,
            String(schedule.latitude), String(schedule.longitude),
            schedule.one_time ? 'once' : 'weekly', String(id), String(enabled)
        ], { encoding: 'utf8' });
        if (result.status !== 0) {
            throw new Error(`tesla-control failed: ${(result.stderr || result.stdout || String(result.error)).trim()}`);
        }
    } finally {
        fs.rmSync(files, { recursive: true, force: true });
    }
    console.log(`Afternoon schedule ${times} switched ${enabled ? 'on' : 'off'}.`);
}

/** The car's day bitmask (Sun = 1 … Sat = 64) as tesla-control expects it, e.g. "all" or "Mon,Wed" */
function days(mask) {
    if (mask === 127) return 'all';
    return WEEKDAYS.filter((_, i) => mask & (1 << i)).join(',');
}

function save() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}
