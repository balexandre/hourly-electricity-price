// Prices follow Danish local time, whatever timezone the script runs in (GitHub runners use UTC)
const TIME_ZONE = 'Europe/Copenhagen';

/** Current date ("2026-10-17") and hour (0-23) in Copenhagen */
export function copenhagenNow() {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(new Date());
    const get = (type) => parts.find(p => p.type === type).value;

    return {
        date: `${get('year')}-${get('month')}-${get('day')}`,
        hour: Number(get('hour'))
    };
}

/** "2026-10-17" + 1 → "2026-10-18" */
export function addDays(date, days) {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}
