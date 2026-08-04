# Roadmap — what v1 leaves out, in the order to add it

## v1.1 — retention & polish (first month after launch)
- **Alert sound in the side panel** (setting exists; wire a small audio player fed by
  the `feed-updated` message).
- **Email alerts** as a fallback when Chrome is closed: a `pg_cron` job or scheduled
  edge function that polls each user's searches server-side at a slower cadence and
  emails via Resend/Postmark. This is the single most-requested thing monitoring
  products get ("I missed a deal while my laptop was asleep").
- **eBay Partner Network affiliate links** on all outbound item URLs — revenue on top
  of subscriptions, and a formal eBay relationship (see COMPLIANCE.md).
- **Onboarding**: pre-baked search templates ("PSA 10 lots under $100", "sealed wax
  ending soonest") so new users see value in the first minute.

## v1.2 — the card-reseller tier gets teeth
- **Sold comps**: apply for eBay **Marketplace Insights API** (restricted; needs a
  business case — "pricing guidance for resellers" is exactly what it's for). This
  upgrades deal scores from active-listing medians to true sold prices.
- **TCGPlayer / PriceCharting integration** (partner API applications) for card and
  video-game comps; portfolio auto-valuation like Collectr.
- **Portfolio import/export CSV** — resellers live in spreadsheets.

## v2 — server-side monitoring (the moat)
Move polling from the extension to the backend entirely (scheduled edge functions or
a small worker), so alerts are truly 24/7 and multi-device:
- Mobile push via a tiny PWA or native wrapper (this replaces the old ntfy.sh trick,
  authenticated per user).
- SMS alerts for whale users (Twilio, Pro+ tier at $49–99/mo).
- This also enables a **web dashboard** — the extension becomes one client of many.

## v2+ — ideas parked from the userscript
- "For You" suggestions: now that saved searches + saved listings live in Postgres,
  a simple recommender (co-occurring keywords across the user base) is feasible.
- Themes/customization: fun in a personal tool; low priority in a paid product until
  users ask.
- Multi-marketplace: the architecture (proxy + normalized item shape) ports to
  Mercari/Whatnot/COMC APIs where available — each new marketplace is a pricing-tier
  story.

## Explicitly never
- Cookie-based auto-purchase or auto-bid (see COMPLIANCE.md — this is the line that
  keeps the business alive).
- Selling or sharing user search/portfolio data.
