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
- **Tesla Charging**: the car's afternoon charge schedule is only switched on when the afternoon is cheaper than the night after (optional).
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
   ├─► 3. scripts/tesla-charge.mjs   switches the car's afternoon charge schedule on or off
   │                                 (remembers the day's decision in data/charge.json)
   ├─► 4. commits data/ back to the repo (only when something changed)
   └─► 5. deploys the site to GitHub Pages
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

## Tesla Charging

The car has two charge schedules: 02:00–06:00, which is always on, and 12:00–17:00, which this repo turns on and off.

- The afternoon schedule is **off by default**, so the car waits for the night.
- When tomorrow's prices are published (~13:00), it compares the rest of the afternoon with tomorrow's 02:00–06:00. If the afternoon is cheaper on average, it switches the schedule **on** until 17:00.
- After 17:00 it switches it back off.

The car is only woken when the schedule actually has to change, about twice on an "afternoon" day and not at all otherwise. Tesla bills this well inside its $10 monthly free credit. The windows are set at the top of `scripts/tesla-charge.mjs`. If you change the times in the car, change them there too.

Tesla only accepts signed commands from cars made since 2021, so the workflow builds Tesla's [`tesla-control`](https://github.com/teslamotors/vehicle-command) and signs them with a private key. The car trusts the matching public key, which is hosted at `https://balexandre.github.io/.well-known/appspecific/com.tesla.3p.public-key.pem` (from the `balexandre.github.io` repo).

### One-time setup

These scripts need Node.js 20.12+.

1. **Tesla app**: on [developer.tesla.com](https://developer.tesla.com), create an app with:
   - Allowed origin `https://balexandre.github.io`
   - Redirect URI `http://localhost:3002/callback`
   - Scopes: vehicle information, location, commands and charging management
   - A payment method on file

   Put its `TESLA_CLIENT_ID` and `TESLA_SECRET` in `.env`.
2. **Key**: generate a key pair into `.tesla/` (gitignored), and publish the public key at the URL above:
   ```bash
   openssl ecparam -name prime256v1 -genkey -noout -out .tesla/private-key.pem
   openssl ec -in .tesla/private-key.pem -pubout -out .tesla/com.tesla.3p.public-key.pem
   ```
3. **Register and sign in**:
   ```bash
   node scripts/tesla-setup.mjs register   # tells Tesla's EU region about the domain and key
   node scripts/tesla-setup.mjs login      # signs in through the browser, saves .tesla/token.json
   ```
4. **Pair**: on the phone with the Tesla app, open `https://tesla.com/_ak/balexandre.github.io` and approve the key.
5. **Find the schedule**: `TESLA_VIN=… node scripts/tesla-setup.mjs schedules` lists the car's schedules and their ids. Use `node scripts/tesla-setup.mjs vehicles` to get the VIN.
6. **GitHub**: under *Settings → Secrets and variables → Actions*, add these repository secrets:

   | Secret | Value |
   | --- | --- |
   | `TESLA_CLIENT_ID` | from the Tesla app |
   | `TESLA_VIN` | the car's VIN |
   | `TESLA_SCHEDULE_ID` | the afternoon schedule's id |
   | `TESLA_PRIVATE_KEY` | contents of `.tesla/private-key.pem` |
   | `TESLA_REFRESH_TOKEN` | `jq -r .refresh_token .tesla/token.json \| gh secret set TESLA_REFRESH_TOKEN` |
   | `TESLA_GH_TOKEN` | a fine-grained token for this repo with *Secrets: read and write* |

   Tesla refresh tokens work only once. Every time the workflow uses one, it saves the new one back into `TESLA_REFRESH_TOKEN` with `TESLA_GH_TOKEN`. Once the secret is set, don't run the scripts locally with the same token, or the two copies will fall out of step. If the workflow reports `login_required`, run `login` again and update the secret.

```bash
node scripts/tesla-charge.mjs --dry-run   # what it would do right now
node scripts/tesla-charge.mjs on          # switch the afternoon schedule on (or off) right now
```

## Technologies

- **HTML5 / CSS3**: Vanilla implementation for maximum performance.
- **JavaScript (ES6+)**: Module-based logic.
- **Chart.js**: For data visualization.
- **Lucide Icons**: For UI elements.
- **Node.js**: Data fetching, notifications and a minimal static server for local testing.
- **GitHub Actions + Pages**: Scheduling and hosting.
- **ntfy**: Push notifications.
