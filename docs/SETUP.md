# Setup Guide — from zero to a working paid product

Time: ~1–2 hours. Everything starts on free tiers.

## 1. eBay Developer account (~20 min + approval wait)

1. Register at https://developer.ebay.com (free). Approval is usually same-day.
2. Create an application → you get a **Client ID** and **Client Secret** for both
   Sandbox and Production. Flipwatch only needs the *client-credentials* grant
   (no user consent flow) because it only reads public listing data.
3. Free quota is 5,000 Browse API calls/day. Once the product works, apply for the
   **Application Growth Check** to raise it (free; they review that you comply with
   the API license).
4. **Production keyset compliance:** eBay marks production keys "Non Compliant"
   (and blocks them) until you register a Marketplace Account Deletion endpoint.
   After deploying functions (step 2.4), go to Application Keys → Alerts &
   Notifications → Marketplace Account Deletion and enter:
   - endpoint: `https://<PROJECT_REF>.supabase.co/functions/v1/ebay-account-deletion`
   - verification token: the value of `EBAY_VERIFICATION_TOKEN` (or the default
     baked into `supabase/functions/ebay-account-deletion/index.ts`)
   Click Save — eBay fires a challenge request the function must answer, then the
   keyset flips to compliant. Use "Send Test Notification" to verify end-to-end.

## 2. Supabase project (~20 min)

1. Create a project at https://supabase.com (free tier is fine to start).
2. Push the schema:
   ```bash
   cd supabase
   supabase link --project-ref <YOUR_PROJECT_REF>
   supabase db push          # applies migrations/0001_init.sql
   ```
3. Set function secrets:
   ```bash
   supabase secrets set \
     EBAY_CLIENT_ID=... \
     EBAY_CLIENT_SECRET=... \
     EBAY_ENV=production \
     STRIPE_SECRET_KEY=sk_live_... \
     STRIPE_WEBHOOK_SECRET=whsec_... \
     STRIPE_PRICE_STANDARD=price_... \
     STRIPE_PRICE_PRO=price_... \
     CHECKOUT_SUCCESS_URL=https://yoursite.com/thanks \
     CHECKOUT_CANCEL_URL=https://yoursite.com/pricing
   ```
4. Deploy functions:
   ```bash
   supabase functions deploy ebay-search
   supabase functions deploy deal-score
   supabase functions deploy stripe-checkout
   supabase functions deploy stripe-webhook --no-verify-jwt        # Stripe signs instead
   supabase functions deploy ebay-account-deletion --no-verify-jwt # eBay challenge/notices
   ```
5. In Authentication → Providers, enable **Email**. Decide on email confirmation
   (recommended ON for production to block throwaway trial farming).
6. (Recommended) In Database → Extensions enable `pg_cron`, then schedule the
   seen-items pruner:
   ```sql
   select cron.schedule('prune-seen', '0 9 * * *', $$select public.prune_seen_items()$$);
   ```

## 3. Stripe (~15 min)

1. Create two recurring products: **Standard $14.99/mo**, **Pro $29.99/mo** → copy
   both `price_...` IDs into the secrets above.
2. Developers → Webhooks → Add endpoint:
   `https://<PROJECT_REF>.supabase.co/functions/v1/stripe-webhook`
   Events: `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`.
   Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
3. Turn on the **customer portal** (Settings → Billing) so subscribers can cancel or
   change cards themselves; link to it from your site.

## 4. Extension (~10 min)

1. Edit `extension/lib/config.js` — set `SUPABASE_URL`, `SUPABASE_ANON_KEY`
   (Supabase → Settings → API), and your site URL.
2. Test locally: `chrome://extensions` → Developer mode → Load unpacked →
   select `extension/`. Create an account in the options page, add a search,
   watch the feed populate.
3. Publish: zip the `extension/` folder, upload at
   https://chrome.google.com/webstore/devconsole ($5 one-time). Fill in the
   privacy disclosures (email + saved-search data, no sale of data).

## 5. Smoke test end-to-end

- [ ] Sign up → trial row appears in `subscriptions` (trigger works)
- [ ] Add a saved search → results within one poll interval; NEW badges on fresh items
- [ ] Second poll shows no false "new" flood (server-side seen-set works)
- [ ] Checkout with Stripe test card `4242 4242 4242 4242` → tier flips to paid
- [ ] Let the trial expire (or set `trial_ends_at` in the past) → extension shows
      renew gate and polling stops (402 → paused)
- [ ] Arm a snipe on a sandbox auction → tab opens at T-minus with notification

## Sandbox tip

Set `EBAY_ENV=sandbox` and use sandbox keys to develop without burning production
quota; sandbox search data is sparse but fine for plumbing tests.

## Mock mode (no eBay account needed)

While waiting on eBay developer approval, `ebay-search` and `deal-score` serve
**synthetic listings** whenever `EBAY_ENV=mock` or no `EBAY_CLIENT_ID` secret is
set. A fresh "new listing" rotates in every ~40 seconds, so the seen-set diff,
NEW badges, notifications, auction countdowns, and deal scores are all fully
exercisable. Mock responses include `"mock": true`. Setting real eBay secrets
switches to the live API — no code change or redeploy needed.
