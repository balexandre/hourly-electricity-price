// Sends the family push notifications (via ntfy) about electricity prices:
//   - a reminder shortly before each expensive period (buzzes)
//   - tomorrow's overview, as soon as the prices are published (silent)
//   - today's overview in the morning, only when there are expensive hours ahead (silent)
//
//   node scripts/notify.mjs             send whatever is due (this is what the workflow runs, hourly)
//   node scripts/notify.mjs today       send today's overview right now
//   node scripts/notify.mjs tomorrow    send tomorrow's overview right now
//   node scripts/notify.mjs reminder    send the reminder for the next expensive period right now
//   add --dry-run to print the messages instead of sending them
//
// Needs NTFY_TOPIC: the topic name, or the full topic URL (e.g. https://ntfy.sh/my-topic).
import fs from 'node:fs';
import { copenhagenNow, addDays } from './time.mjs';

const PRICES_FILE = 'data/prices.json';
// Remembers what was last sent, so hourly runs never send the same thing twice
const SENT_FILE = 'data/notified.json';
const SITE_URL = 'https://balexandre.github.io/hourly-electricity-price/';

// Today's overview goes out on the first run in this window (Copenhagen time)
const MORNING = { from: 7, until: 12 };
// Reminders go out up to this long before an expensive period starts, but never at night
const REMINDER_LEAD_MINUTES = 60;
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
if (!['auto', 'today', 'tomorrow', 'reminder'].includes(mode)) {
    throw new Error(`Unknown option "${mode}", expected today, tomorrow, reminder or nothing`);
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

// The expensive period that is coming up next, or is under way right now
const nextPeak = today && findPeaks(today.hours).find(p => p.end > now.hour);
const nextPeakKey = nextPeak && `${today.date}T${pad(nextPeak.start)}`;
const minutesUntilPeak = nextPeak && (nextPeak.start - now.hour) * 60 - now.minute;

const isMorning = now.hour >= MORNING.from && now.hour < MORNING.until;
const isAwake = now.hour >= AWAKE.from && now.hour < AWAKE.until;

const isDue = {
    // Only worth a morning message when there's still something to avoid today
    today: Boolean(isMorning && nextPeak && sent.today !== today.date),
    reminder: Boolean(isAwake && nextPeak && minutesUntilPeak <= REMINDER_LEAD_MINUTES && sent.reminder !== nextPeakKey),
    tomorrow: Boolean(tomorrow && sent.tomorrow !== tomorrow.date)
};

// In this order, so the morning overview lands before a reminder sent in the same run
const pending = mode === 'auto'
    ? ['today', 'reminder', 'tomorrow'].filter(kind => isDue[kind])
    : [mode];

if (pending.length === 0) {
    console.log('No notification due.');
}

for (const kind of pending) {
    const { notification, sentAs } = prepare(kind);

    if (dryRun) {
        console.log(`--- [priority ${notification.priority}] ${notification.title} ---\n${notification.message}\n`);
        continue;
    }

    await send(notification);
    sent[kind] = sentAs;
    fs.writeFileSync(SENT_FILE, JSON.stringify(sent, null, 2) + '\n');
    console.log(`Sent ${kind} (${sentAs}).`);
}

/** Builds the notification, plus the value recorded in the sent-log once it's out */
function prepare(kind) {
    const day = kind === 'tomorrow' ? tomorrow : today;
    if (!day) throw new Error(`No prices for ${kind === 'tomorrow' ? 'tomorrow' : 'today'} yet`);

    if (kind === 'reminder') {
        if (!nextPeak) throw new Error('No expensive hours left today');
        return { notification: reminder(day, nextPeak), sentAs: nextPeakKey };
    }

    // This morning's message only talks about the hours still ahead
    return { notification: overview(kind, day, kind === 'today' ? now.hour : 0), sentAs: day.date };
}

function overview(which, day, fromHour) {
    const upcoming = day.hours.filter(h => h.hour >= fromHour);
    const lines = [];

    const peaks = findPeaks(upcoming);
    if (peaks.length > 0) {
        const highest = Math.max(...peaks.flatMap(p => p.hours).map(h => h.price));
        lines.push(`🔴 Avoid ${peaks.map(formatRange).join(', ')} · up to ${highest.toFixed(2)} kr`);
    } else {
        lines.push(fromHour > 0 ? '🎉 No expensive hours left today' : '🎉 No expensive hours');
    }

    const cheapest = cheapestBlock(upcoming, BLOCK_HOURS);
    if (cheapest) {
        lines.push(`✅ Cheapest ${BLOCK_HOURS}h: ${formatRange(cheapest)} · avg ${cheapest.average.toFixed(2)} kr`);
    }

    const car = which === 'tomorrow' && carLine(day);
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
        title: `${which === 'today' ? "Today's" : "Tomorrow's"} prices · ${weekday}`,
        message: lines.join('\n'),
        priority: QUIET,
        tags: ['zap']
    };
}

function reminder(day, peak) {
    const highest = Math.max(...peak.hours.map(h => h.price));
    const lines = [`Up to ${highest.toFixed(2)} kr/kWh. Hold off on the dishwasher, laundry and dryer.`];

    // Best time to run them instead: after the peak, through the night if tomorrow's prices are out
    const later = [
        ...day.hours.filter(h => h.hour >= peak.end),
        ...(tomorrow?.hours.filter(h => h.hour < AWAKE.from) ?? [])
    ];
    const cheapest = cheapestBlock(later, BLOCK_HOURS);
    if (cheapest) {
        lines.push(`✅ Cheapest after: ${formatRange(cheapest)} · avg ${cheapest.average.toFixed(2)} kr`);
    }

    return {
        title: peak.start <= now.hour
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

function pad(n) {
    return String(n).padStart(2, '0');
}

async function send({ title, message, priority, tags }) {
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
            click: SITE_URL
        })
    });

    if (!response.ok) {
        throw new Error(`ntfy responded ${response.status}: ${await response.text()}`);
    }
}
