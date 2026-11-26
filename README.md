# ACB Tracker

Adjusted cost base (ACB) and capital gains tracker for Canadian investors. A local-only PWA:
all data stays in the browser (IndexedDB). No backend, no accounts.

## What it does (MVP)

- Pooled average-cost ACB per security across all non-registered accounts
- Buys, sells, reinvested distributions, return of capital (incl. ACB below zero), splits, opening balances
- Superficial-loss rule, including re-buys in TFSA/RRSP (loss permanently denied)
- Sale check before you sell: expected gain/loss, superficial-loss warning, safe re-buy date
- Questrade activity CSV import with preview and duplicate detection
- Yearly report laid out like Schedule 3, CSV export, print to PDF
- Encrypted backup/restore (PBKDF2 + AES-GCM, Web Crypto)

Not yet: USD trades, ETF tax-breakdown import, TD/RBC import, spouse view, options and corporate actions.

## Layout

```
public/            static site served by the Worker
  lib/engine.js    pure ACB engine (no DOM, no storage)
  lib/dates.js     settlement dates (T+1 from 2024-05-27, TSX holidays)
  lib/questrade.js Questrade CSV parser
  lib/db.js        IndexedDB
  lib/backup.js    encrypted backup
  app.js           UI (hash routes)
test/              node:test suites, incl. the 15 cases from the requirements doc
wrangler.jsonc     Cloudflare Worker (static assets)
```

## Develop

```
npm test          # engine + parser tests (Node 20+)
npm run dev       # wrangler dev, http://localhost:8787
npm run deploy    # runs tests first, then wrangler deploy
```

Units in the engine: money in integer cents, quantities in micro-shares (1 share = 1,000,000).
Ordering and superficial-loss windows use settlement dates; the tax year is the settlement year.

For record-keeping only; not tax advice.
