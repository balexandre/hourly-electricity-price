// One-off helpers for connecting the Tesla to this repo. Run them locally, in this order:
//
//   node scripts/tesla-setup.mjs register    tell Tesla's EU region about our domain and public key
//   node scripts/tesla-setup.mjs login       sign in with the car owner's Tesla account (opens the browser)
//   node scripts/tesla-setup.mjs vehicles    list the cars on the account, with their VINs
//   node scripts/tesla-setup.mjs schedules   show the car's charge schedules (wakes the car)
//
// Needs TESLA_CLIENT_ID and TESLA_SECRET (from .env), plus TESLA_VIN for `schedules`.
// The login is saved to .tesla/token.json, which git ignores.
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import {
    FLEET_API, AUTHORIZE_URL, SCOPES,
    requireEnv, requestToken, refreshAccessToken, fleet, wakeUp, chargeSchedules, formatMinutes
} from './tesla.mjs';

// Must match the app's "Allowed Origin" on developer.tesla.com, and serve the public key at
// https://<domain>/.well-known/appspecific/com.tesla.3p.public-key.pem
const DOMAIN = process.env.TESLA_DOMAIN ?? 'balexandre.github.io';
// Must match the app's "Allowed Redirect URI"
const REDIRECT_URI = 'http://localhost:3002/callback';
const TOKEN_FILE = '.tesla/token.json';

const command = process.argv[2];
const commands = { register, login, vehicles, schedules };
if (!commands[command]) {
    throw new Error(`Unknown command "${command ?? ''}", expected ${Object.keys(commands).join(', ')}`);
}
await commands[command]();

async function register() {
    const { access_token } = await requestToken({
        grant_type: 'client_credentials',
        client_secret: requireEnv('TESLA_SECRET'),
        scope: SCOPES,
        audience: FLEET_API
    });

    await fleet(access_token, '/api/1/partner_accounts', { method: 'POST', body: { domain: DOMAIN } });
    const { public_key } = await fleet(access_token, `/api/1/partner_accounts/public_key?domain=${DOMAIN}`);
    console.log(`Registered ${DOMAIN} in the EU region. Tesla has its public key: ${public_key.slice(0, 16)}…`);
}

async function login() {
    const state = crypto.randomUUID();
    const url = `${AUTHORIZE_URL}?${new URLSearchParams({
        response_type: 'code',
        client_id: requireEnv('TESLA_CLIENT_ID'),
        redirect_uri: REDIRECT_URI,
        scope: SCOPES,
        state,
        prompt_missing_scopes: 'true'
    })}`;

    const code = await new Promise((resolve, reject) => {
        const server = http.createServer((request, response) => {
            const params = new URL(request.url, REDIRECT_URI).searchParams;
            if (!request.url.startsWith('/callback')) {
                response.writeHead(404).end();
                return;
            }
            const failure = params.get('error') ?? (params.get('state') !== state && 'state mismatch');
            response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
                .end(failure ? `Login failed: ${failure}` : 'Signed in. You can close this tab and go back to the terminal.');
            server.close();
            if (failure) reject(new Error(`Login failed: ${failure}`));
            else resolve(params.get('code'));
        });
        server.listen(3002, () => {
            console.log(`Opening the Tesla sign-in page. If it doesn't open, visit:\n${url}\n`);
            execFile('open', [url], () => {});
        });
    });

    const token = await requestToken({
        grant_type: 'authorization_code',
        client_secret: requireEnv('TESLA_SECRET'),
        code,
        redirect_uri: REDIRECT_URI,
        audience: FLEET_API
    });
    saveToken(token);
    console.log(`Signed in with scopes: ${token.scope ?? '(not reported)'}`);
    console.log(`Saved to ${TOKEN_FILE}. Next: pair the key in the Tesla app by opening https://tesla.com/_ak/${DOMAIN} on your phone.`);
}

async function vehicles() {
    const list = await fleet(await accessToken(), '/api/1/vehicles');
    for (const v of list) console.log(`${v.vin}  ${v.display_name ?? ''}  (${v.state})`);
}

async function schedules() {
    const token = await accessToken();
    const vin = requireEnv('TESLA_VIN');
    await wakeUp(token, vin);
    for (const s of await chargeSchedules(token, vin)) {
        const start = s.start_enabled ? formatMinutes(s.start_time) : '';
        const end = s.end_enabled ? formatMinutes(s.end_time) : '';
        console.log(`id ${s.id}  ${start}–${end}  days ${s.days_of_week}  ${s.enabled ? 'on' : 'off'}${s.one_time ? '  once' : ''}  at ${s.latitude},${s.longitude}  ${s.name ?? ''}`);
    }
}

/** A valid access token from .tesla/token.json, refreshing (and re-saving) it when it has expired */
async function accessToken() {
    if (!fs.existsSync(TOKEN_FILE)) throw new Error(`No ${TOKEN_FILE} yet, run: node scripts/tesla-setup.mjs login`);
    const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (Date.now() < saved.expires_at - 60_000) return saved.access_token;

    const token = await refreshAccessToken(saved.refresh_token);
    saveToken(token);
    return token.access_token;
}

function saveToken(token) {
    fs.mkdirSync('.tesla', { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: Date.now() + token.expires_in * 1000
    }, null, 2) + '\n', { mode: 0o600 });
}
