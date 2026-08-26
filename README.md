# Open Israeli Supermarkets — Status

Public status page for the Open Israeli Supermarkets project.

**Live page:** https://openisraelisupermarkets.github.io/Status/

## What is checked

Every 10 minutes, GitHub Actions (not the production host) verifies:

| Check | Target | Pass condition |
|-------|--------|----------------|
| Website | https://www.openisraelisupermarkets.co.il/ | HTTP 200 |
| API ping | https://data.openisraelisupermarkets.co.il/ping | `{"message":"pong"}` |
| Kaggle freshness | [israeli-supermarkets-2024](https://www.kaggle.com/datasets/erlichsefi/israeli-supermarkets-2024) via Kaggle API | `lastUpdated` within 24 hours |

Results are written to `status.json` / `history.json` and published via GitHub Pages. Discord is notified when checks fail or recover.

## Secrets

Configure these repository secrets:

- `KAGGLE_USERNAME` — Kaggle username
- `KAGGLE_KEY` — Kaggle API key
- `DISCORD_WEBHOOK_URL` — Discord incoming webhook (optional but recommended)

## Manual run

```bash
export KAGGLE_USERNAME=...
export KAGGLE_KEY=...
# optional
export DISCORD_WEBHOOK_URL=...
node scripts/check.mjs
```

Or trigger **Status checks** via Actions → Run workflow.

## Enable GitHub Pages

After the first push to `main`:

1. Repo **Settings → Pages**
2. Source: **GitHub Actions**

The workflow deploys the `docs/` folder.
