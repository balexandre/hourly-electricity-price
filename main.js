// Written by scripts/fetch-prices.mjs (GitHub Action, several times a day)
const PRICES_URL = './data/prices.json';

const TIER_COLORS = {
    green: '#22c55e',
    yellow: '#eab308',
    red: '#ef4444'
};

/**
 * Fetch prices.json, revalidating so a cached copy from yesterday isn't shown
 */
async function loadPrices() {
    try {
        const response = await fetch(PRICES_URL, { cache: 'no-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        console.error('Error loading prices:', error);
        return null;
    }
}

/**
 * Today's date in Copenhagen as "2026-10-17", matching the dates in prices.json
 */
function copenhagenToday() {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const get = (type) => parts.find(p => p.type === type).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
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
 */
function renderChart(containerId, dateLabel, hours, thresholds, maxY, emptyMessage) {
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
    const backgroundColors = hours.map(h => TIER_COLORS[h.tier]);

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
                ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';

                chart.getDatasetMeta(0).data.forEach((bar, index) => {
                    const value = data.datasets[0].data[index];
                    if (value === null || value === undefined) return;

                    const formattedValue = value.toFixed(1);
                    const { x, y, base } = bar;
                    const height = base - y;

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
                    ticks: { color: '#94a3b8' }
                }
            }
        }
    });
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
    const today = copenhagenToday();
    const tomorrow = addDays(today, 1);
    const todayLabel = `Prices for Today\n${formatDate(new Date(`${today}T12:00:00`))}`;
    const tomorrowLabel = `Prices for Tomorrow\n${formatDate(new Date(`${tomorrow}T12:00:00`))}`;

    const data = await loadPrices();

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

    renderChart('today-section', todayLabel, todayHours, data.thresholds, maxY,
        "Today's prices aren't available yet.");
    renderChart('tomorrow-section', tomorrowLabel, tomorrowHours, data.thresholds, maxY,
        "Tomorrow's prices are usually published around 13:00.");

    const updated = new Date(data.updatedAt).toLocaleString('en-GB', {
        timeZone: 'Europe/Copenhagen', weekday: 'short', hour: '2-digit', minute: '2-digit'
    });
    document.getElementById('updated').innerText = `Updated ${updated}`;
})();
