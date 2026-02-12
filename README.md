# Hourly Electricity Price Chart

A clean, responsive web application to visualize hourly electricity prices for Today and Tomorrow, optimized for mobile and tablet viewing.

## Features

- **Dual Charts**: Compare Today's prices with Tomorrow's prices side-by-side.
- **Synchronized Scaling**: Both charts share the same Y-axis scale for accurate visual comparison.
- **Price Thresholds**:
  - Green line at **1.8 DKK/kWh** (Low price).
  - Yellow line at **2.5 DKK/kWh** (Medium price).
- **Responsive Design**: Glassmorphism UI that looks great on all devices.
- **Graceful Error Handling**: Detects when tomorrow's data isn't available yet (usually before 1 PM CET).

## Source Data

Data is fetched from the [stromligning.dk API](https://stromligning.dk/api/docs) for the "Andel Energi Timeenergi" product.

```js
const PRODUCT_ID = 'andel_energi_timeenergi';
const SUPPLIER_ID = 'cerius_c';
```

## Local Development

You can run the project locally without any dependencies or build steps.

1.  Clone the repository.
2.  Start the local server:
    ```bash
    node ./server.js
    ```
3.  Open [http://localhost:3001](http://localhost:3001) in your browser.

## Deployment

The project is configured for **GitHub Pages**. Any push to the `master` or `main` branch will trigger a deployment using the workflow in `.github/workflows/deploy.yml`.

## Technologies

- **HTML5 / CSS3**: Vanilla implementation for maximum performance.
- **JavaScript (ES6+)**: Module-based logic.
- **Chart.js**: For data visualization.
- **Lucide Icons**: For UI elements.
- **Node.js**: Minimal static server for local testing.
