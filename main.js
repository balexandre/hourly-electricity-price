const API_BASE = 'https://stromligning.dk/api/prices';
const PRODUCT_ID = 'andel_energi_timeenergi';
const SUPPLIER_ID = 'cerius_c';
const CUSTOMER_GROUP_ID = 'c';
const AGGREGATION = '1h';

const PRICE_THRESHOLD_LOW = 1.8;
const PRICE_THRESHOLD_HIGH = 2.5;

/**
 * Fetch prices for a specific date
 * @param {Date} date 
 */
async function fetchPrices(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    
    const from = `${year}-${month}-${day}T00:00:00`;
    const to = `${year}-${month}-${day}T23:59:59`;

    const url = `${API_BASE}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&productId=${PRODUCT_ID}&supplierId=${SUPPLIER_ID}&customerGroupId=${CUSTOMER_GROUP_ID}&aggregation=${AGGREGATION}`;

    try {
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.error) {
            return { error: data.error };
        }
        
        return data;
    } catch (error) {
        console.error('Error fetching data:', error);
        return { error: 'Failed to connect to API' };
    }
}

/**
 * Get color based on price
 * @param {number} price 
 */
function getColor(price) {
    if (price < PRICE_THRESHOLD_LOW) return '#22c55e'; // Green
    if (price < PRICE_THRESHOLD_HIGH) return '#eab308'; // Yellow
    return '#ef4444'; // Red
}

/**
 * Render chart
 * @param {string} containerId 
 * @param {string} dateLabel 
 * @param {Object} data 
 * @param {number} maxY 
 */
function renderChart(containerId, dateLabel, data, maxY) {
    const section = document.getElementById(containerId);
    const dateEl = section.querySelector('.current-date');
    const loadingEl = section.querySelector('.loading');
    const chartWrapper = section.querySelector('.chart-wrapper');
    const canvas = section.querySelector('canvas');
    
    dateEl.innerText = dateLabel;

    if (data.error) {
        loadingEl.innerHTML = `<p class="error-message">${data.error}</p>`;
        return;
    }

    const prices = data.prices;
    const labels = prices.map(p => {
        const date = new Date(p.date);
        return date.getHours().toString().padStart(2, '0') + 'h';
    });
    
    const values = prices.map(p => p.price.total);
    const backgroundColors = values.map(v => getColor(v));

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
                    label: 'Threshold 1.8',
                    data: Array(labels.length).fill(PRICE_THRESHOLD_LOW),
                    borderColor: '#22c55e',
                    borderWidth: 2,
                    borderDash: [5, 5],
                    pointRadius: 0,
                    fill: false,
                    order: 2
                },
                {
                    type: 'line',
                    label: 'Threshold 2.5',
                    data: Array(labels.length).fill(PRICE_THRESHOLD_HIGH),
                    borderColor: '#eab308',
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
 * Format date to "Feb 12th, 2026"
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
    const today = new Date();
    const tomorrow = new Date();
    tomorrow.setDate(today.getDate() + 1);

    const [todayData, tomorrowData] = await Promise.all([
        fetchPrices(today),
        fetchPrices(tomorrow)
    ]);

    // Calculate global Max Y for synchronized scales
    let maxPrice = 3.0; // Default min max to show thresholds
    
    if (!todayData.error) {
        maxPrice = Math.max(maxPrice, ...todayData.prices.map(p => p.price.total));
    }
    if (!tomorrowData.error) {
        maxPrice = Math.max(maxPrice, ...tomorrowData.prices.map(p => p.price.total));
    }
    
    const maxY = Math.ceil(maxPrice * 1.1 * 10) / 10; // 10% buffer, rounded up to 1 decimal

    renderChart('today-section', `Prices for Today\n${formatDate(today)}`, todayData, maxY);
    renderChart('tomorrow-section', `Prices for Tomorrow\n${formatDate(tomorrow)}`, tomorrowData, maxY);
})();
