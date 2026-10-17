// Sends the family a push notification (via ntfy) with an overview of the day's prices.
//
//   node scripts/notify.mjs             send whatever is due (this is what the workflow runs)
//   node scripts/notify.mjs today       send today's overview right now
//   node scripts/notify.mjs tomorrow    send tomorrow's overview right now
//   add --dry-run to print the message instead of sending it
//
// Needs NTFY_TOPIC: the topic name, or the full topic URL (e.g. https://ntfy.sh/my-topic).
import fs from 'node:fs';
import { copenhagenNow, addDays } from './time.mjs';

const PRICES_FILE = 'data/prices.json';
// Remembers the last date each notification went out, so retries and late cron runs don't send twice
const SENT_FILE = 'data/notified.json';
const SITE_URL = 'https://balexandre.github.io/hourly-electricity-price/';

// Today's overview goes out on the first run in this window (Copenhagen time)
const MORNING = { from: 7, until: 12 };
// Length of the "cheapest block" suggestion, roughly a dishwasher or washing machine cycle
const BLOCK_HOURS = 3;

const TIER_EMOJI = { green: '🟢', yellow: '🟡', red: '🔴' };

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const mode = args.find(a => !a.startsWith('--')) ?? 'auto';
if (!['auto', 'today', 'tomorrow'].includes(mode)) {
    throw new Error(`Unknown option "${mode}", expected today, tomorrow or nothing`);
}

const data = JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8'));
const sent = fs.existsSync(SENT_FILE) ? JSON.parse(fs.readFileSync(SENT_FILE, 'utf8')) : {};
const now = copenhagenNow();
const dates = { today: now.date, tomorrow: addDays(now.date, 1) };

// Days are looked up by date, not by key, so a file fetched yesterday afternoon still works this morning
const findDay = (date) => [data.today, data.tomorrow].find(d => d?.date === date && d.hours.length > 0);

const isDue = {
    today: now.hour >= MORNING.from && now.hour < MORNING.until && sent.today !== dates.today,
    tomorrow: sent.tomorrow !== dates.tomorrow
};

const pending = mode === 'auto'
    ? ['today', 'tomorrow'].filter(which => isDue[which] && findDay(dates[which]))
    : [mode];

if (pending.length === 0) {
    console.log('No notification due.');
}

for (const which of pending) {
    const day = findDay(dates[which]);
    if (!day) throw new Error(`No prices for ${which} (${dates[which]}) yet`);

    // This morning's message only talks about the hours still ahead
    const notification = compose(which, day, which === 'today' ? now.hour : 0);

    if (dryRun) {
        console.log(`--- ${notification.title} ---\n${notification.message}\n`);
        continue;
    }

    await send(notification);
    sent[which] = day.date;
    fs.writeFileSync(SENT_FILE, JSON.stringify(sent, null, 2) + '\n');
    console.log(`Sent ${which}'s overview (${day.date}).`);
}

function compose(which, day, fromHour) {
    const upcoming = day.hours.filter(h => h.hour >= fromHour);
    const lines = [];

    const peaks = toRanges(upcoming.filter(h => h.tier === 'red'));
    if (peaks.length > 0) {
        const highest = Math.max(...upcoming.filter(h => h.tier === 'red').map(h => h.price));
        lines.push(`🔴 Avoid ${peaks.join(', ')} · up to ${highest.toFixed(2)} kr`);
    } else {
        lines.push(fromHour > 0 ? '🎉 No expensive hours left today' : '🎉 No expensive hours');
    }

    const cheapest = cheapestBlock(upcoming, BLOCK_HOURS);
    if (cheapest) {
        lines.push(`✅ Cheapest ${BLOCK_HOURS}h: ${cheapest.range} · avg ${cheapest.average.toFixed(2)} kr`);
    }

    // Whole day as two rows of colored dots, each row labelled with its first hour
    const half = Math.ceil(day.hours.length / 2);
    lines.push('');
    for (const row of [day.hours.slice(0, half), day.hours.slice(half)]) {
        lines.push(`${pad(row[0].hour)} ${row.map(h => TIER_EMOJI[h.tier]).join('')}`);
    }

    const weekday = new Date(`${day.date}T12:00:00Z`).toLocaleDateString('en-GB', {
        weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC'
    });
    const title = `${which === 'today' ? "Today's" : "Tomorrow's"} prices · ${weekday}`;

    return { title, message: lines.join('\n') };
}

/** Consecutive hours → ["17:00–21:00", ...] */
function toRanges(hours) {
    const ranges = [];
    for (const { hour } of hours) {
        const last = ranges.at(-1);
        if (last && last.end === hour) last.end = hour + 1;
        else ranges.push({ start: hour, end: hour + 1 });
    }
    return ranges.map(r => `${pad(r.start)}:00–${pad(r.end)}:00`);
}

/** The run of `size` consecutive hours with the lowest average price */
function cheapestBlock(hours, size) {
    let best = null;
    for (let i = 0; i + size <= hours.length; i++) {
        const block = hours.slice(i, i + size);
        const average = block.reduce((sum, h) => sum + h.price, 0) / size;
        if (!best || average < best.average) {
            best = { range: `${pad(block[0].hour)}:00–${pad(block.at(-1).hour + 1)}:00`, average };
        }
    }
    return best;
}

function pad(n) {
    return String(n).padStart(2, '0');
}

async function send({ title, message }) {
    if (!process.env.NTFY_TOPIC) throw new Error('NTFY_TOPIC is not set');

    // Accept either "my-topic" or "https://ntfy.sh/my-topic"
    const url = new URL(process.env.NTFY_TOPIC, 'https://ntfy.sh/');

    // JSON publishing: unlike ntfy's header-based API, it handles emoji in the title
    const response = await fetch(url.origin, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            topic: url.pathname.slice(1),
            title,
            message,
            tags: ['zap'],
            click: SITE_URL
        })
    });

    if (!response.ok) {
        throw new Error(`ntfy responded ${response.status}: ${await response.text()}`);
    }
}
