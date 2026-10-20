// Turns the Tesla's afternoon charge schedule on or off, so it only charges in the afternoon
// when that's cheaper than the night that follows. The night schedule (02–06) is never touched.
//   - outside the afternoon window the afternoon schedule is off
//   - once tomorrow's prices are published, it's switched on for the rest of the afternoon
//     if those hours are cheaper on average than tomorrow's 02–06
//
//   node scripts/tesla-charge.mjs          decide and update the car if needed (the workflow runs this hourly)
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
import { copenhagenNow, addDays } from './time.mjs';
import { requireEnv, refreshAccessToken, wakeUp, chargeSchedules, formatMinutes } from './tesla.mjs';

const PRICES_FILE = 'data/prices.json';
// Remembers the day's decision and what the car was last set to; never holds secrets, it's committed
const STATE_FILE = 'data/charge.json';
const LOCAL_TOKEN_FILE = '.tesla/token.json';
const LOCAL_KEY_FILE = '.tesla/private-key.pem';

// Copenhagen hours, matching the schedules set in the car
const AFTERNOON = { from: 12, until: 17 };
const NIGHT = { from: 2, until: 6 };
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

const wanted = mode === 'auto' ? decide() : mode === 'on';
console.log(`Afternoon charging: ${wanted ? 'on' : 'off'} (car was last set ${describe(state.enabled)}).`);

const tokenIsOld = !state.tokenRefreshedAt
    || Date.now() - Date.parse(state.tokenRefreshedAt) > REFRESH_EVERY_DAYS * 24 * 3600 * 1000;

if (dryRun) {
    console.log(wanted === state.enabled && mode === 'auto' ? 'Nothing to change.' : 'Would update the car.');
} else {
    // Saved even when the car can't be reached, so the next run keeps today's decision and retries it
    try {
        if (wanted !== state.enabled || mode !== 'auto') {
            const accessToken = await accessTokenFor();
            await setAfternoonSchedule(accessToken, wanted);
            state.enabled = wanted;
            // Only now is the car really charging this afternoon, which the notifications and site rely on
            if (wanted && state.decision?.date === now.date) state.decision.switchedOn = true;
        } else if (tokenIsOld) {
            await accessTokenFor();
            console.log('Refreshed the Tesla token to keep it from expiring.');
        }
    } finally {
        save();
    }
}

/** Whether the afternoon schedule should be on right now, remembering the day's decision */
function decide() {
    if (now.hour < AFTERNOON.from || now.hour >= AFTERNOON.until) return false;
    if (state.decision?.date === now.date) return state.decision.charge;

    // Tomorrow's prices arrive around 13:00; until then there's nothing to compare with
    const today = findDay(now.date);
    const tomorrow = findDay(addDays(now.date, 1));
    // The current hour counts only for the minutes left in it
    const afternoon = average(today, AFTERNOON.from, AFTERNOON.until, now);
    const night = average(tomorrow, NIGHT.from, NIGHT.until);
    if (afternoon === null || night === null) return false;

    const charge = afternoon < night;
    state.decision = { date: now.date, charge, afternoon: round(afternoon), night: round(night) };
    console.log(`Rest of the afternoon ${afternoon.toFixed(2)} kr/kWh, tomorrow's night ${night.toFixed(2)} kr/kWh.`);
    return charge;
}

function findDay(date) {
    return [data.today, data.tomorrow].find(day => day?.date === date);
}

/**
 * Average price over [from, until), or null if the day's prices aren't all published yet.
 * Every hourly record counts, so the hour that's skipped or repeated when the clocks change is handled.
 * With `since` ({ hour, minute }), only the time from then on counts.
 */
function average(day, from, until, since = { hour: 0, minute: 0 }) {
    // A day has 23–25 hourly prices; fewer means it's still incomplete
    if (!day || day.hours.length < 23) return null;
    let total = 0;
    let weight = 0;
    for (const { hour, price } of day.hours) {
        if (hour < from || hour >= until || hour < since.hour) continue;
        const share = hour === since.hour ? (60 - since.minute) / 60 : 1;
        total += price * share;
        weight += share;
    }
    return weight > 0 ? total / weight : null;
}

function round(price) {
    return Math.round(price * 1000) / 1000;
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
    // notify.mjs reads these to mark the charging hours in the family notifications
    state.windows = { night: NIGHT, afternoon: AFTERNOON };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}
