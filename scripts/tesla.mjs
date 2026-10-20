// Small Tesla Fleet API client shared by tesla-setup.mjs and tesla-charge.mjs.
// Reads only; anything that changes the car goes through tesla-control, which signs the command.
import fs from 'node:fs';

// The car is registered in Europe; the token endpoint is the same for every region
export const FLEET_API = 'https://fleet-api.prd.eu.vn.cloud.tesla.com';
export const AUTHORIZE_URL = 'https://auth.tesla.com/oauth2/v3/authorize';
const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';

export const SCOPES = 'openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds';

// Local runs keep TESLA_CLIENT_ID and TESLA_SECRET in .env; the workflow passes them as secrets
if (fs.existsSync('.env')) process.loadEnvFile('.env');

export function requireEnv(name) {
    if (!process.env[name]) throw new Error(`${name} is not set`);
    return process.env[name];
}

/** POSTs to Tesla's token endpoint and returns { access_token, refresh_token?, expires_in } */
export async function requestToken(params) {
    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: requireEnv('TESLA_CLIENT_ID'), ...params })
    });
    if (!response.ok) {
        throw new Error(`Tesla token endpoint responded ${response.status}: ${await response.text()}`);
    }
    return response.json();
}

/**
 * Swaps a refresh token for a new access token. Tesla refresh tokens are single use,
 * so the caller must keep the refresh_token that comes back.
 */
export function refreshAccessToken(refreshToken) {
    return requestToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
}

/** Calls the Fleet API and returns its `response` field */
export async function fleet(accessToken, path, { method = 'GET', body } = {}) {
    const response = await fetch(`${FLEET_API}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${accessToken}`,
            ...(body && { 'Content-Type': 'application/json' })
        },
        body: body && JSON.stringify(body)
    });
    if (!response.ok) {
        const error = new Error(`Fleet API ${method} ${path} responded ${response.status}: ${await response.text()}`);
        error.status = response.status;
        throw error;
    }
    return (await response.json()).response;
}

/** Wakes the car and waits until it's online; commands and live data fail while it sleeps */
export async function wakeUp(accessToken, vin, { timeoutSeconds = 90 } = {}) {
    let vehicle = await fleet(accessToken, `/api/1/vehicles/${vin}`);
    if (vehicle.state === 'online') return;

    // Tesla allows 3 wake requests a minute, so ask once and then just poll
    await fleet(accessToken, `/api/1/vehicles/${vin}/wake_up`, { method: 'POST' });
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        vehicle = await fleet(accessToken, `/api/1/vehicles/${vin}`);
        if (vehicle.state === 'online') return;
    }
    throw new Error(`The car didn't wake up within ${timeoutSeconds}s (state: ${vehicle.state})`);
}

/** The car's charge schedules: [{ id, name, days_of_week, start_time, end_time, enabled, one_time, latitude, longitude, ... }] */
export async function chargeSchedules(accessToken, vin) {
    const data = await fleet(accessToken, `/api/1/vehicles/${vin}/vehicle_data?endpoints=charge_schedule_data`);
    return data.charge_schedule_data?.charge_schedules ?? [];
}

/** 780 → "13:00" */
export function formatMinutes(minutes) {
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
