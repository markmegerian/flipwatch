// Shared helpers for Flipwatch edge functions (Deno / Supabase Edge Runtime).
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

export const cors = {
  "Access-Control-Allow-Origin": "*", // extension origins are chrome-extension://<id>
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

export function preflight(req: Request): Response | null {
  return req.method === "OPTIONS" ? new Response(null, { headers: cors }) : null;
}

/** Service-role client — bypasses RLS. Never expose its results unfiltered. */
export function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

export interface AuthedUser {
  id: string;
  email: string | undefined;
  tier: string;
  status: string;
  limits: {
    max_saved_searches: number;
    min_poll_seconds: number;
    daily_api_calls: number;
    auctions_enabled: boolean;
    deal_score_enabled: boolean;
    portfolio_enabled: boolean;
  };
}

// plan_limits only changes when pricing changes — cache the whole table (3
// rows) per isolate so requireSubscriber costs two round trips, not three.
type PlanLimitsRow = AuthedUser["limits"] & { tier: string };
let planLimitsCache: { rows: PlanLimitsRow[]; expires: number } | null = null;

async function getPlanLimits(admin: SupabaseClient): Promise<PlanLimitsRow[] | null> {
  if (planLimitsCache && planLimitsCache.expires > Date.now()) return planLimitsCache.rows;
  const { data } = await admin.from("plan_limits").select("*");
  if (!data?.length) return planLimitsCache?.rows ?? null; // stale beats broken
  planLimitsCache = { rows: data as PlanLimitsRow[], expires: Date.now() + 300_000 };
  return planLimitsCache.rows;
}

/**
 * Validates the caller's JWT, loads their subscription + plan limits, and
 * rejects lapsed accounts. This is the paywall — every paid endpoint calls it.
 */
export async function requireSubscriber(req: Request): Promise<AuthedUser | Response> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "auth_required" }, 401);

  const admin = adminClient();
  const { data: userData, error } = await admin.auth.getUser(token);
  if (error || !userData?.user) return json({ error: "invalid_token" }, 401);
  const uid = userData.user.id;

  const { data: sub } = await admin
    .from("subscriptions")
    .select("tier, status, trial_ends_at, current_period_end")
    .eq("user_id", uid)
    .single();
  if (!sub) return json({ error: "no_subscription" }, 403);

  const now = new Date();
  const trialValid = sub.status === "trialing" && new Date(sub.trial_ends_at) > now;
  const paidValid = sub.status === "active" ||
    (sub.status === "past_due" && sub.current_period_end &&
      new Date(sub.current_period_end) > now); // grace period until period end
  if (!trialValid && !paidValid) return json({ error: "subscription_expired" }, 402);

  const limits = (await getPlanLimits(admin))?.find((l) => l.tier === sub.tier);
  if (!limits) return json({ error: "plan_misconfigured" }, 500);

  return { id: uid, email: userData.user.email, tier: sub.tier, status: sub.status, limits };
}

/** Atomic per-user daily quota check. Returns false when the ceiling is hit. */
export async function consumeQuota(uid: string, dailyCap: number): Promise<boolean> {
  const admin = adminClient();
  const { data, error } = await admin.rpc("increment_api_usage", {
    p_user_id: uid,
    p_cap: dailyCap,
  });
  if (error) {
    // Fail open on infra error but log — better UX than hard-failing search.
    console.error("quota rpc error", error);
    return true;
  }
  return data === true;
}

// ── eBay application token (client-credentials), cached in memory ────────────
let ebayToken: { value: string; expires: number } | null = null;

export async function getEbayAppToken(): Promise<string> {
  if (ebayToken && ebayToken.expires > Date.now() + 60_000) return ebayToken.value;
  const id = Deno.env.get("EBAY_CLIENT_ID")!;
  const secret = Deno.env.get("EBAY_CLIENT_SECRET")!;
  const env = Deno.env.get("EBAY_ENV") === "sandbox" ? "sandbox." : "";
  const res = await fetch(`https://api.${env}ebay.com/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(`${id}:${secret}`),
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    }),
  });
  if (!res.ok) throw new Error(`ebay token: ${res.status} ${await res.text()}`);
  const j = await res.json();
  ebayToken = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return ebayToken.value;
}

export function ebayApiBase(): string {
  return Deno.env.get("EBAY_ENV") === "sandbox"
    ? "https://api.sandbox.ebay.com"
    : "https://api.ebay.com";
}

// ── Mock eBay data (dev without API keys) ─────────────────────────────────────
// Active when EBAY_ENV=mock or no EBAY_CLIENT_ID secret is set. Lets the full
// pipeline (seen-diff, alerts, auctions, deal scores) run while waiting on
// eBay developer approval. Responses carry `mock: true` so synthetic data is
// never mistaken for live listings — set real keys before launch.
export function ebayMockMode(): boolean {
  return Deno.env.get("EBAY_ENV") === "mock" || !Deno.env.get("EBAY_CLIENT_ID");
}

function mockHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const MOCK_CONDITIONS = ["New", "Used", "Open box", "For parts or not working"];

function mockItem(keywords: string, id: string, n: number, auction: boolean, base: number) {
  const price = Math.round(base * (0.55 + ((n * 37) % 100) / 100) * 100) / 100;
  const endMin = 3 + ((n * 13) % 45);
  return {
    itemId: `v1|mock${id}|0`,
    legacyItemId: `mock${id}`,
    title: `${keywords} ${["lot", "bundle", "collection", "set", ""][n % 5]} #${id}`
      .replace(/\s+/g, " ").trim(),
    price: auction ? null : price,
    currency: "USD",
    image: `https://picsum.photos/seed/fw${id}/200`,
    url: `https://www.ebay.com/itm/mock${id}`,
    seller: `mock_seller_${n % 7}`,
    sellerFeedback: 50 + ((n * 91) % 5000),
    sellerPct: 95 + ((n * 3) % 5),
    condition: MOCK_CONDITIONS[n % MOCK_CONDITIONS.length],
    buyingOptions: auction ? ["AUCTION"] : ["FIXED_PRICE"],
    bidCount: auction ? n % 12 : null,
    currentBid: auction ? Math.round(price * 0.6 * 100) / 100 : null,
    endTime: auction ? new Date(Date.now() + endMin * 60_000).toISOString() : null,
    creationTime: new Date(Date.now() - n * 300_000).toISOString(),
    location: "US",
  };
}

/** Synthetic Browse-API-shaped items, already in ebay-search's response shape.
 *  A fresh item id rotates in every ~40s so consecutive polls see "new"
 *  listings and the seen-diff/alert plumbing gets exercised. */
export function mockSearchItems(
  keywords: string,
  opts: { auctions?: boolean; limit?: number } = {},
) {
  const base = 20 + (mockHash(keywords) % 180);
  const bucket = Math.floor(Date.now() / 40_000);
  const items = [];
  for (let i = 0; i < 6; i++) { // rotating "new" listings, newest first
    items.push(mockItem(
      keywords, String((bucket - i) % 100000), bucket - i,
      !!opts.auctions && i % 2 === 0, base,
    ));
  }
  const stable = mockHash(keywords) % 997;
  for (let n = 1; n <= 14; n++) { // stable back-catalog
    items.push(mockItem(
      keywords, `s${stable}${n}`, n, !!opts.auctions && n % 3 === 0, base,
    ));
  }
  return items.slice(0, opts.limit ?? 20);
}
