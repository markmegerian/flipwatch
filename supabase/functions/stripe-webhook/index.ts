// POST /functions/v1/stripe-webhook  (deploy with --no-verify-jwt; Stripe signs it)
// Keeps public.subscriptions in sync with Stripe. Handles:
//   checkout.session.completed        → attach customer, activate tier
//   customer.subscription.updated     → status / period / tier changes
//   customer.subscription.deleted     → cancel
//   invoice.payment_failed            → past_due
import Stripe from "npm:stripe@16";
import { adminClient, json } from "../_shared/mod.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!);

function tierFromSubscription(sub: Stripe.Subscription): string {
  const fromMeta = sub.metadata?.tier;
  if (fromMeta === "standard" || fromMeta === "pro") return fromMeta;
  const priceId = sub.items.data[0]?.price?.id;
  if (priceId === Deno.env.get("STRIPE_PRICE_PRO")) return "pro";
  return "standard";
}

function statusFromStripe(s: Stripe.Subscription.Status): string {
  switch (s) {
    case "active":
    case "trialing": return "active";
    case "past_due":
    case "unpaid": return "past_due";
    default: return "canceled";
  }
}

Deno.serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  if (!sig) return json({ error: "missing_signature" }, 400);

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      await req.text(), sig, Deno.env.get("STRIPE_WEBHOOK_SECRET")!,
    );
  } catch (e) {
    console.error("webhook signature failed", e);
    return json({ error: "bad_signature" }, 400);
  }

  const admin = adminClient();

  async function syncSub(sub: Stripe.Subscription, userId?: string) {
    const uid = userId ?? sub.metadata?.user_id;
    if (!uid) { console.error("no user_id on subscription", sub.id); return; }
    // current_period_end lives at the top level in older Stripe API versions
    // and on the subscription item in 2025-03+ — webhook payloads use the
    // endpoint's API version, so read both shapes.
    const periodEnd = (sub as any).current_period_end ??
      (sub as any).items?.data?.[0]?.current_period_end;
    await admin.from("subscriptions").update({
      tier: tierFromSubscription(sub),
      status: statusFromStripe(sub.status),
      stripe_customer_id: String(sub.customer),
      stripe_subscription_id: sub.id,
      current_period_end: typeof periodEnd === "number"
        ? new Date(periodEnd * 1000).toISOString() : null,
      updated_at: new Date().toISOString(),
    }).eq("user_id", uid);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const uid = session.client_reference_id ?? undefined;
      if (session.subscription) {
        const sub = await stripe.subscriptions.retrieve(String(session.subscription));
        await syncSub(sub, uid);
      }
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      await syncSub(event.data.object as Stripe.Subscription);
      break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      if (invoice.subscription) {
        await admin.from("subscriptions")
          .update({ status: "past_due", updated_at: new Date().toISOString() })
          .eq("stripe_subscription_id", String(invoice.subscription));
      }
      break;
    }
  }

  return json({ received: true });
});
