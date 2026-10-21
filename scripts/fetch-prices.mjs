// Fetches today's and tomorrow's hourly prices from stromligning.dk and writes data/prices.json,
// which is what the web page, the notifier and the Tesla step read. It also holds the car's charging plan.
//
//   node scripts/fetch-prices.mjs           fetch, unless tomorrow's prices are already in the file
//   node scripts/fetch-prices.mjs --force   fetch anyway
import fs from 'node:fs';
import { copenhagenNow, addDays } from './time.mjs';
import { planCharging } from './charging.mjs';

const API_BASE = 'https://stromligning.dk/api/prices';
const PRODUCT_ID = 'andel_energi_timeenergi';
const SUPPLIER_ID = 'cerius_c';
const CUSTOMER_GROUP_ID = 'c';

// Total price per kWh (electricity + tariffs + VAT): below `low` is green, below `high` is yellow, otherwise red
const THRESHOLDS = { low: 2.1, high: 3.2 };

const OUTPUT_FILE = 'data/prices.json';

function getTier(price) {
    if (price < THRESHOLDS.low) return 'green';
    if (price < THRESHOLDS.high) return 'yellow';
    return 'red';
}

const now = copenhagenNow();
const today = now.date;
const tomorrow = addDays(today, 1);

const previous = fs.existsSync(OUTPUT_FILE) ? JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8')) : null;

// Published prices don't change, so once tomorrow's are in, the day's retries have nothing left to fetch
const haveTomorrow = previous?.today.date === today && previous.tomorrow.date === tomorrow
    && previous.tomorrow.hours.length >= 23
    && JSON.stringify(previous.thresholds) === JSON.stringify(THRESHOLDS);
if (haveTomorrow && !process.argv.includes('--force')) {
    console.log(`Already have tomorrow's prices (${tomorrow}), nothing to fetch.`);
    process.exit(0);
}

// One request for both days; tomorrow is simply missing from the response until it's published (~13:00)
const params = new URLSearchParams({
    from: `${today}T00:00:00`,
    to: `${tomorrow}T23:59:59`,
    productId: PRODUCT_ID,
    supplierId: SUPPLIER_ID,
    customerGroupId: CUSTOMER_GROUP_ID,
    aggregation: '1h'
});

const response = await fetch(`${API_BASE}?${params}`);
if (!response.ok) {
    throw new Error(`stromligning.dk responded ${response.status}: ${await response.text()}`);
}
const body = await response.json();

/** @param {string} date "2026-10-17" */
function hoursFor(date) {
    return body.prices
        .filter(p => p.localDate.startsWith(date))
        .map(p => {
            const price = Math.round(p.price.total * 10000) / 10000;
            return {
                hour: Number(p.localDate.slice(11, 13)),
                price,
                tier: getTier(price)
            };
        });
}

const data = {
    updatedAt: new Date().toISOString(),
    product: `${body.company.name} ${body.company.product.name}`,
    priceArea: body.priceArea,
    unit: 'DKK/kWh',
    thresholds: THRESHOLDS,
    today: { date: today, hours: hoursFor(today) },
    tomorrow: { date: tomorrow, hours: hoursFor(tomorrow) }
};

if (data.today.hours.length === 0) {
    throw new Error(`No prices returned for today (${today})`);
}

data.charging = planCharging(data, previous, now);

// Leave the file alone when only the timestamp would change, so the workflow doesn't commit noise
const withoutTimestamp = (d) => JSON.stringify({ ...d, updatedAt: null });

if (previous && withoutTimestamp(previous) === withoutTimestamp(data)) {
    console.log('Prices unchanged, nothing to write.');
} else {
    fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2) + '\n');
    console.log(`Wrote ${OUTPUT_FILE}: today ${today} (${data.today.hours.length}h), tomorrow ${tomorrow} (${data.tomorrow.hours.length}h)`);
}
