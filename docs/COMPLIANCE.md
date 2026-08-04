# Compliance Notes — read before launch

This is a summary of the policy landscape the product was designed around. It is not
legal advice; have a lawyer review your ToS and the eBay API License Agreement before
charging customers.

## What changed from the userscript, and why

| Userscript behavior | Status as a paid product | What v1 does instead |
|---|---|---|
| Scraping eBay search HTML every 8s | ❌ Violates eBay User Agreement §"you agree not to... use any robot, spider, scraper" — commercial scraping is actively enforced | All data comes from the official **Browse API** under your API license |
| Replaying the user's `s` session cookie to purchase | ❌ Unauthorized-access territory; can get customer accounts suspended; huge liability if a purchase misfires | Removed. "Open" deep-links to the listing; the user buys on eBay |
| Auto-firing bids in the last seconds | ⚠️ Gray zone. Standalone snipe services exist and eBay tolerates them, but automating *your users'* accounts from a product you sell concentrates the risk on you | **Snipe assist**: at T-minus, opens the listing + notification with the planned max bid; the user clicks bid. No credentials, no automation of their account |
| ntfy.sh push to a shared public topic | ⚠️ Anyone who guesses the topic sees your alerts | Chrome notifications locally; roadmap: authenticated push |
| TCGPlayer price lookups by URL | ⚠️ TCGPlayer's API requires a partner agreement | Deal scores use eBay's own active-listing comps; TCGPlayer partnership on the roadmap |

## eBay API License Agreement — key obligations

- **Attribution/branding:** don't use "eBay" in your product name or imply endorsement.
  "for eBay" descriptive phrasing is acceptable ("Deal Monitor for eBay").
- **Data handling:** Browse API data may be displayed to end users but not resold as a
  dataset or retained beyond what the product needs. Flipwatch stores only item IDs
  (for dedup) and items the user explicitly saves — this is deliberate; keep it so.
- **Rate limits:** stay within your allotted calls; the per-user quota system in
  `plan_limits` exists to enforce this. Don't remove it.
- **User privacy:** you never see customers' eBay credentials. Keep it that way — it's
  both a compliance line and a marketing point.
- Consider joining the **eBay Partner Network (EPN)**: affiliate-tagging the outbound
  listing links is explicitly permitted, earns commission on purchases your product
  drives, and gives you a formal relationship with eBay. Free money for this product.

## Chrome Web Store policies

- No remote code execution: all JS ships in the package (current build complies).
- Single purpose: "monitor eBay listings and alert" — the portfolio is arguably part
  of the same reseller purpose; if review pushes back, portfolio can move to a web app.
- Privacy policy URL is mandatory; declare data collected (email, saved searches,
  portfolio entries) in the store listing's data-use disclosure.
- Subscriptions must go through your own payment processor (Stripe) — allowed for
  extensions (unlike Apple's App Store, no forced revenue share).

## Snipe assist — the line to hold

The defensible design: **the human places the bid.** Flipwatch may open the page,
pre-compute the max bid, and remind loudly — but the click is the customer's, on
their own logged-in eBay session, in their own browser. If you ever add auto-bid,
you assume responsibility for misfires (double bids, wrong amounts, network races)
and move from "productivity tool" to "automation of a third-party account," which is
where eBay enforcement and chargeback liability live. Don't ship auto-bid.
