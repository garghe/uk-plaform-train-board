# UK Platform Departure Board

A web page that looks like the orange dot-matrix departure boards on UK railway platforms. Type a station, and its next trains appear. You can show **up to 4 stations** at once.

![Four stations](docs/screenshot-4-stations.png)

## What it shows

Each board has four lines, like the real ones:

1. **Next train:** time, destination and status (`On time`, `Exp 14:44`, `Delayed`, `Cancelled`).
2. **Calling at:** the stops, scrolling right to left.
3. **Following trains:** `2nd`, `3rd`, `4th`… taking turns every 4 seconds.
4. **Clock:** UK time (HH:MM:SS).

Data refreshes every 30 seconds.

## Layouts

| Stations | Layout |
|---|---|
| 1 | One large board |
| 2 | Two boards, one above the other |
| 3–4 | Screen split in 4 |

| 1 station | 2 stations |
|---|---|
| ![One station](docs/screenshot-1-station.png) | ![Two stations](docs/screenshot-2-stations.png) |

## Using it

- **Add a station:** type its name or 3-letter code (e.g. `Bath Spa` or `BTH`) and press **+ Add**. Suggestions appear as you type.
- **Remove a station:** click **✕** on its tag.
- **Bookmark a set:** the web address keeps your stations, e.g. `http://localhost:3000/?stations=LBG,WAT,MAN,EDB`. Your last set is also remembered in the browser.
- **Full screen:** the **⛶** button hides the toolbar (handy on a spare monitor or TV). Press `Esc` to leave.

## Running it

You need [Node.js](https://nodejs.org) 18 or newer. Running it locally needs nothing installed.

```bash
npm start
```

Then open http://localhost:3000.

Without an API key it runs on **sample data** (made-up trains that look realistic). The toolbar shows `● Sample data` or `● Live data`.

## Live data (API key, local)

Live times come from the **Rail Data Marketplace** (the official National Rail source).

1. Create a free account at [raildata.org.uk](https://raildata.org.uk/).
2. Search the catalogue for **Live Departure Board** and subscribe. Approval can take from minutes to a few days.
3. In the product's **Specification** tab, copy the **Consumer key**.
4. Copy `.env.example` to `.env` and paste the key:

   ```
   RDM_API_KEY=your-consumer-key
   ```

5. Restart with `npm start`.

The key stays on the server. It is never sent to the browser, and `.env` is excluded from git.

If your subscription gives a different endpoint address, set `RDM_DEPARTURES_URL` in `.env` (without the station code at the end). The default uses `GetDepBoardWithDetails`, which includes calling points.

## Deploying to Cloudflare

The app runs as a **Cloudflare Worker**: Cloudflare hosts the page files in `public/`, and a small Worker (`src/worker.js`) answers the `/api/...` calls. The free plan is enough.

### One-time setup

```bash
npm install
```

```bash
npx wrangler login
```

### Deploy

```bash
npm run deploy
```

Wrangler prints the address, e.g. `https://uk-platform-train-board.<your-subdomain>.workers.dev`.

### Add the API key

The key goes into Cloudflare as a **Secret**, not into the code or `wrangler.toml`. Use either way:

- **Terminal:**

  ```bash
  npx wrangler secret put RDM_API_KEY
  ```

  Paste the key when asked. It takes effect straight away.

- **Dashboard:** go to **Workers & Pages**, open `uk-platform-train-board`, then **Settings → Variables and Secrets → Add**. Choose type **Secret**, name `RDM_API_KEY`, paste the key, and deploy.

Until the key is set, the deployed site shows sample data. The toolbar shows which mode it's in.

If your endpoint address differs, add `RDM_DEPARTURES_URL` as a plain variable (see the comment in `wrangler.toml`).

### Deploying from GitHub instead

In the Cloudflare dashboard, **Workers & Pages → Create → Import a repository**, pick this repo, and keep the deploy command `npx wrangler deploy`. Then add the `RDM_API_KEY` secret as above. Every push to the chosen branch redeploys.

### Testing the Cloudflare version locally

```bash
npm run cf:dev
```

This runs on http://localhost:8787. For a local key, put `RDM_API_KEY=...` in a `.dev.vars` file (excluded from git).

## How it is built

```
src/api.js          API logic shared by both versions: live data, sample data, 20 s cache
src/worker.js       Cloudflare Worker entry point
wrangler.toml       Cloudflare config
server.js           Local Node server (no dependencies)
public/index.html   Page
public/style.css    Board look (Doto dot-matrix font from Google Fonts)
public/app.js       Stations, layout, scrolling, cycling and clock
data/stations.json  UK station names and codes
```

API endpoints (same on both versions):

| Path | Returns |
|---|---|
| `/api/stations` | All stations as `[name, code]` |
| `/api/departures?crs=LBG` | Next departures for a station |
| `/api/status` | `live` or `sample` |

## Credits

- Station list: [davwheat/uk-railway-stations](https://github.com/davwheat/uk-railway-stations), under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).
- Live data: National Rail Enquiries via the [Rail Data Marketplace](https://raildata.org.uk/).
- Font: [Doto](https://fonts.google.com/specimen/Doto) (SIL Open Font License).
