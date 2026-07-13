// POST /functions/v1/deal-score
// Scores a listing against the current market: fetches comparable active
// listings for the same query and reports where this price sits.
//
// Body: { keywords: string, price: number, conditionIds?: string[] }
// →    { score: 0-100, median, sampleSize, percentile, verdict }
//
// Note: true "sold comps" need the Marketplace Insights API (restricted access,
// apply once you have traction — see docs/ROADMAP.md). Active-listing comps are
// a solid v1 proxy: a listing priced far under the active median is a deal.
import {
  consumeQuota, ebayApiBase, ebayMockMode, getEbayAppToken, json, mockSearchItems,
  preflight, requireSubscriber,
} from "../_shared/mod.ts";

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const auth = await requireSubscriber(req);
  if (auth instanceof Response) return auth;
  if (!auth.limits.deal_score_enabled) {
    return json({ error: "plan_upgrade_required", feature: "deal_score" }, 403);
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const keywords = String(body.keywords ?? "").trim();
  const price = Number(body.price);
  if (!keywords || !isFinite(price) || price <= 0) {
    return json({ error: "keywords_and_price_required" }, 400);
  }
  if (!(await consumeQuota(auth.id, auth.limits.daily_api_calls))) {
    return json({ error: "daily_quota_exceeded" }, 429);
  }

  let rawComps: number[];
  if (ebayMockMode()) {
    // No eBay keys configured — comps come from the same synthetic generator
    // as ebay-search, so mock scores stay consistent with the mock feed.
    rawComps = mockSearchItems(keywords, { limit: 50 }).map((it) => it.price ?? NaN);
  } else {
    const filters = ["buyingOptions:{FIXED_PRICE}", "itemLocationCountry:US"];
    const conditionIds = Array.isArray(body.conditionIds)
      ? body.conditionIds.map(String).filter((s: string) => /^\d+$/.test(s)) : [];
    if (conditionIds.length) {
      filters.push(`conditionIds:{${conditionIds.join("|")}}`);
    }
    // Default (best-match) sort: sorting by price would sample only the 50
    // cheapest of possibly thousands of actives, dragging the median far below
    // the real market and skewing every verdict toward "overpriced".
    const params = new URLSearchParams({
      q: keywords, limit: "50", filter: filters.join(","),
    });
    let token: string;
    try { token = await getEbayAppToken(); } catch (e) {
      console.error("ebay token error", e);
      return json({ error: "ebay_auth_failed", detail: String((e as Error).message).slice(0, 300) }, 502);
    }
    const res = await fetch(
      `${ebayApiBase()}/buy/browse/v1/item_summary/search?${params}`,
      { headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" } },
    );
    if (!res.ok) return json({ error: "ebay_upstream", status: res.status }, 502);
    const data = await res.json();
    rawComps = (data.itemSummaries ?? [])
      .map((it: any) => (it.price ? Number(it.price.value) : NaN));
  }

  const comps = rawComps
    .filter((v: number) => isFinite(v) && v > 0)
    .sort((a: number, b: number) => a - b);

  if (comps.length < 5) {
    return json({ score: null, verdict: "insufficient_comps", sampleSize: comps.length });
  }

  // Trim the top/bottom 10% to blunt junk listings and outliers.
  const trim = Math.floor(comps.length * 0.1);
  const trimmed = comps.slice(trim, comps.length - trim || undefined);
  const median = trimmed[Math.floor(trimmed.length / 2)];
  const below = trimmed.filter((v: number) => v < price).length;
  const percentile = Math.round((below / trimmed.length) * 100);

  // Score: 100 = far below market, 50 = at median, 0 = far above.
  const ratio = price / median;
  const score = Math.max(0, Math.min(100, Math.round(100 - ratio * 50)));
  const verdict =
    ratio <= 0.6 ? "steal" :
    ratio <= 0.8 ? "great" :
    ratio <= 1.0 ? "fair" :
    ratio <= 1.2 ? "above_market" : "overpriced";

  return json({
    score, median, percentile, sampleSize: trimmed.length, verdict,
    mock: ebayMockMode(),
  });
});
