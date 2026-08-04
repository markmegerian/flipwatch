# Flipwatch — Business Plan (v1)

## Positioning

Flipwatch is a speed tool for eBay resellers: it finds newly listed, underpriced items
before other buyers see them. The general monitoring tier serves any flipper; the Pro
tier serves the collectibles/trading-card crowd the original script was built for.

One sentence for the store listing:
> **Be first to every deal on eBay — instant new-listing alerts, market-price scoring,
> auction sniping assistant, and a profit tracker for resellers.**

## Tiers & pricing

| | **Trial** (7 days) | **Standard $14.99/mo** | **Pro $29.99/mo** |
|---|---|---|---|
| Saved searches | 3 | 10 | 50 |
| Fastest refresh | 60s | 30s | 15s |
| Desktop alerts | ✅ | ✅ | ✅ |
| Saved listings + portfolio | ✅ | ✅ | ✅ |
| Auctions + snipe assist | ✅ (taste of Pro) | — | ✅ |
| Deal scores (price vs. comps) | ✅ (taste of Pro) | — | ✅ |

Rationale:
- The trial includes Pro features so users feel what they'd lose by picking Standard.
- 15s refresh is a real cost driver (eBay quota) — price it into Pro.
- Annual plans at 2 months free ($149 / $299) once monthly churn is understood.
- Comparable products anchor these prices well: auction snipe services run $5–15/mo,
  reseller software (Vendoo, List Perfectly) runs $20–70/mo, card-scanning/portfolio
  apps run $10–20/mo. A tool that claims to *make* users money can hold a $30 price
  if alerts are reliably fast.

## Unit economics (rough)

- eBay Browse API free tier: 5,000 calls/day per app. **Apply for the higher limit
  (up to 100k+/day, free) as soon as you have a working product** — this is the main
  scaling constraint. A Pro user polling 5 searches at 15s ≈ 28.8k calls/day, so the
  per-user `daily_api_calls` caps in `plan_limits` are what keep quota spend bounded;
  tune them against your approved limit.
- Supabase: free tier covers early beta; $25/mo Pro covers thousands of users.
- Stripe: 2.9% + 30¢.
- Marginal cost per subscriber is effectively pennies; this is a >90% gross-margin
  product once the eBay quota increase is granted.

## Go-to-market

1. **Beta with the current user base** — whoever uses the userscript today migrates
   first; their feedback tunes the alert latency story.
2. **Chrome Web Store listing** (one-time $5 dev fee) with screenshots of the side
   panel and a latency demo GIF.
3. **Where resellers hang out:** r/Flipping, r/pkmntcgtrades, r/sportscards, Facebook
   reseller groups, TikTok/YouTube "live pull" and flipping channels (offer creators
   free Pro).
4. **Content:** "how fast do eBay deals disappear" style posts demonstrate the core
   value prop with data you can generate from your own backend.

## Competition

- eBay's own saved-search emails: minutes-to-hours slow — this is the wedge.
- Snipe services (Gixen, Bidnip): auction-only, no discovery/monitoring.
- BrickSeek-style deal tools: mostly retail, not eBay.
- Other "eBay alert" extensions: mostly scrapers that break; being API-based is both
  a reliability and a policy story you can put in marketing copy.

## Key risks

| Risk | Mitigation |
|---|---|
| eBay quota application denied | Stay under free tier with slower refresh tiers; reapply with usage data |
| Chrome Web Store review friction | No remote code, no content scripts on eBay pages, clear privacy policy — the current build is designed to pass |
| Snipe-assist policy pressure | It's user-initiated bidding with a reminder; can be reduced to "open listing at T-minus" if ever challenged |
| Churn after a user's "hunt" ends | Portfolio + saved data create switching costs; email win-back with "deals you missed this week" |

## Launch checklist (business side)

- [ ] Pick final name + register domain (avoid "eBay" in the name/logo)
- [ ] LLC or sole prop + business bank account for Stripe
- [ ] Terms of Service + Privacy Policy (required by Chrome Web Store; keep honest:
      what's collected = email, searches, portfolio; nothing sold)
- [ ] eBay Developer Program account + production keys + quota increase application
- [ ] Stripe account with Standard/Pro products
- [ ] Chrome Web Store developer account ($5)
- [ ] Simple landing page: pricing, screenshots, install link, ToS/Privacy
