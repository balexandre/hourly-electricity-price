// The wind section: now, an hourly chart and one row per day for the next 10 days, from data/wind.json
// (written by scripts/fetch-wind.mjs). Each day gets a color for how windy it is, because windy days are cheap.

const DAYS_SHOWN = 10;

// Same colors as the prices: a green day means wind, so likely green prices
const TIER_COLORS = {
    green: '#22c55e',
    yellow: '#eab308',
    red: '#ef4444'
};

const TIER_LABELS = {
    green: 'Windy, power likely cheap',
    yellow: 'Some wind',
    red: 'Little wind, power likely pricey'
};

const TIER_RANK = { red: 0, yellow: 1, green: 2 };

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const COMPASS_WORDS = { N: 'north', NE: 'northeast', E: 'east', SE: 'southeast', S: 'south', SW: 'southwest', W: 'west', NW: 'northwest' };

// Beaufort names, by the upper limit in m/s
const SCALE = [
    [1.6, 'Calm'], [3.4, 'Light breeze'], [5.5, 'Gentle breeze'], [8, 'Moderate breeze'], [10.8, 'Fresh breeze'],
    [13.9, 'Strong breeze'], [17.2, 'Near gale'], [20.8, 'Gale'], [Infinity, 'Strong gale']
];

// Chart arrows: one every 12 hours, or one a day on phones (the day rows have the detail)
const ARROW_EVERY = window.matchMedia('(max-width: 640px)').matches ? 24 : 12;
const PAST_ALPHA = 0.3;
const WIND_RGB = '56, 189, 248';
const GUST_RGB = '129, 140, 248';

const compass = (degrees) => COMPASS[Math.round(degrees / 45) % 8];
// Forecasts give where the wind comes from; the arrows point where it goes
const towards = (from) => (from + 180) % 360;
const describe = (speed) => SCALE.find(([max]) => speed < max)[1];
const pad = (n) => String(n).padStart(2, '0');

/** "2026-11-12" → "Thu" */
const weekday = (date) => new Date(`${date}T12:00:00`).toLocaleString('en-US', { weekday: 'short' });
/** "2026-11-12" → "12 Nov" */
const dayMonth = (date) => new Date(`${date}T12:00:00`).toLocaleString('en-GB', { day: 'numeric', month: 'short' });

function arrowSvg(from) {
    return `<svg class="wind-arrow" viewBox="0 0 24 24" style="transform: rotate(${towards(from)}deg)" aria-hidden="true">`
        + '<path d="M12 3l6 9h-4v9h-4v-9H6z" fill="currentColor"/></svg>';
}

/** The same arrow, drawn on a small canvas for Chart.js points */
function arrowImage(from) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 20;
    const ctx = canvas.getContext('2d');
    ctx.translate(10, 10);
    ctx.rotate(towards(from) * Math.PI / 180);
    ctx.scale(0.75, 0.75);
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath();
    for (const [x, y] of [[0, -11], [7, 0], [2.5, 0], [2.5, 11], [-2.5, 11], [-2.5, 0], [-7, 0]]) ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fill();
    return canvas;
}

function tierDot(tier) {
    return `<span class="tier-dot" data-tier="${tier}" title="${TIER_LABELS[tier]}" role="img" aria-label="${TIER_LABELS[tier]}"></span>`;
}

/**
 * "Thu 12", "Wed 18–Thu 19 and Sat 21": consecutive days joined into ranges
 * @param {{ date: string }[]} days in date order
 * @param {string[]} allDates every date shown, to tell which days are next to each other
 */
function dayRanges(days, allDates) {
    const ranges = [];
    for (const day of days) {
        const index = allDates.indexOf(day.date);
        const last = ranges.at(-1);
        if (last && last.endIndex === index - 1) {
            last.end = day.date;
            last.endIndex = index;
        } else {
            ranges.push({ start: day.date, end: day.date, endIndex: index });
        }
    }
    const label = (date) => `${weekday(date)} ${Number(date.slice(8))}`;
    const parts = ranges.map(r => r.start === r.end ? label(r.start) : `${label(r.start)}–${label(r.end)}`);
    if (parts.length > 3) return `${parts.slice(0, 3).join(', ')} and later`;
    return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
}

/**
 * When the wind (and so cheaper power) is coming, compared with today
 * @returns {{ text: string, tier: string }}
 */
function outlook(days) {
    const [today, ...later] = days;
    const dates = days.map(d => d.date);
    const windy = later.filter(d => d.tier === 'green');

    if (today.tier === 'green') {
        return { tier: 'green', text: 'Windy today, so power is likely cheap now' };
    }
    if (windy.length > 0) {
        return { tier: 'green', text: `Windier ${dayRanges(windy, dates)}: power will likely be cheaper then` };
    }
    const better = later.filter(d => TIER_RANK[d.tier] > TIER_RANK[today.tier]);
    if (better.length > 0) {
        return { tier: 'yellow', text: `A bit windier ${dayRanges(better, dates)}: power may be a little cheaper then` };
    }
    return { tier: today.tier, text: 'No windier days in the forecast' };
}

function showNow(section, hour) {
    const el = section.querySelector('.wind-now');
    const from = compass(hour.from);
    el.querySelector('.wind-now-label').innerText = `Wind now, ${hour.time.slice(11, 16)}`;
    el.querySelector('.wind-now-speed').innerText = hour.speed.toFixed(1);
    el.querySelector('.wind-now-direction').innerHTML = `${arrowSvg(hour.from)} From ${from} → ${compass(towards(hour.from))}`;
    el.querySelector('.wind-now-hint').innerText =
        `${describe(hour.speed)} from the ${COMPASS_WORDS[from]}, gusts up to ${Math.round(hour.gust)} m/s`;
    el.hidden = false;
}

function showOutlook(section, days) {
    const { tier, text } = outlook(days);
    const el = section.querySelector('.wind-outlook');
    el.innerHTML = `${tierDot(tier)} ${text}`;
    el.hidden = false;
}

function showDays(section, days) {
    // Shared scale for the bars, up to the strongest gust
    const scaleMax = Math.ceil(Math.max(...days.map(d => d.gust)));
    const percent = (value) => `${(value / scaleMax * 100).toFixed(1)}%`;
    const name = (index, date) => index === 0 ? 'Today' : index === 1 ? 'Tomorrow' : weekday(date);

    section.querySelector('.wind-days').innerHTML = days.map((day, index) => `
        <li class="wind-day">
            <div class="wind-day-name">${name(index, day.date)} ${tierDot(day.tier)}<small>${dayMonth(day.date)}</small></div>
            <div class="wind-day-direction">${arrowSvg(day.from)}<span>${compass(day.from)} → ${compass(towards(day.from))}<small>${describe(day.max)}</small></span></div>
            <div class="wind-range" title="${day.min}–${day.max} m/s, average ${day.average} m/s, gusts ${day.gust} m/s">
                <div class="wind-range-fill" style="left: ${percent(day.min)}; width: calc(${percent(day.max - day.min)} + 0.5rem)"></div>
                <div class="wind-range-gust" style="left: ${percent(day.gust)}"></div>
            </div>
            <div class="wind-day-speed"><b>${Math.round(day.min)}–${Math.round(day.max)}</b> m/s<small>gusts ${Math.round(day.gust)}</small></div>
        </li>`).join('');
}

/**
 * @param {{ time: string, speed: number, gust: number, from: number }[]} hours
 * @param {number} currentIndex hours before it are dimmed
 */
function renderChart(section, hours, currentIndex) {
    const isPast = (index) => index < currentIndex;
    const dim = (rgb) => (ctx) => isPast(ctx.p1DataIndex) ? `rgba(${rgb}, ${PAST_ALPHA})` : undefined;
    const hasArrow = (index) => index % ARROW_EVERY === ARROW_EVERY / 2;
    const timeLabel = (hour) => `${weekday(hour.time.slice(0, 10))} ${hour.time.slice(11, 16)}`;

    new Chart(section.querySelector('canvas').getContext('2d'), {
        type: 'line',
        data: {
            labels: hours.map(h => h.time),
            datasets: [
                {
                    label: 'Wind',
                    data: hours.map(h => h.speed),
                    borderColor: `rgb(${WIND_RGB})`,
                    backgroundColor: `rgba(${WIND_RGB}, 0.15)`,
                    borderWidth: 2,
                    tension: 0.3,
                    fill: true,
                    segment: { borderColor: dim(WIND_RGB) },
                    pointStyle: hours.map((h, i) => hasArrow(i) ? arrowImage(h.from) : false),
                    pointRadius: hours.map((h, i) => hasArrow(i) ? 6 : 0),
                    pointHoverRadius: 4
                },
                {
                    label: 'Gusts',
                    data: hours.map(h => h.gust),
                    borderColor: `rgb(${GUST_RGB})`,
                    borderWidth: 1.5,
                    borderDash: [4, 4],
                    tension: 0.3,
                    fill: false,
                    segment: { borderColor: dim(GUST_RGB) },
                    pointRadius: 0
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { labels: { color: '#94a3b8', usePointStyle: true, pointStyle: 'line' } },
                tooltip: {
                    callbacks: {
                        title: (items) => timeLabel(hours[items[0].dataIndex]),
                        label: (item) => item.datasetIndex === 0
                            ? ` Wind ${item.raw.toFixed(1)} m/s from ${compass(hours[item.dataIndex].from)}`
                            : ` Gusts ${item.raw.toFixed(1)} m/s`
                    }
                }
            },
            scales: {
                x: {
                    // A line at each midnight, the day's name under its noon
                    grid: { color: (ctx) => ctx.index % 24 === 0 ? 'rgba(255, 255, 255, 0.12)' : 'transparent' },
                    ticks: {
                        color: '#94a3b8',
                        autoSkip: false,
                        maxRotation: 0,
                        callback: (value, index) => index % 24 === 12 ? weekday(hours[index].time.slice(0, 10)) : ''
                    }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#94a3b8' },
                    title: { display: true, text: 'm/s', color: '#94a3b8' }
                }
            }
        }
    });
}

/**
 * @param {object | null} data contents of data/wind.json, or null when it couldn't be loaded
 * @param {{ date: string, hour: number }} now Copenhagen time
 */
export function renderWind(data, now) {
    const section = document.getElementById('wind-section');
    const loading = section.querySelector('.loading');

    // Start at today, even if the file was written yesterday
    const days = (data?.days ?? []).filter(d => d.date >= now.date).slice(0, DAYS_SHOWN);
    if (days.length === 0) {
        loading.innerHTML = data
            ? '<p class="info-message">The wind forecast is out of date.</p>'
            : '<p class="error-message">Could not load the wind forecast.</p>';
        return;
    }

    const lastDate = days.at(-1).date;
    const hours = data.hours.filter(h => h.time >= days[0].date && h.time.slice(0, 10) <= lastDate);
    const currentIndex = hours.findIndex(h => h.time === `${now.date}T${pad(now.hour)}:00`);

    section.querySelector('h2').innerText = `Wind · next ${days.length} days`;
    loading.style.display = 'none';
    section.querySelector('.wind-content').hidden = false;

    if (currentIndex >= 0) showNow(section, hours[currentIndex]);
    showOutlook(section, days);
    renderChart(section, hours, currentIndex);
    showDays(section, days);

    const updated = new Date(data.updatedAt).toLocaleString('en-GB', {
        timeZone: 'Europe/Copenhagen', weekday: 'short', hour: '2-digit', minute: '2-digit'
    });
    section.querySelector('.wind-source').innerHTML =
        `Forecast for ${data.location.name} from <a href="https://open-meteo.com/">Open-Meteo.com</a>, updated ${updated}`;
}
