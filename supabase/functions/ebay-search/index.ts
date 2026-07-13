// POST /functions/v1/ebay-search
// The only code that talks to eBay. Proxies the Browse API item_summary/search
// with the app token, enforces plan limits, and (optionally) diffs against the
// caller's seen-set so the response contains a ready-made `newItems` array.
//
// Body: {
//   searchId?: string,          // saved_searches.id → server-side seen dedup
//   keywords: string,
//   priceMin?: number, priceMax?: number,
//   buyingOptions?: string[],   // ["FIXED_PRICE"] | ["AUCTION"] | ...
//   usOnly?: boolean,
//   categoryIds?: string[], conditionIds?: string[],
//   blockedSellers?: string[],
//   sort?: "newlyListed" | "endingSoonest" | "price",
//   limit?: number              // ≤ 60
// }
import {
  adminClient, consumeQuota, ebayApiBase, ebayMockMode, getEbayAppToken,
  json, mockSearchItems, preflight, requireSubscriber,
} from "../_shared/mod.ts";

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const auth = await requireSubscriber(req);
  if (auth instanceof Response) return auth;

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const keywords = String(body.keywords ?? "").trim();
  if (!keywords) return json({ error: "keywords_required" }, 400);

  const wantsAuctions = (body.buyingOptions ?? []).includes("AUCTION");
  if (wantsAuctions && !auth.limits.auctions_enabled) {
    return json({ error: "plan_upgrade_required", feature: "auctions" }, 403);
  }
  if (!(await consumeQuota(auth.id, auth.limits.daily_api_calls))) {
    return json({ error: "daily_quota_exceeded" }, 429);
  }

  const buying = (body.buyingOptions?.length ? body.buyingOptions : ["FIXED_PRICE"])
    .filter((b: string) => ["FIXED_PRICE", "AUCTION", "BEST_OFFER"].includes(b));
  const limit = Math.min(Math.max(Math.trunc(Number(body.limit)) || 60, 1), 60);
  // Coerce prices once; drop NaN/negatives so a bad value can't reach the
  // filter expression as "price:[NaN..]" and 400 the upstream call.
  const num = (v: unknown) =>
    v == null || v === "" || !isFinite(Number(v)) || Number(v) < 0 ? null : Number(v);
  const priceMin = num(body.priceMin);
  const priceMax = num(body.priceMax);
  // Category/condition ids are numeric — strip anything that could mangle the
  // comma/brace-delimited filter string.
  const idList = (v: unknown) =>
    Array.isArray(v) ? v.map(String).filter((s) => /^\d+$/.test(s)) : [];
  const categoryIds = idList(body.categoryIds);
  const conditionIds = idList(body.conditionIds);
  const blocked = new Set(
    (body.blockedSellers ?? []).map((s: string) => s.toLowerCase()),
  );

  let items: any[];
  let upstreamTotal: number | null = null;
  if (ebayMockMode()) {
    // No eBay keys configured — synthetic listings keep the pipeline testable.
    items = mockSearchItems(keywords, { auctions: buying.includes("AUCTION"), limit })
      .filter((it) =>
        !blocked.has((it.seller ?? "").toLowerCase()) &&
        (priceMin == null || it.price == null || it.price >= priceMin) &&
        (priceMax == null || it.price == null || it.price <= priceMax));
  } else {
    // ── Build Browse API request ──────────────────────────────────────────────
    const filters: string[] = [];
    filters.push(`buyingOptions:{${buying.join("|")}}`);
    if (priceMin != null || priceMax != null) {
      filters.push(`price:[${priceMin ?? ""}..${priceMax ?? ""}]`, "priceCurrency:USD");
    }
    if (body.usOnly !== false) filters.push("itemLocationCountry:US");
    if (conditionIds.length) filters.push(`conditionIds:{${conditionIds.join("|")}}`);

    const params = new URLSearchParams({
      q: keywords,
      limit: String(limit),
      sort: ["newlyListed", "endingSoonest", "price"].includes(body.sort)
        ? body.sort : "newlyListed",
      filter: filters.join(","),
    });
    if (categoryIds.length) params.set("category_ids", categoryIds.join(","));

    // Token failures (bad credentials, keyset not yet compliant) must come back
    // as clean JSON, not an unhandled throw — the extension needs the reason.
    let token: string;
    try { token = await getEbayAppToken(); } catch (e) {
      console.error("ebay token error", e);
      return json({ error: "ebay_auth_failed", detail: String((e as Error).message).slice(0, 300) }, 502);
    }
    const res = await fetch(
      `${ebayApiBase()}/buy/browse/v1/item_summary/search?${params}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
          "X-EBAY-C-ENDUSERCTX": "contextualLocation=country=US",
        },
      },
    );
    if (!res.ok) {
      const detail = await res.text();
      console.error("browse api error", res.status, detail);
      return json({ error: "ebay_upstream", status: res.status }, 502);
    }
    const data = await res.json();
    upstreamTotal = data.total ?? null;

    items = (data.itemSummaries ?? [])
      .filter((it: any) => !blocked.has((it.seller?.username ?? "").toLowerCase()))
      .map((it: any) => ({
        itemId: it.itemId,
        legacyItemId: it.legacyItemId,
        title: it.title,
        price: it.price ? Number(it.price.value) : null,
        currency: it.price?.currency ?? "USD",
        image: it.image?.imageUrl ?? it.thumbnailImages?.[0]?.imageUrl ?? null,
        url: it.itemWebUrl,
        seller: it.seller?.username ?? null,
        sellerFeedback: it.seller?.feedbackScore ?? null,
        sellerPct: it.seller?.feedbackPercentage ?? null,
        condition: it.condition ?? null,
        buyingOptions: it.buyingOptions ?? [],
        bidCount: it.bidCount ?? null,
        currentBid: it.currentBidPrice ? Number(it.currentBidPrice.value) : null,
        endTime: it.itemEndDate ?? null,
        creationTime: it.itemCreationDate ?? null,
        location: it.itemLocation?.country ?? null,
      }));
  }

  // Collapse content-identical listings — rampant in sandbox seed data, and
  // real bulk relists in production. One representative row (first in sort
  // order) keeps the feed and notifications sane; dedup happens before the
  // seen-diff so alerts can't fire 50 times for the same content.
  const contentKeys = new Set<string>();
  items = items.filter((it: any) => {
    const key = `${it.title}|${it.price}|${it.currentBid}|${it.seller}|${it.condition}`;
    if (contentKeys.has(key)) return false;
    contentKeys.add(key);
    return true;
  });

  // ── Server-side seen diff (replaces localStorage ebm_seen_v2) ───────────────
  let newItems: string[] | null = null;
  if (body.searchId) {
    const admin = adminClient();
    const ids = items.map((i: any) => i.itemId);
    // Ownership check and seen lookup are independent — run them together and
    // only act on the seen-set if the search belongs to the caller.
    const [{ data: owned }, { data: seen }] = await Promise.all([
      admin.from("saved_searches").select("id")
        .eq("id", body.searchId).eq("user_id", auth.id).maybeSingle(),
      admin.from("seen_items").select("item_id")
        .eq("search_id", body.searchId).in("item_id", ids.length ? ids : ["-"]),
    ]);
    if (owned) {
      const seenSet = new Set((seen ?? []).map((r) => r.item_id));
      const isBaseline = seenSet.size === 0 &&
        (await admin.from("seen_items").select("item_id", { count: "exact", head: true })
          .eq("search_id", body.searchId)).count === 0;
      newItems = isBaseline ? [] : ids.filter((id: string) => !seenSet.has(id));
      const unseenRows = ids
        .filter((id: string) => !seenSet.has(id))
        .map((id: string) => ({ search_id: body.searchId, item_id: id }));
      if (unseenRows.length) {
        await admin.from("seen_items").upsert(unseenRows, { ignoreDuplicates: true });
      }
    }
  }

  return json({
    total: upstreamTotal ?? items.length,
    items,
    newItems, // null when no searchId given; [] on first-poll baseline
    tier: auth.tier,
    mock: ebayMockMode(),
  });
});
