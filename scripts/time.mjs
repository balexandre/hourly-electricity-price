// Prices follow Danish local time, whatever timezone the script runs in (GitHub runners use UTC)
const TIME_ZONE = 'Europe/Copenhagen';

/** Current date ("2026-10-17"), hour (0-23) and minute in Copenhagen */
export function copenhagenNow() {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(new Date());
    const get = (type) => parts.find(p => p.type === type).value;

    return {
        date: `${get('year')}-${get('month')}-${get('day')}`,
        hour: Number(get('hour')),
        minute: Number(get('minute'))
    };
}

/** "2026-10-17" + 1 → "2026-10-18" */
export function addDays(date, days) {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

/** "2026-10-22", 15 → the moment it's 15:00 that day in Copenhagen, as a timestamp (ms) */
export function copenhagenTimestamp(date, hour) {
    const asUtc = Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
    // Twice, so a first guess on the other side of a clock change still lands on the right offset
    let timestamp = asUtc;
    for (let i = 0; i < 2; i++) {
        timestamp = asUtc - offsetMinutes(timestamp) * 60 * 1000;
    }
    return timestamp;
}

/** How far Copenhagen is ahead of UTC at that moment, in minutes (60 in winter, 120 in summer) */
function offsetMinutes(timestamp) {
    const name = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, timeZoneName: 'longOffset' })
        .formatToParts(timestamp)
        .find(p => p.type === 'timeZoneName').value;
    // "GMT+02:00", or just "GMT" when there's no offset
    const match = name.match(/([+-])(\d{2}):(\d{2})/);
    if (!match) return 0;
    return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}
