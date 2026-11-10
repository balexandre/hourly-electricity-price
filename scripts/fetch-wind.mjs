// Fetches the hourly wind forecast for the next days from Open-Meteo and writes data/wind.json for the web page.
// Wind is what moves Danish prices most: windy days are cheap, calm days expensive.
//
//   node scripts/fetch-wind.mjs           fetch, unless the forecast in the file is still fresh
//   node scripts/fetch-wind.mjs --force   fetch anyway
import fs from 'node:fs';

const API_URL = 'https://api.open-meteo.com/v1/forecast';
// Prices are for DK2 (east Denmark)
const LOCATION = { name: 'Copenhagen', latitude: 55.68, longitude: 12.57 };
// The page shows 10 days; one spare keeps it at 10 when the next update comes after midnight
const FORECAST_DAYS = 11;

// Average wind over the day (m/s, 10 m up): below `low` is red, below `high` is yellow, otherwise green.
// From Oct-Nov 2026: days averaging 6+ m/s had green prices, days under 3.5 m/s mostly red.
const THRESHOLDS = { low: 3.5, high: 6 };

// Both the car run and the prices run fetch, but their retries (30 minutes apart) find it fresh and skip it.
// So the forecast is committed about twice a day, not on every try.
const MAX_AGE_HOURS = 4;

const OUTPUT_FILE = 'data/wind.json';

function getTier(average) {
    if (average < THRESHOLDS.low) return 'red';
    if (average < THRESHOLDS.high) return 'yellow';
    return 'green';
}

const round = (n) => Math.round(n * 10) / 10;

const previous = fs.existsSync(OUTPUT_FILE) ? JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8')) : null;
const ageHours = previous ? (Date.now() - Date.parse(previous.updatedAt)) / 3_600_000 : Infinity;
const sameSettings = JSON.stringify(previous?.thresholds) === JSON.stringify(THRESHOLDS)
    && previous?.location.latitude === LOCATION.latitude && previous?.location.longitude === LOCATION.longitude;
if (ageHours < MAX_AGE_HOURS && sameSettings && !process.argv.includes('--force')) {
    console.log(`Wind forecast is ${ageHours.toFixed(1)}h old, nothing to fetch.`);
    process.exit(0);
}

const params = new URLSearchParams({
    latitude: LOCATION.latitude,
    longitude: LOCATION.longitude,
    hourly: 'wind_speed_10m,wind_gusts_10m,wind_direction_10m',
    daily: 'wind_direction_10m_dominant',
    wind_speed_unit: 'ms',
    timezone: 'Europe/Copenhagen',
    forecast_days: FORECAST_DAYS
});

const response = await fetch(`${API_URL}?${params}`);
if (!response.ok) {
    throw new Error(`Open-Meteo responded ${response.status}: ${await response.text()}`);
}
const body = await response.json();
const { hourly, daily } = body;

if (!hourly?.time || hourly.time.length < 24 * FORECAST_DAYS) {
    throw new Error(`Open-Meteo returned ${hourly?.time?.length ?? 0} hours, expected ${24 * FORECAST_DAYS}`);
}

// Times are Copenhagen local ("2026-11-10T14:00"). Direction is where the wind comes from, in degrees (0 = north).
const hours = hourly.time.map((time, i) => ({
    time,
    speed: hourly.wind_speed_10m[i],
    gust: hourly.wind_gusts_10m[i],
    from: hourly.wind_direction_10m[i]
}));

const days = daily.time.map((date, i) => {
    const dayHours = hours.filter(h => h.time.startsWith(date));
    const speeds = dayHours.map(h => h.speed);
    const average = speeds.reduce((sum, s) => sum + s, 0) / speeds.length;
    return {
        date,
        min: round(Math.min(...speeds)),
        max: round(Math.max(...speeds)),
        average: round(average),
        gust: round(Math.max(...dayHours.map(h => h.gust))),
        from: daily.wind_direction_10m_dominant[i],
        tier: getTier(average)
    };
});

const data = {
    updatedAt: new Date().toISOString(),
    source: 'Open-Meteo',
    location: LOCATION,
    unit: 'm/s',
    thresholds: THRESHOLDS,
    days,
    hours
};

// One day or hour per line, so the file stays readable
const json = JSON.stringify(data, null, 2)
    .replace(/\{\n\s+([^{}]*?)\n\s*\}/g, (_, fields) => `{ ${fields.split(/,\n\s+/).join(', ')} }`);

fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(OUTPUT_FILE, json + '\n');
console.log(`Wrote ${OUTPUT_FILE}: ${days[0].date} to ${days.at(-1).date}, ${days.map(d => d.tier[0].toUpperCase()).join('')}`);
