# Flipwatch — eBay Deal Monitoring, as a Subscription

> **Flipwatch** is a working name — rename freely. (Note: "eBay" cannot appear in your
> product name or logo per eBay's trademark policy, though "for eBay" descriptive use is OK.)

Flipwatch is the professional, commercial rebuild of the personal `ebay-monitor.user.js`
Tampermonkey script. It keeps everything that made the script valuable — near-real-time
new-listing alerts, auction tracking with snipe assist, a reseller portfolio, and deal
scoring — and rebuilds it as a **paid Chrome extension backed by a cloud API**, so it can
be sold as a subscription without shipping secrets to the client or violating eBay policy.

## Why the architecture changed

The userscript scraped eBay search pages from inside the user's tab and replayed the
user's session cookie to buy items. That works for one person; it fails as a business:

1. **Secrets.** eBay API keys and "is this user paying?" checks cannot live in
   client-side extension code — anyone can read the source and extract/bypass them.
2. **Policy.** Commercial scraping and cookie-replay purchasing violate eBay's User
   Agreement. A paid product built on them can be shut down and can get *customers'*
   eBay accounts suspended.
3. **Reliability.** eBay markup changes constantly; the official Browse API doesn't.

So the product is split in two:

```
┌─────────────────────────────┐         ┌──────────────────────────────────┐
│  Chrome Extension (MV3)     │  HTTPS  │  Backend (Supabase)              │
│  — what the customer buys   │────────▶│  — what makes it a business      │
│                             │  JWT    │                                  │
│  • Side-panel UI            │         │  • Auth (email/password, magic   │
│  • Saved searches & feed    │         │    link) → JWT                   │
│  • Alarm-based polling      │         │  • Postgres: users, plans, saved │
│  • Notifications (sound,    │         │    searches, seen items,         │
│    badge, chrome.notif)     │         │    portfolio                     │
│  • Auction countdown +      │         │  • Edge functions:               │
│    snipe assist             │         │    /ebay-search  → eBay Browse   │
│  • Portfolio & deal scores  │         │      API proxy (app token lives  │
│                             │         │      here), caching, per-plan    │
│                             │         │      rate limits                 │
│                             │         │    /deal-score   → price-vs-comp │
│                             │         │    /stripe-checkout, /stripe-    │
│                             │         │      webhook → billing           │
└─────────────────────────────┘         └──────────────┬───────────────────┘
                                                       │
                                          ┌────────────┴───────────┐
                                          │ eBay Browse API        │
                                          │ (official, free tier   │
                                          │ 5,000 calls/day, apply │
                                          │ for higher limits)     │
                                          │ Stripe (subscriptions) │
                                          └────────────────────────┘
```

The extension is the product the customer installs; the backend is what enforces the
subscription and talks to eBay with **your** application token. Customers never need an
eBay developer account, never paste cookies, and their eBay login is never touched by
your servers.

## Repo layout

```
flipwatch/
├── extension/              # Chrome Manifest V3 extension (no build step — load unpacked)
│   ├── manifest.json
│   ├── background.js       # service worker: polling scheduler, notifications, snipe alarms
│   ├── lib/api.js          # backend client (auth, search, portfolio, billing)
│   ├── lib/store.js        # chrome.storage wrapper + state
│   ├── panel/              # side-panel UI (feed, auctions, saved, portfolio, deals)
│   └── options/            # account, sign-in, subscription, notification settings
├── supabase/
│   ├── migrations/0001_init.sql       # full schema + row-level security
│   └── functions/
│       ├── _shared/        # CORS, auth guard, plan limits, eBay app-token cache
│       ├── ebay-search/    # Browse API proxy (the only thing that talks to eBay)
│       ├── deal-score/     # scores a listing vs. median of comparable actives
│       ├── stripe-checkout/# creates Checkout Session for a plan
│       └── stripe-webhook/ # keeps subscriptions table in sync with Stripe
├── docs/
│   ├── BUSINESS.md         # tiers, pricing, positioning, competition
│   ├── COMPLIANCE.md       # eBay policy analysis — read before launch
│   ├── SETUP.md            # step-by-step: eBay dev account → Supabase → Stripe → store
│   └── ROADMAP.md          # what v1 leaves out, and the order to add it
└── README.md
```

## Feature parity with the userscript

| Userscript feature | v1 status | How |
|---|---|---|
| New BIN listing detection (~8s) | ✅ (per-plan interval) | Backend polls Browse API on the extension's schedule; `seen` dedup server-side |
| Push alerts (ntfy) | ✅ upgraded | Chrome notifications + sound; email digest via backend (roadmap: mobile push) |
| Price / keyword / seller / US-only filters | ✅ | Browse API filter params + client-side refinement |
| Auction tab + countdown | ✅ | Browse API returns auction end time & current bid |
| Auto-snipe (fires a bid) | ⚠️ **snipe assist** | Opens the bid page pre-filled at T-minus; user confirms. See COMPLIANCE.md |
| 1-click buy (cookie replay) | ❌ removed | Policy violation. Replaced with 1-click *open* deep link |
| Portfolio + TCGPlayer comps | ✅ portfolio, manual comps | TCGPlayer API is partner-gated; comps via eBay actives + manual entry (roadmap) |
| "For You" suggestions | ✅ as Deal Score | Price-vs-comparables scoring on the backend |
| Blocked sellers, saved items, themes | ✅ | Ported |

## Quick start (development)

1. Follow `docs/SETUP.md` to create the eBay developer app, Supabase project, and Stripe
   products (about an hour, all free to start).
2. `supabase db push && supabase functions deploy` from `supabase/`.
3. Fill `extension/lib/config.js` with your Supabase URL + anon key.
4. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → `extension/`.

## License

Proprietary — this is your commercial product. Do not publish the repo publicly.
