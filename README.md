# Hourly Electricity Price Chart

A clean, responsive web application to visualize hourly electricity prices for Today and Tomorrow, optimized for mobile and tablet viewing — plus push notifications to the family's phones before prices get expensive.

## Features

- **Dual Charts**: Compare Today's prices with Tomorrow's prices side-by-side.
- **Right Now**: Today's chart opens with the current price, its level and when it changes; past hours are dimmed and the current one is outlined. The page refreshes itself every hour.
- **Synchronized Scaling**: Both charts share the same Y-axis scale for accurate visual comparison.
- **Price Thresholds** (total price incl. tariffs and VAT):
  - Green below **2.1 DKK/kWh**.
  - Yellow below **3.2 DKK/kWh**, red above.
- **Push Notifications** via [ntfy](https://ntfy.sh): a reminder before expensive hours, plus quiet daily overviews.
- **Responsive Design**: Glassmorphism UI that looks great on all devices.
- **Installable**: "Add to Home Screen" opens it full-screen like an app, with its own icon.

## How it works

```
GitHub Action (.github/workflows/deploy.yml)
   runs hourly through the day (05:10–21:10 UTC), plus on every push
   │
   ├─► 1. scripts/fetch-prices.mjs   fetches today + tomorrow from stromligning.dk
   │                                 → data/prices.json
   ├─► 2. scripts/notify.mjs         sends whatever notification is due → ntfy
   │                                 (remembers what it sent in data/notified.json)
   ├─► 3. commits data/ back to the repo (only when something changed)
   └─► 4. deploys the site to GitHub Pages
```

The web page only reads `data/prices.json`; it never calls the price API itself.

Notifications (all times Copenhagen):

| Notification | When | Sound |
| --- | --- | --- |
| **Expensive hours reminder** | Up to an hour before each red period, between 07:00 and 22:00 | 🔔 Buzzes |
| **Tomorrow's prices** | As soon as they're published (~13:00–14:00) | 🔕 Silent |
| **Today's prices** | First run after 07:00, only if there are red hours ahead | 🔕 Silent |

Only the reminder makes a sound, so a buzz always means "hold off now". The overviews just sit in the notification list.

```
⚠️ Expensive electricity 17:00–21:00
Up to 3.65 kr/kWh. Hold off on the dishwasher, laundry and dryer.
✅ Cheapest after: 03:00–06:00 · avg 1.70 kr
```

```
⚡ Tomorrow's prices · Sun 18 Oct
🔴 Avoid 17:00–21:00 · up to 3.65 kr
✅ Cheapest 3h: 03:00–06:00 · avg 1.70 kr

00 🟢🟢🟢🟢🟢🟢🟢🟡🟡🟡🟡🟡
12 🟡🟡🟡🟡🟡🔴🔴🔴🔴🟡🟡🟡
```

Tapping the notification opens the chart.

## Source Data

Data is fetched from the [stromligning.dk API](https://stromligning.dk/api/docs) for the "Andel Energi Timeenergi" product. The product, supplier and color thresholds are set at the top of `scripts/fetch-prices.mjs`:

```js
const PRODUCT_ID = 'andel_energi_timeenergi';
const SUPPLIER_ID = 'cerius_c';
const THRESHOLDS = { low: 2.1, high: 3.2 };
```

## Setup

1. **Secret**: in the repo, go to *Settings → Secrets and variables → Actions → New repository secret* and add `NTFY_TOPIC` with the ntfy topic name (or full topic URL). Anyone who knows the topic can read and send to it, so never commit it.
2. **Phones**: install the ntfy app ([Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy) / [iOS](https://apps.apple.com/app/ntfy/id1625396347)), tap **+** and subscribe to the same topic on `ntfy.sh`.
3. **Test**: *Actions → Update prices & deploy → Run workflow*, and choose `today`, `tomorrow` or `reminder` to send one right away.
4. **Install** (optional): open the site on the phone, then *Share → Add to Home Screen* (iPhone) or *⋮ → Add to Home screen* (Android).

## Local Development

No dependencies or build step, just Node.js 18+.

```bash
node scripts/fetch-prices.mjs      # refresh data/prices.json
node scripts/notify.mjs --dry-run  # preview the notification that's due
node scripts/notify.mjs tomorrow --dry-run
node scripts/notify.mjs reminder --dry-run
node ./server.js                   # http://localhost:3001
```

The workflow commits `data/` a few times a day, so `git pull --rebase` before pushing.

## Technologies

- **HTML5 / CSS3**: Vanilla implementation for maximum performance.
- **JavaScript (ES6+)**: Module-based logic.
- **Chart.js**: For data visualization.
- **Lucide Icons**: For UI elements.
- **Node.js**: Data fetching, notifications and a minimal static server for local testing.
- **GitHub Actions + Pages**: Scheduling and hosting.
- **ntfy**: Push notifications.
