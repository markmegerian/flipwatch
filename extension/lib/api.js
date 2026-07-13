// Flipwatch backend client — auth, search proxy, saved data. No frameworks.
import { ANON_HEADERS, AUTH_URL, FUNCTIONS_URL, REST_URL } from "./endpoints.js";

// ── Session management ────────────────────────────────────────────────────────
// Supabase JWTs expire (default 1h); we store the refresh token and renew.

export async function getSession() {
  const { fw_session } = await chrome.storage.local.get("fw_session");
  return fw_session ?? null;
}

async function setSession(session) {
  if (session) {
    await chrome.storage.local.set({
      fw_session: {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at ??
          Math.floor(Date.now() / 1000) + (session.expires_in ?? 3600),
        user: { id: session.user?.id, email: session.user?.email },
      },
    });
  } else {
    await chrome.storage.local.remove("fw_session");
  }
}

export async function signUp(email, password) {
  const res = await fetch(`${AUTH_URL}/signup`, {
    method: "POST",
    headers: ANON_HEADERS,
    body: JSON.stringify({ email, password }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.msg || j.error_description || "Sign-up failed");
  if (j.access_token) await setSession(j);
  return j;
}

export async function signIn(email, password) {
  const res = await fetch(`${AUTH_URL}/token?grant_type=password`, {
    method: "POST",
    headers: ANON_HEADERS,
    body: JSON.stringify({ email, password }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.msg || j.error_description || "Sign-in failed");
  await setSession(j);
  return j;
}

export async function signOut() {
  await setSession(null);
}

async function freshAccessToken() {
  const s = await getSession();
  if (!s) throw new AuthError("signed_out");
  if (s.expires_at - 60 > Date.now() / 1000) return s.access_token;
  const res = await fetch(`${AUTH_URL}/token?grant_type=refresh_token`, {
    method: "POST",
    headers: ANON_HEADERS,
    body: JSON.stringify({ refresh_token: s.refresh_token }),
  });
  if (!res.ok) { await setSession(null); throw new AuthError("session_expired"); }
  const j = await res.json();
  await setSession(j);
  return j.access_token;
}

export class AuthError extends Error {}
export class PlanError extends Error {
  constructor(code, feature) { super(code); this.feature = feature; }
}

async function authedFetch(url, opts = {}) {
  const token = await freshAccessToken();
  const res = await fetch(url, {
    ...opts,
    headers: {
      ...ANON_HEADERS,
      ...opts.headers,
      Authorization: `Bearer ${token}`,
    },
  });
  if (res.status === 401) { throw new AuthError("unauthorized"); }
  if (res.status === 402) { throw new PlanError("subscription_expired"); }
  if (res.status === 403) {
    const j = await res.json().catch(() => ({}));
    throw new PlanError(j.error ?? "forbidden", j.feature);
  }
  return res;
}

// ── Edge functions ────────────────────────────────────────────────────────────

export async function searchEbay(params) {
  const res = await authedFetch(`${FUNCTIONS_URL}/ebay-search`, {
    method: "POST",
    body: JSON.stringify(params),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? `search failed (${res.status})`);
  return j;
}

export async function dealScore(keywords, price, conditionIds) {
  const res = await authedFetch(`${FUNCTIONS_URL}/deal-score`, {
    method: "POST",
    body: JSON.stringify({ keywords, price, conditionIds }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? `deal-score failed (${res.status})`);
  return j;
}

export async function createCheckout(tier) {
  const res = await authedFetch(`${FUNCTIONS_URL}/stripe-checkout`, {
    method: "POST",
    body: JSON.stringify({ tier }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? "checkout failed");
  return j.url;
}

// ── PostgREST (RLS-protected tables) ─────────────────────────────────────────

async function rest(path, { headers, ...opts } = {}) {
  const res = await authedFetch(`${REST_URL}${path}`, {
    ...opts,
    headers: { Prefer: "return=representation", ...headers },
  });
  if (!res.ok) throw new Error(`db error ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

export const db = {
  // subscription + plan
  mySubscription: () => rest(`/subscriptions?select=tier,status,trial_ends_at,current_period_end`),
  planLimits: () => rest(`/plan_limits?select=*`),

  // saved searches
  listSearches: () => rest(`/saved_searches?select=*&order=created_at.asc`),
  createSearch: (s) => rest(`/saved_searches`, { method: "POST", body: JSON.stringify(s) }),
  updateSearch: (id, patch) =>
    rest(`/saved_searches?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteSearch: (id) => rest(`/saved_searches?id=eq.${id}`, { method: "DELETE" }),

  // saved listings
  listSaved: () => rest(`/saved_listings?select=*&order=saved_at.desc`),
  saveListing: (l) => rest(`/saved_listings?on_conflict=user_id,item_id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(l),
  }),
  unsaveListing: (id) => rest(`/saved_listings?id=eq.${id}`, { method: "DELETE" }),
  clearSaved: () => rest(`/saved_listings?id=not.is.null`, { method: "DELETE" }),

  // portfolio
  listPortfolio: () => rest(`/portfolio_entries?select=*&order=bought_at.desc`),
  addPortfolio: (e) => rest(`/portfolio_entries`, { method: "POST", body: JSON.stringify(e) }),
  updatePortfolio: (id, patch) =>
    rest(`/portfolio_entries?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deletePortfolio: (id) => rest(`/portfolio_entries?id=eq.${id}`, { method: "DELETE" }),

  // snipes
  listSnipes: () => rest(`/snipes?select=*&order=end_time.asc`),
  addSnipe: (s) => rest(`/snipes?on_conflict=user_id,item_id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(s),
  }),
  updateSnipe: (id, patch) =>
    rest(`/snipes?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteSnipe: (id) => rest(`/snipes?id=eq.${id}`, { method: "DELETE" }),
};
