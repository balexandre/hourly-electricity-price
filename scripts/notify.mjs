// Sends the family push notifications (via ntfy) about electricity prices. Once tomorrow's prices are out,
// one run hands ntfy everything for the next day, and ntfy holds each message until it's due:
//   - tomorrow's overview at 15:00 (silent)
//   - a reminder an hour before each expensive period (buzzes)
//
//   node scripts/notify.mjs             schedule whatever isn't scheduled yet (this is what the workflow runs)
//   node scripts/notify.mjs tomorrow    send tomorrow's overview right now
//   node scripts/notify.mjs reminder    send the reminder for the next expensive period today right now
//   add --dry-run to print the messages and when they'd arrive instead of sending them
//
// Needs NTFY_TOPIC: the topic name, or the full topic URL (e.g. https://ntfy.sh/my-topic).
import fs from 'node:fs';
import { copenhagenNow, copenhagenTimestamp, addDays } from './time.mjs';

const PRICES_FILE = 'data/prices.json';
// Remembers what was last scheduled, so repeated runs never send the same thing twice
const SENT_FILE = 'data/notified.json';
const SITE_URL = 'https://balexandre.github.io/hourly-electricity-price/';

// Tomorrow's overview arrives at this hour, or straight away if the prices came out later
const OVERVIEW_HOUR = 15;
// Reminders arrive this long before an expensive period starts, but never at night
const REMINDER_LEAD_HOURS = 1;
const AWAKE = { from: 7, until: 22 };
// Length of the "cheapest block" suggestion, roughly a dishwasher or washing machine cycle
const BLOCK_HOURS = 3;

// ntfy priorities: 2 = low (no sound or vibration), 4 = high (sound, vibration and pop-up)
const QUIET = 2;
const LOUD = 4;

const TIER_EMOJI = { green: '🟢', yellow: '🟡', red: '🔴' };
// Blue so charging hours never look like a price warning
const CAR_EMOJI = '🚙';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const mode = args.find(a => !a.startsWith('--')) ?? 'auto';
if (!['auto', 'tomorrow', 'reminder'].includes(mode)) {
    throw new Error(`Unknown option "${mode}", expected tomorrow, reminder or nothing`);
}

const data = JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8'));
const sent = fs.existsSync(SENT_FILE) ? JSON.parse(fs.readFileSync(SENT_FILE, 'utf8')) : {};
// The car's charge windows and today's afternoon decision, planned by fetch-prices.mjs
const charging = data.charging;
const now = copenhagenNow();

// Days are looked up by date, not by key, so a file fetched yesterday afternoon still works this morning
const findDay = (date) => [data.today, data.tomorrow].find(d => d?.date === date && d.hours.length > 0);
const today = findDay(now.date);
const tomorrow = findDay(addDays(now.date, 1));

const pending = mode === 'auto' ? due() : [manual(mode)];

if (pending.length === 0) {
    console.log('Nothing to schedule.');
}

for (const { notification, at, sentAs } of pending) {
    const when = at > Date.now() ? `at ${describeTime(at)}` : 'now';

    if (dryRun) {
        console.log(`--- [priority ${notification.priority}, ${when}] ${notification.title} ---\n${notification.message}\n`);
        continue;
    }

    await send(notification, at);
    // Only ever moves forward, so a manual send never makes the next run repeat what's already scheduled
    const [key, value] = sentAs;
    if (!sent[key] || value > sent[key]) sent[key] = value;
    fs.writeFileSync(SENT_FILE, JSON.stringify(sent, null, 2) + '\n');
    console.log(`Sent ${notification.title} (${when}).`);
}

/**
 * Everything not handed to ntfy yet: tomorrow's overview, plus a reminder for each expensive period
 * still ahead. Today's are normally scheduled the day before; they're only picked up here after a missed day.
 */
function due() {
    const messages = [];

    if (tomorrow && sent.tomorrow !== tomorrow.date) {
        messages.push({
            notification: overview(tomorrow),
            at: copenhagenTimestamp(now.date, OVERVIEW_HOUR),
            sentAs: ['tomorrow', tomorrow.date]
        });
    }

    for (const day of [today, tomorrow].filter(Boolean)) {
        for (const peak of findPeaks(day.hours)) {
            // "2026-10-22T17" sorts by time, so everything up to the last one sent is done
            const key = `${day.date}T${pad(peak.start)}`;
            if (sent.reminder && key <= sent.reminder) continue;

            const hour = reminderHour(peak);
            // Over before anyone's up, or already over today
            if (hour === null || (day === today && peak.end <= now.hour)) continue;
            // Its time has passed, so it would go out right away: not once everyone's in bed
            if (day === today && hour <= now.hour && now.hour >= AWAKE.until) continue;

            messages.push({
                notification: reminder(day, peak, Math.max(hour, day === today ? now.hour : 0)),
                at: copenhagenTimestamp(day.date, hour),
                sentAs: ['reminder', key]
            });
        }
    }

    return messages;
}

/** A message asked for by name, sent right away */
function manual(kind) {
    if (kind === 'tomorrow') {
        if (!tomorrow) throw new Error('No prices for tomorrow yet');
        return { notification: overview(tomorrow), at: 0, sentAs: ['tomorrow', tomorrow.date] };
    }

    const nextPeak = today && findPeaks(today.hours).find(p => p.end > now.hour);
    if (!nextPeak) throw new Error('No expensive hours left today');
    return {
        notification: reminder(today, nextPeak, now.hour),
        at: 0,
        sentAs: ['reminder', `${today.date}T${pad(nextPeak.start)}`]
    };
}

/** The hour a period's reminder arrives: the lead time before it, moved into waking hours, or null if it's over by then */
function reminderHour(peak) {
    const hour = Math.min(Math.max(peak.start - REMINDER_LEAD_HOURS, AWAKE.from), AWAKE.until - 1);
    return hour < peak.end ? hour : null;
}

function overview(day) {
    const lines = [];

    const peaks = findPeaks(day.hours);
    if (peaks.length > 0) {
        const highest = Math.max(...peaks.flatMap(p => p.hours).map(h => h.price));
        lines.push(`🔴 Avoid ${peaks.map(formatRange).join(', ')} · up to ${highest.toFixed(2)} kr`);
    } else {
        lines.push('🎉 No expensive hours');
    }

    const cheapest = cheapestBlock(day.hours, BLOCK_HOURS);
    if (cheapest) {
        lines.push(`✅ Cheapest ${BLOCK_HOURS}h: ${formatRange(cheapest)} · avg ${cheapest.average.toFixed(2)} kr`);
    }

    const car = carLine(day);
    if (car) lines.push(car);

    // Whole day as two rows of colored dots, each row labelled with its first hour; the car marks charging hours
    const carHours = chargingHours(day.date);
    const half = Math.ceil(day.hours.length / 2);
    lines.push('');
    for (const row of [day.hours.slice(0, half), day.hours.slice(half)]) {
        lines.push(`${pad(row[0].hour)} ${row.map(h => carHours.has(h.hour) ? CAR_EMOJI : TIER_EMOJI[h.tier]).join('')}`);
    }

    const weekday = new Date(`${day.date}T12:00:00Z`).toLocaleDateString('en-GB', {
        weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC'
    });

    return {
        title: `Tomorrow's prices · ${weekday}`,
        message: lines.join('\n'),
        priority: QUIET,
        tags: ['zap']
    };
}

/** @param {number} hour when it arrives, which decides whether the period is still ahead or already on */
function reminder(day, peak, hour) {
    const highest = Math.max(...peak.hours.map(h => h.price));
    const lines = [`Up to ${highest.toFixed(2)} kr/kWh. Hold off on the dishwasher, laundry and dryer.`];

    // Best time to run them instead: after the peak, through the night when the next day's prices are known
    const nextDay = day === today ? tomorrow : null;
    const later = [
        ...day.hours.filter(h => h.hour >= peak.end),
        ...(nextDay?.hours.filter(h => h.hour < AWAKE.from) ?? [])
    ];
    const cheapest = cheapestBlock(later, BLOCK_HOURS);
    if (cheapest) {
        lines.push(`✅ Cheapest after: ${formatRange(cheapest)} · avg ${cheapest.average.toFixed(2)} kr`);
    }

    return {
        title: peak.start <= hour
            ? `Expensive electricity until ${pad(peak.end)}:00`
            : `Expensive electricity ${formatRange(peak)}`,
        message: lines.join('\n'),
        priority: LOUD,
        tags: ['warning']
    };
}

/** Hours the car charges on this date: always the night window, the afternoon only when it's cheaper */
function chargingHours(date) {
    const hours = new Set();
    if (!charging) return hours;
    const windows = [charging.night];
    if (charging.decision?.date === date && charging.decision.charge) windows.push(charging.afternoon);
    for (const { from, until } of windows) {
        for (let hour = from; hour < until; hour++) hours.add(hour);
    }
    return hours;
}

/**
 * Tomorrow's prices arrive with the decision about this afternoon, so say where the car charges:
 * this afternoon if that's cheaper, otherwise tonight
 */
function carLine(tomorrowDay) {
    if (!charging) return null;
    const { night, afternoon } = charging;
    const decision = charging.decision?.date === now.date ? charging.decision : null;
    // Once the afternoon is over, a late or retried overview says tonight
    if (decision?.charge && now.hour < afternoon.until) {
        return `${CAR_EMOJI} Car charges today until ${pad(afternoon.until)}:00 · avg ${decision.afternoon.toFixed(2)} kr (tonight ${decision.night.toFixed(2)} kr)`;
    }
    const tonight = tomorrowDay.hours.filter(h => h.hour >= night.from && h.hour < night.until);
    const average = tonight.reduce((sum, h) => sum + h.price, 0) / tonight.length;
    const instead = decision ? ` (this afternoon ${decision.afternoon.toFixed(2)} kr)` : '';
    return `${CAR_EMOJI} Car charges tonight ${formatRange({ start: night.from, end: night.until })} · avg ${average.toFixed(2)} kr${instead}`;
}

/** Runs of consecutive red hours → [{ start: 17, end: 21, hours: [...] }] */
function findPeaks(hours) {
    const peaks = [];
    for (const h of hours.filter(h => h.tier === 'red')) {
        const last = peaks.at(-1);
        if (last && last.end === h.hour) {
            last.end = h.hour + 1;
            last.hours.push(h);
        } else {
            peaks.push({ start: h.hour, end: h.hour + 1, hours: [h] });
        }
    }
    return peaks;
}

/** The run of `size` consecutive hours with the lowest average price */
function cheapestBlock(hours, size) {
    let best = null;
    for (let i = 0; i + size <= hours.length; i++) {
        const block = hours.slice(i, i + size);
        const average = block.reduce((sum, h) => sum + h.price, 0) / size;
        if (!best || average < best.average) {
            best = { start: block[0].hour, end: block.at(-1).hour + 1, average };
        }
    }
    return best;
}

/** { start: 17, end: 21 } → "17:00–21:00" */
function formatRange({ start, end }) {
    return `${pad(start)}:00–${pad(end)}:00`;
}

/** 1761138000000 → "Thu 22 Oct 15:00" (Copenhagen) */
function describeTime(timestamp) {
    return new Date(timestamp).toLocaleString('en-GB', {
        weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Copenhagen'
    }).replace(',', '');
}

function pad(n) {
    return String(n).padStart(2, '0');
}

/** @param {number} at when ntfy should deliver it (ms); anything not clearly in the future goes out now */
async function send({ title, message, priority, tags }, at) {
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
            priority,
            tags,
            click: SITE_URL,
            // ntfy holds the message until then (up to 3 days ahead) and only then pushes it to the phones
            ...(at > Date.now() + 60_000 && { delay: String(Math.floor(at / 1000)) })
        })
    });

    if (!response.ok) {
        throw new Error(`ntfy responded ${response.status}: ${await response.text()}`);
    }
}
