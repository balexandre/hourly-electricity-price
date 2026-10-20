// When the car charges: every night, plus this afternoon when that's cheaper than the night that follows.
// fetch-prices.mjs writes the plan into prices.json; tesla-charge.mjs, the notifications and the site read it.

// Copenhagen hours, matching the schedules set in the car
export const NIGHT = { from: 2, until: 6 };
export const AFTERNOON = { from: 12, until: 17 };

/**
 * The charging plan for prices.json. Today's afternoon is decided once, on the first run in the afternoon
 * window that has tomorrow's prices (they're published around 13:00), and kept for the rest of the day.
 * @param {object} data the prices.json being written
 * @param {object|null} previous the prices.json written before
 * @param {{ date: string, hour: number, minute: number }} now Copenhagen time
 */
export function planCharging(data, previous, now) {
    const plan = { night: NIGHT, afternoon: AFTERNOON, decision: null };

    const earlier = previous?.charging?.decision;
    if (earlier?.date === now.date) {
        plan.decision = earlier;
    } else if (now.hour >= AFTERNOON.from && now.hour < AFTERNOON.until) {
        // The current hour counts only for the minutes left in it
        const afternoon = average(data.today, AFTERNOON.from, AFTERNOON.until, now);
        const night = average(data.tomorrow, NIGHT.from, NIGHT.until);
        if (afternoon !== null && night !== null) {
            plan.decision = { date: now.date, charge: afternoon < night, afternoon: round(afternoon), night: round(night) };
        }
    }
    return plan;
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
