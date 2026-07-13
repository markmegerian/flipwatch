// POST /functions/v1/stripe-checkout
// Creates a Stripe Checkout Session for the requested tier and returns its URL.
// Body: { tier: "standard" | "pro" }
import Stripe from "npm:stripe@16";
import { adminClient, json, preflight } from "../_shared/mod.ts";

const PRICE_IDS: Record<string, string | undefined> = {
  standard: Deno.env.get("STRIPE_PRICE_STANDARD"),
  pro: Deno.env.get("STRIPE_PRICE_PRO"),
};

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // Any signed-in user may open checkout (including expired ones — that's the
  // whole point), so validate the JWT directly instead of requireSubscriber.
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const admin = adminClient();
  const { data: userData, error } = await admin.auth.getUser(token);
  if (error || !userData?.user) return json({ error: "auth_required" }, 401);
  const user = userData.user;

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const tier = body.tier === "standard" || body.tier === "pro" ? body.tier : null;
  if (!tier) return json({ error: "unknown_tier" }, 400);

  const price = PRICE_IDS[tier];
  if (!price || !Deno.env.get("STRIPE_SECRET_KEY")) {
    return json({ error: "billing_not_configured" }, 503);
  }
  const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!);

  // Reuse the Stripe customer if one exists.
  const { data: sub } = await admin
    .from("subscriptions").select("stripe_customer_id")
    .eq("user_id", user.id).single();

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      customer: sub?.stripe_customer_id ?? undefined,
      customer_email: sub?.stripe_customer_id ? undefined : user.email,
      client_reference_id: user.id,
      subscription_data: { metadata: { user_id: user.id, tier } },
      success_url: Deno.env.get("CHECKOUT_SUCCESS_URL") ??
        "https://example.com/thanks?upgraded=1",
      cancel_url: Deno.env.get("CHECKOUT_CANCEL_URL") ??
        "https://example.com/pricing",
      allow_promotion_codes: true,
    });
    return json({ url: session.url });
  } catch (e) {
    console.error("stripe checkout error", e);
    return json({ error: "stripe_error", message: (e as Error).message }, 502);
  }
});
