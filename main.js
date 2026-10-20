// Written by scripts/fetch-prices.mjs (GitHub Action, several times a day)
const PRICES_URL = './data/prices.json';
// Blue so charging hours never look like a price warning, same as in the notifications
const CAR_EMOJI = '🚙';

const TIER_COLORS = {
    green: '#22c55e',
    yellow: '#eab308',
    red: '#ef4444'
};

const TIER_LABELS = {
    green: 'Cheap',
    yellow: 'Moderate',
    red: 'Expensive'
};

// Hours that have already passed are drawn at this opacity (hex alpha, ~30%)
const PAST_ALPHA = '4D';

/**
 * Fetch a data file, revalidating so a cached copy from yesterday isn't shown
 */
async function loadJson(url) {
    try {
        const response = await fetch(url, { cache: 'no-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        console.error(`Error loading ${url}:`, error);
        return null;
    }
}

/**
 * Hours the car charges on this date (planned in prices.json): always the night window, the afternoon only when it's cheaper
 * @returns {Set<number>}
 */
function chargingHours(charging, date) {
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
 * The "Car charges 02:00–06:00" line under a chart
 * @param {string} containerId
 * @param {Set<number>} charging
 */
function showCharging(containerId, charging) {
    if (charging.size === 0) return;
    const ranges = [];
    for (const hour of [...charging].sort((a, b) => a - b)) {
        const last = ranges.at(-1);
        if (last && last.end === hour) last.end = hour + 1;
        else ranges.push({ start: hour, end: hour + 1 });
    }
    const el = document.querySelector(`#${containerId} .charging`);
    el.innerText = `${CAR_EMOJI} Car charges ${ranges.map(r => `${pad(r.start)}:00–${pad(r.end)}:00`).join(' and ')}`;
    el.hidden = false;
}

/**
 * Today's date ("2026-10-17", matching the dates in prices.json) and the current hour, in Copenhagen
 */
function copenhagenNow() {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date());
    const get = (type) => parts.find(p => p.type === type).value;
    return {
        date: `${get('year')}-${get('month')}-${get('day')}`,
        hour: Number(get('hour'))
    };
}

function pad(n) {
    return String(n).padStart(2, '0');
}

/**
 * "2026-10-17" + 1 → "2026-10-18"
 */
function addDays(date, days) {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

/**
 * Show a message in place of the chart
 * @param {string} containerId
 * @param {string} dateLabel
 * @param {string} message
 * @param {string} className "info-message" or "error-message"
 */
function showMessage(containerId, dateLabel, message, className = 'info-message') {
    const section = document.getElementById(containerId);
    section.querySelector('.current-date').innerText = dateLabel;
    section.querySelector('.loading').innerHTML = `<p class="${className}">${message}</p>`;
}

/**
 * Render chart, or a message when there are no prices for that day
 * @param {string} containerId
 * @param {string} dateLabel
 * @param {{ hour: number, price: number, tier: string }[]} hours
 * @param {{ low: number, high: number }} thresholds
 * @param {number} maxY
 * @param {string} emptyMessage
 * @param {number} currentIndex index of the current hour, or -1 when the chart isn't today's
 * @param {Set<number>} charging hours the car charges, marked with a car above the bar
 */
function renderChart(containerId, dateLabel, hours, thresholds, maxY, emptyMessage, currentIndex = -1, charging = new Set()) {
    if (hours.length === 0) {
        showMessage(containerId, dateLabel, emptyMessage);
        return;
    }

    const section = document.getElementById(containerId);
    const dateEl = section.querySelector('.current-date');
    const loadingEl = section.querySelector('.loading');
    const chartWrapper = section.querySelector('.chart-wrapper');
    const canvas = section.querySelector('canvas');

    dateEl.innerText = dateLabel;

    const labels = hours.map(h => h.hour.toString().padStart(2, '0') + 'h');
    const values = hours.map(h => h.price);
    const isPast = (index) => index < currentIndex;
    const isNow = (index) => index === currentIndex;
    const backgroundColors = hours.map((h, i) => TIER_COLORS[h.tier] + (isPast(i) ? PAST_ALPHA : ''));

    loadingEl.style.display = 'none';
    chartWrapper.style.display = 'block';

    new Chart(canvas.getContext('2d'), {
        plugins: [{
            id: 'barLabels',
            afterDatasetsDraw(chart) {
                const { ctx, data } = chart;
                ctx.save();
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.font = 'bold 12px Inter';

                chart.getDatasetMeta(0).data.forEach((bar, index) => {
                    const value = data.datasets[0].data[index];
                    if (value === null || value === undefined) return;

                    ctx.fillStyle = isPast(index) ? 'rgba(255, 255, 255, 0.4)' : 'rgba(255, 255, 255, 0.9)';

                    const formattedValue = value.toFixed(1);
                    const { x, y, base } = bar;
                    const height = base - y;

                    if (charging.has(hours[index].hour)) {
                        ctx.save();
                        ctx.globalAlpha = isPast(index) ? 0.4 : 1;
                        ctx.font = '12px sans-serif';
                        ctx.fillText(CAR_EMOJI, x, y - 12);
                        ctx.restore();
                    }

                    // Only draw if bar is tall enough
                    if (height > 40) {
                        ctx.save();
                        // Position near the top of the bar (15px padding)
                        ctx.translate(x, y + 20);
                        ctx.rotate(-Math.PI / 2);
                        ctx.fillText(formattedValue, 0, 0);
                        ctx.restore();
                    }
                });
                ctx.restore();
            }
        }],
        data: {
            labels: labels,
            datasets: [
                {
                    type: 'bar',
                    label: 'Price per kWh',
                    data: values,
                    backgroundColor: backgroundColors,
                    // Outline the current hour
                    borderColor: hours.map((h, i) => isNow(i) ? '#f8fafc' : 'transparent'),
                    borderWidth: hours.map((h, i) => isNow(i) ? 2 : 0),
                    borderRadius: 8,
                    borderSkipped: false,
                    order: 1
                },
                {
                    type: 'line',
                    label: `Threshold ${thresholds.low}`,
                    data: Array(labels.length).fill(thresholds.low),
                    borderColor: TIER_COLORS.green,
                    borderWidth: 2,
                    borderDash: [5, 5],
                    pointRadius: 0,
                    fill: false,
                    order: 2
                },
                {
                    type: 'line',
                    label: `Threshold ${thresholds.high}`,
                    data: Array(labels.length).fill(thresholds.high),
                    borderColor: TIER_COLORS.yellow,
                    borderWidth: 2,
                    borderDash: [5, 5],
                    pointRadius: 0,
                    fill: false,
                    order: 2
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            // Room for the car above the tallest bar
            layout: { padding: { top: charging.size > 0 ? 20 : 0 } },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (context) => {
                            if (context.dataset.type === 'line') return null;
                            return ` ${context.parsed.y.toFixed(2)} DKK/kWh`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    max: maxY,
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#94a3b8' }
                },
                x: {
                    grid: { display: false },
                    ticks: {
                        // tick.value is the bar index (labels may be skipped on narrow screens)
                        color: (ctx) => isNow(ctx.tick.value) ? '#f8fafc' : '#94a3b8',
                        font: (ctx) => ({ weight: isNow(ctx.tick.value) ? 'bold' : 'normal' })
                    }
                }
            }
        }
    });
}

/**
 * Fill the "Now" block above today's chart: current price, its level, and what's coming up
 * @param {{ hour: number, price: number, tier: string }[]} hours
 * @param {number} currentIndex
 */
function showNow(hours, currentIndex) {
    const current = hours[currentIndex];
    const el = document.querySelector('#today-section .now');

    el.querySelector('.now-label').innerText = `Now, ${pad(current.hour)}:00–${pad(current.hour + 1)}:00`;
    el.querySelector('.now-price').innerText = current.price.toFixed(2);

    const tierEl = el.querySelector('.now-tier');
    tierEl.dataset.tier = current.tier;
    tierEl.innerText = TIER_LABELS[current.tier];

    el.querySelector('.now-hint').innerText = upcomingHint(hours.slice(currentIndex));
    el.hidden = false;
}

/**
 * "Cheaper from 21:00" while it's expensive, otherwise when the next expensive period is
 * @param {{ hour: number, tier: string }[]} hours the current hour and the rest of the day
 */
function upcomingHint(hours) {
    if (hours[0].tier === 'red') {
        const cheaper = hours.find(h => h.tier !== 'red');
        return cheaper ? `Cheaper from ${pad(cheaper.hour)}:00` : 'Expensive for the rest of the day';
    }

    const start = hours.findIndex(h => h.tier === 'red');
    if (start === -1) return 'No expensive hours left today';

    const end = hours.slice(start).find(h => h.tier !== 'red');
    return `Expensive ${pad(hours[start].hour)}:00–${end ? pad(end.hour) : '24'}:00`;
}

/**
 * Format date to "Thursday, Feb 12th, 2026"
 * @param {Date} date
 */
function formatDate(date) {
    const weekday = date.toLocaleString('en-US', { weekday: 'long' });
    const day = date.getDate();
    const month = date.toLocaleString('en-US', { month: 'short' });
    const year = date.getFullYear();

    const getOrdinal = (n) => {
        const s = ["th", "st", "nd", "rd"];
        const v = n % 100;
        return n + (s[(v - 20) % 10] || s[v] || s[0]);
    };

    return `${weekday}, ${month} ${getOrdinal(day)}, ${year}`;
}

(async () => {
    const now = copenhagenNow();
    const today = now.date;
    const tomorrow = addDays(today, 1);
    const todayLabel = `Prices for Today\n${formatDate(new Date(`${today}T12:00:00`))}`;
    const tomorrowLabel = `Prices for Tomorrow\n${formatDate(new Date(`${tomorrow}T12:00:00`))}`;

    const data = await loadJson(PRICES_URL);

    if (!data) {
        showMessage('today-section', todayLabel, 'Could not load price data.', 'error-message');
        showMessage('tomorrow-section', tomorrowLabel, 'Could not load price data.', 'error-message');
        return;
    }

    // Look days up by date, not by key: after midnight, the file's "tomorrow" is our today
    const hoursFor = (date) => [data.today, data.tomorrow].find(d => d?.date === date)?.hours ?? [];
    const todayHours = hoursFor(today);
    const tomorrowHours = hoursFor(tomorrow);

    // Shared Y scale for both charts, always tall enough to show the thresholds
    const maxPrice = Math.max(data.thresholds.high, ...todayHours.map(h => h.price), ...tomorrowHours.map(h => h.price));
    const maxY = Math.ceil(maxPrice * 1.1 * 10) / 10; // 10% buffer, rounded up to 1 decimal

    const currentIndex = todayHours.findIndex(h => h.hour === now.hour);
    const todayCharging = chargingHours(data.charging, today);
    const tomorrowCharging = tomorrowHours.length > 0 ? chargingHours(data.charging, tomorrow) : new Set();
    renderChart('today-section', todayLabel, todayHours, data.thresholds, maxY,
        "Today's prices aren't available yet.", currentIndex, todayCharging);
    if (currentIndex >= 0) showNow(todayHours, currentIndex);
    if (todayHours.length > 0) showCharging('today-section', todayCharging);
    renderChart('tomorrow-section', tomorrowLabel, tomorrowHours, data.thresholds, maxY,
        "Tomorrow's prices are usually published around 13:00.", -1, tomorrowCharging);
    showCharging('tomorrow-section', tomorrowCharging);

    const updated = new Date(data.updatedAt).toLocaleString('en-GB', {
        timeZone: 'Europe/Copenhagen', weekday: 'short', hour: '2-digit', minute: '2-digit'
    });
    document.getElementById('updated').innerText = `Updated ${updated}`;
})();

// Keep the page current: reload just after every full hour, so the "now" marker moves on while the
// page stays open, and when an installed app comes back after 10+ minutes in the background
// (it never shows yesterday as today or misses tomorrow's prices).
const loadedAt = Date.now();
const HOUR = 60 * 60 * 1000;
setTimeout(() => location.reload(), HOUR - (loadedAt % HOUR) + 5000);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - loadedAt > 10 * 60 * 1000) {
        location.reload();
    }
});
