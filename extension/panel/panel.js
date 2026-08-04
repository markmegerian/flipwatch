// Flipwatch side panel controller.
import { AuthError, PlanError, db, dealScore, getSession, searchEbay } from "../lib/api.js";
import {
  applyExclusions, compQuery, composeQuery, conditionIdsFor, describeQuery,
  ebayQuery, parseQuery,
} from "../lib/query.js";

const $ = (id) => document.getElementById(id);
const state = {
  searches: [],
  feed: [],
  saved: [],
  savedByItem: new Map(),
  snipes: [],
  portfolio: [],
  sub: null,
  limits: [],
  feedFilter: "",
  searchFilter: "",
};

// ── Utilities ─────────────────────────────────────────────────────────────────

let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2200);
}

const fmt$ = (v) =>
  v == null ? "—" : Number(v).toLocaleString("en-US", { style: "currency", currency: "USD" });

function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function countdownText(endTime) {
  const ms = new Date(endTime).getTime() - Date.now();
  if (ms <= 0) return { text: "ended", urgent: false, ended: true };
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
    m = Math.floor((s % 3600) / 60), sec = s % 60;
  const text = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m ${sec}s`;
  return { text, urgent: s < 120, ended: false };
}

function planAllows(feature) {
  if (!state.sub) return false;
  const lim = state.limits.find((l) => l.tier === state.sub.tier);
  return lim ? !!lim[feature] : false;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  const session = await getSession();
  if (!session) return showGate("Sign in to start monitoring");

  try {
    const [subs, limits] = await Promise.all([db.mySubscription(), db.planLimits()]);
    state.sub = subs?.[0] ?? null;
    state.limits = limits ?? [];
  } catch (e) {
    if (e instanceof AuthError) return showGate("Session expired — sign in again");
    console.warn(e);
  }

  const chip = $("plan-chip");
  if (state.sub) {
    const expired =
      (state.sub.status === "trialing" && new Date(state.sub.trial_ends_at) < new Date()) ||
      state.sub.status === "canceled";
    chip.hidden = false;
    chip.textContent = expired ? "expired" : state.sub.tier;
    chip.className = "chip" + (expired ? " expired" : state.sub.tier === "pro" ? " pro" : "");
    if (expired) {
      return showGate("Your subscription has ended", "Renew to keep monitoring — your data is safe.");
    }
  }

  $("gate").hidden = true;
  $("app").hidden = false;
  $("hdr-status").textContent = session.user?.email ?? "";

  await Promise.all([loadSearches(), loadFeedFromCache(), loadSaved(), loadSnipes()]);
  renderAll();
  chrome.runtime.sendMessage({ type: "resync" }).catch(() => {});
}

function showGate(title, text) {
  $("gate").hidden = false;
  $("app").hidden = true;
  $("gate-title").textContent = title;
  if (text) $("gate-text").textContent = text;
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadSearches() {
  try { state.searches = await db.listSearches(); } catch { state.searches = []; }
}
async function loadFeedFromCache() {
  const { fw_feed = [] } = await chrome.storage.local.get("fw_feed");
  state.feed = fw_feed;
}
async function loadSaved() {
  try {
    state.saved = await db.listSaved();
    state.savedByItem = new Map(state.saved.map((s) => [s.item_id, s]));
  } catch { state.saved = []; }
}
async function loadSnipes() {
  try { state.snipes = (await db.listSnipes()).filter((s) => s.status === "armed"); }
  catch { state.snipes = []; }
}
async function loadPortfolio() {
  try { state.portfolio = await db.listPortfolio(); } catch { state.portfolio = []; }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderAll() {
  renderSearchChips();
  renderFeed();
  renderAuctions();
  renderSaved();
}

function renderSearchChips() {
  const wrap = $("search-chips");
  wrap.textContent = "";
  const sel = $("search-filter");
  sel.length = 1;
  for (const s of state.searches) {
    const chip = document.createElement("button");
    chip.className = "schip" + (s.active ? "" : " paused");
    chip.innerHTML = `<span class="dot"></span>`;
    chip.append(s.label);
    chip.title = "Click to edit";
    chip.addEventListener("click", () => openSearchForm(s));
    wrap.append(chip);
    sel.add(new Option(s.label, s.id));
  }
  // Rebuilding the <select> above resets it to "All searches" while
  // state.searchFilter still points at the previously chosen search — so the
  // feed stays filtered by something the UI no longer displays, and looks
  // empty until you touch the dropdown. Re-sync, dropping the filter if that
  // search no longer exists.
  if (state.searchFilter && !state.searches.some((s) => s.id === state.searchFilter)) {
    state.searchFilter = "";
  }
  sel.value = state.searchFilter;
}

function makeCard(item, opts = {}) {
  const node = $("tpl-card").content.firstElementChild.cloneNode(true);
  const img = node.querySelector(".c-img");
  if (item.image) img.src = item.image; else img.remove();
  node.querySelector(".c-title").textContent = item.title ?? "(untitled)";
  node.querySelector(".c-price").textContent =
    item.currentBid != null ? `${fmt$(item.currentBid)} bid` : fmt$(item.price);
  node.querySelector(".c-seller").textContent = item.seller
    ? `${item.seller}${item.sellerFeedback != null ? ` (${item.sellerFeedback})` : ""}` : "";
  node.querySelector(".c-new").hidden = !item.isNew;
  const sub = node.querySelector(".c-sub");
  sub.textContent = opts.subText ?? [
    item.searchLabel, item.fetchedAt ? timeAgo(item.fetchedAt) : null,
  ].filter(Boolean).join(" · ");

  const actions = node.querySelector(".c-actions");
  const open = document.createElement("a");
  open.className = "act-open";
  open.textContent = "Open";
  open.href = item.url ?? "#";
  open.target = "_blank";
  actions.append(open);

  if (!opts.noSave) {
    const save = document.createElement("button");
    const isSaved = state.savedByItem.has(item.itemId);
    save.className = "act-save" + (isSaved ? " saved" : "");
    save.textContent = isSaved ? "✓ Saved" : "Save";
    save.addEventListener("click", () => toggleSave(item, save));
    actions.append(save);
  }

  if (!opts.noScore && planAllows("deal_score_enabled")) {
    const score = document.createElement("button");
    score.textContent = "Score";
    score.addEventListener("click", () => scoreCard(item, node, score));
    actions.append(score);
  }

  if (opts.auction) {
    const cd = document.createElement("span");
    cd.className = "countdown";
    cd.dataset.end = item.endTime;
    node.querySelector(".c-meta").append(cd);

    const snipe = document.createElement("button");
    const armed = state.snipes.find((s) => s.item_id === item.itemId);
    snipe.className = "act-snipe" + (armed ? " armed" : "");
    snipe.textContent = armed ? `Armed ${fmt$(armed.max_bid)}` : "🎯 Snipe";
    snipe.addEventListener("click", () => toggleSnipe(item, snipe));
    actions.append(snipe);
  }
  return node;
}

function renderFeed() {
  const list = $("feed-list");
  list.textContent = "";
  const q = state.feedFilter.toLowerCase();
  const items = state.feed.filter((i) =>
    (!state.searchFilter || i.searchId === state.searchFilter) &&
    (!q || (i.title ?? "").toLowerCase().includes(q)) &&
    !(i.buyingOptions ?? []).includes("AUCTION"),
  );
  $("feed-empty").style.display = items.length ? "none" : "block";
  const frag = document.createDocumentFragment();
  for (const item of items.slice(0, 100)) frag.append(makeCard(item));
  list.append(frag);
}

function renderAuctions() {
  const allowed = planAllows("auctions_enabled");
  $("auction-upsell").hidden = allowed;
  const list = $("auction-list");
  list.textContent = "";

  const queue = $("snipe-queue");
  if (state.snipes.length) {
    queue.hidden = false;
    $("snipe-queue-list").textContent = state.snipes
      .map((s) => `${fmt$(s.max_bid)} — ${(s.title ?? s.item_id).slice(0, 40)}`)
      .join(" · ");
  } else queue.hidden = true;

  if (!allowed) { $("auction-empty").style.display = "none"; return; }

  const items = state.feed
    .filter((i) => (i.buyingOptions ?? []).includes("AUCTION") && i.endTime)
    .sort((a, b) => new Date(a.endTime) - new Date(b.endTime));
  $("auction-empty").style.display = items.length ? "none" : "block";
  const frag = document.createDocumentFragment();
  for (const item of items.slice(0, 60)) frag.append(makeCard(item, { auction: true }));
  list.append(frag);
  tickCountdowns();
}

let cdTimer = null;
function tickCountdowns() {
  clearInterval(cdTimer);
  cdTimer = setInterval(() => {
    document.querySelectorAll(".countdown").forEach((el) => {
      const { text, urgent, ended } = countdownText(el.dataset.end);
      el.textContent = ended ? "ended" : `⏱ ${text}`;
      el.classList.toggle("urgent", urgent);
    });
  }, 1000);
}

function renderSaved() {
  const list = $("saved-list");
  list.textContent = "";
  $("saved-empty").style.display = state.saved.length ? "none" : "block";
  $("btn-clear-saved").hidden = !state.saved.length;
  for (const s of state.saved) {
    const item = {
      itemId: s.item_id, title: s.title, price: s.price,
      image: s.image_url, url: s.item_url, seller: s.seller,
    };
    const card = makeCard(item, {
      noSave: true,
      subText: `saved ${timeAgo(new Date(s.saved_at).getTime())}`,
    });
    const rm = document.createElement("button");
    rm.textContent = "Remove";
    rm.addEventListener("click", async () => {
      await db.unsaveListing(s.id);
      await loadSaved();
      renderSaved(); renderFeed();
    });
    const buy = document.createElement("button");
    buy.textContent = "→ Portfolio";
    buy.title = "Mark as purchased";
    buy.addEventListener("click", async () => {
      await db.addPortfolio({
        title: s.title, item_id: s.item_id, item_url: s.item_url,
        image_url: s.image_url, buy_price: s.price,
      });
      toast("Added to portfolio");
    });
    card.querySelector(".c-actions").append(buy, rm);
    list.append(card);
  }
}

function renderPortfolio() {
  const list = $("pf-list");
  list.textContent = "";
  $("pf-empty").style.display = state.portfolio.length ? "none" : "block";

  let invested = 0, realized = 0, open = 0;
  for (const e of state.portfolio) {
    const cost = (Number(e.buy_price) || 0) + (Number(e.fees) || 0) + (Number(e.shipping) || 0);
    if (e.sold_price != null) realized += Number(e.sold_price) - cost;
    else { invested += cost; open++; }
  }
  $("pf-invested").textContent = fmt$(invested);
  const r = $("pf-realized");
  r.textContent = (realized >= 0 ? "+" : "") + fmt$(realized).replace("-", "−");
  r.className = "v " + (realized > 0 ? "pos" : realized < 0 ? "neg" : "");
  $("pf-open").textContent = String(open);

  for (const e of state.portfolio) {
    const cost = (Number(e.buy_price) || 0) + (Number(e.fees) || 0) + (Number(e.shipping) || 0);
    const soldTxt = e.sold_price != null
      ? `sold ${fmt$(e.sold_price)} → ${Number(e.sold_price) - cost >= 0 ? "+" : ""}${fmt$(Number(e.sold_price) - cost)}`
      : "open";
    const card = makeCard(
      { itemId: e.item_id, title: e.title, price: e.buy_price, image: e.image_url, url: e.item_url },
      { noSave: true, noScore: true, subText: `${soldTxt} · cost ${fmt$(cost)}` },
    );
    const edit = document.createElement("button");
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openPfForm(e));
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      await db.deletePortfolio(e.id);
      await loadPortfolio(); renderPortfolio();
    });
    card.querySelector(".c-actions").append(edit, del);
    list.append(card);
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function toggleSave(item, btn) {
  try {
    const existing = state.savedByItem.get(item.itemId);
    if (existing) {
      await db.unsaveListing(existing.id);
      toast("Removed from saved");
    } else {
      await db.saveListing({
        item_id: item.itemId, title: item.title, price: item.price,
        image_url: item.image, item_url: item.url, seller: item.seller,
      });
      toast("Saved");
    }
    await loadSaved();
    btn.classList.toggle("saved", state.savedByItem.has(item.itemId));
    btn.textContent = state.savedByItem.has(item.itemId) ? "✓ Saved" : "Save";
    renderSaved();
  } catch (e) { toast(e.message); }
}

async function scoreCard(item, node, btn) {
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const isAuction = item.currentBid != null ||
      (item.buyingOptions ?? []).includes("AUCTION");
    const price = item.currentBid ?? item.price;
    // Compare like with like: a distilled product query, and the same
    // condition bucket. Passing the raw title scored every listing against a
    // different comp set, which is what made scores look arbitrary.
    const r = await dealScore(compQuery(item.title), price, conditionIdsFor(item.condition));
    const badge = node.querySelector(".c-score");
    badge.hidden = false;
    if (r.score == null) {
      badge.textContent = r.sampleSize ? `only ${r.sampleSize} comps` : "no comps";
      badge.className = "c-score mid";
    } else {
      // Comps are Buy It Now, so a mid-auction bid is not a like-for-like
      // price — say so rather than calling every live auction a steal.
      badge.textContent = isAuction
        ? `bid is ${Math.round((price / r.median) * 100)}% of BIN median ${fmt$(r.median)}`
        : `${r.verdict.replace("_", " ")} · median ${fmt$(r.median)} (${r.sampleSize} comps)`;
      badge.className = "c-score " + (isAuction ? "mid"
        : r.verdict === "steal" || r.verdict === "great" ? "good"
          : r.verdict === "fair" ? "mid" : "bad");
    }
    btn.remove();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Score";
    toast(e instanceof PlanError ? "Upgrade to Pro for deal scores" : e.message);
  }
}

async function toggleSnipe(item, btn) {
  const armed = state.snipes.find((s) => s.item_id === item.itemId);
  try {
    if (armed) {
      await db.updateSnipe(armed.id, { status: "canceled" });
      await chrome.runtime.sendMessage({ type: "cancel-snipe", snipeId: armed.id });
      toast("Snipe canceled");
    } else {
      const amt = parseFloat(prompt(
        `Max bid for:\n${item.title}\n\nAt T-minus 20s Flipwatch opens the listing and reminds you to place this bid. You place it yourself.`,
        item.currentBid ? String(Math.ceil(item.currentBid * 1.15)) : "",
      ));
      if (!isFinite(amt) || amt <= 0) return;
      const rows = await db.addSnipe({
        item_id: item.itemId, title: item.title, item_url: item.url,
        max_bid: amt, end_time: item.endTime, lead_seconds: 20, status: "armed",
      });
      await chrome.runtime.sendMessage({ type: "schedule-snipe", snipe: rows[0] });
      toast(`Snipe armed at ${fmt$(amt)}`);
    }
    await loadSnipes();
    renderAuctions();
  } catch (e) { toast(e.message); }
}

// ── Search form ───────────────────────────────────────────────────────────────

// ── Listing-type segmented control ────────────────────────────────────────────
// A <select> silently renders blank when the stored value isn't one of its
// options (e.g. a search containing BEST_OFFER), and then saves an empty
// buying_options that breaks the search. A segmented control can't do that:
// anything unrecognised falls back to a valid selection.
function setTypeSeg(buyingOptions) {
  const want = (buyingOptions?.length ? buyingOptions : ["FIXED_PRICE"]).slice().sort().join(",");
  const btns = [...$("sf-type").querySelectorAll("button")];
  const match = btns.find((b) => b.dataset.v.split(",").slice().sort().join(",") === want);
  const chosen = match ?? btns[0];
  for (const b of btns) b.classList.toggle("on", b === chosen);
}
function getTypeSeg() {
  const on = $("sf-type").querySelector("button.on");
  return (on?.dataset.v ?? "FIXED_PRICE").split(",");
}
$("sf-type").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  for (const x of $("sf-type").querySelectorAll("button")) x.classList.toggle("on", x === b);
});

function setConditions(ids) {
  const have = new Set((ids ?? []).map(String));
  for (const cb of $("sf-cond").querySelectorAll("input")) {
    cb.checked = cb.value.split(",").some((v) => have.has(v));
  }
}
function getConditions() {
  const out = [];
  for (const cb of $("sf-cond").querySelectorAll("input")) {
    if (cb.checked) out.push(...cb.value.split(","));
  }
  return out;
}

function openSearchForm(s) {
  $("search-form").hidden = false;
  $("sf-preview").hidden = true;
  const q = parseQuery(s?.keywords ?? "");
  $("sf-id").value = s?.id ?? "";
  $("sf-label").value = s?.label ?? "";
  $("sf-keywords").value = q.base;
  $("sf-any").value = q.anyOf.join(", ");
  $("sf-not").value = q.exclude.join(", ");
  $("sf-min").value = s?.price_min ?? "";
  $("sf-max").value = s?.price_max ?? "";
  setTypeSeg(s?.buying_options);
  setConditions(s?.condition_ids);
  // Same failure mode as the old type <select>: an unlisted value renders
  // blank. Snap to the closest offered interval instead.
  const poll = Number(s?.poll_seconds ?? 60);
  const opts = [...$("sf-poll").options].map((o) => Number(o.value));
  $("sf-poll").value = String(
    opts.includes(poll)
      ? poll
      : opts.reduce((a, b) => (Math.abs(b - poll) < Math.abs(a - poll) ? b : a)),
  );
  $("sf-us").checked = s?.us_only ?? true;
  $("sf-notify").checked = s?.notify ?? true;
  $("sf-active").checked = s?.active ?? true;
  $("sf-blocked").value = (s?.blocked_sellers ?? []).join(", ");
  $("sf-delete").hidden = !s;
}

const csv = (v) => v.split(",").map((x) => x.trim()).filter(Boolean);

/** Everything the form currently describes, in saved_searches shape. */
function readSearchForm() {
  const base = $("sf-keywords").value.trim();
  const anyOf = csv($("sf-any").value);
  const exclude = csv($("sf-not").value);
  const lim = state.limits.find((l) => l.tier === state.sub?.tier);
  return {
    // Name is optional — fall back to something recognisable rather than
    // making the user invent one.
    label: $("sf-label").value.trim() || (base || anyOf[0] || "New search").slice(0, 40),
    keywords: composeQuery({ base, anyOf, exclude }),
    price_min: $("sf-min").value ? Number($("sf-min").value) : null,
    price_max: $("sf-max").value ? Number($("sf-max").value) : null,
    buying_options: getTypeSeg(),
    condition_ids: getConditions().length ? getConditions() : null,
    poll_seconds: Math.max(parseInt($("sf-poll").value, 10), lim?.min_poll_seconds ?? 60),
    us_only: $("sf-us").checked,
    notify: $("sf-notify").checked,
    active: $("sf-active").checked,
    blocked_sellers: csv($("sf-blocked").value),
  };
}

/** Run the search as configured, without saving, so mistakes are obvious. */
async function testSearchForm() {
  const body = readSearchForm();
  const box = $("sf-preview");
  const btn = $("sf-test");
  if (!body.keywords) return toast("Type what you're looking for first");
  btn.disabled = true; btn.textContent = "Testing…";
  box.hidden = false; box.className = "preview"; box.textContent = "Searching eBay…";
  try {
    const res = await searchEbay({
      keywords: ebayQuery(body.keywords),          // exclusions aren't eBay syntax
      priceMin: body.price_min, priceMax: body.price_max,
      buyingOptions: body.buying_options, usOnly: body.us_only,
      conditionIds: body.condition_ids ?? undefined,
      blockedSellers: body.blocked_sellers, limit: 10,
    });
    const items = applyExclusions(body.keywords, res.items ?? []);
    box.textContent = "";
    const head = document.createElement("div");
    head.className = "pv-head";
    head.textContent = items.length
      ? `Found ${res.total ?? items.length} listings — newest few:`
      : "No listings matched. Try fewer words.";
    box.append(head);
    for (const it of items.slice(0, 3)) {
      const row = document.createElement("div");
      row.className = "pv-item";
      row.textContent = `• ${fmt$(it.currentBid ?? it.price)} — ${(it.title ?? "").slice(0, 64)}`;
      box.append(row);
    }
    const why = document.createElement("div");
    why.className = "pv-item";
    why.style.marginTop = "6px";
    why.textContent = describeQuery(parseQuery(body.keywords));
    box.append(why);
  } catch (e) {
    box.className = "preview bad";
    box.textContent = e instanceof PlanError
      ? "That needs a higher plan (auctions are Pro)."
      : `Couldn't test: ${e.message}`;
  } finally {
    btn.disabled = false; btn.textContent = "Test search";
  }
}

async function submitSearchForm(ev) {
  ev.preventDefault();
  const id = $("sf-id").value;
  const lim = state.limits.find((l) => l.tier === state.sub?.tier);
  const body = readSearchForm();
  if (body.poll_seconds !== parseInt($("sf-poll").value, 10)) {
    toast(`Your plan checks every ${body.poll_seconds}s at fastest`);
  }
  if (!id && lim && state.searches.length >= lim.max_saved_searches) {
    return toast(`Plan limit: ${lim.max_saved_searches} searches. Upgrade for more.`);
  }
  try {
    if (id) await db.updateSearch(id, body);
    else {
      await db.createSearch(body);
      // Show everything after adding a search, otherwise the feed stays
      // filtered to a different one and the new search looks broken.
      state.searchFilter = "";
    }
    $("search-form").hidden = true;
    await loadSearches();
    renderSearchChips();
    renderFeed();
    chrome.runtime.sendMessage({ type: "resync" }).catch(() => {});
    toast(id ? "Search updated" : "Search created — monitoring started");
  } catch (e) { toast(e.message); }
}

// ── Portfolio form ────────────────────────────────────────────────────────────

function openPfForm(e) {
  $("pf-form").hidden = false;
  $("pf-id").value = e?.id ?? "";
  $("pf-title").value = e?.title ?? "";
  $("pf-buy").value = e?.buy_price ?? "";
  $("pf-sold").value = e?.sold_price ?? "";
  $("pf-fees").value = e?.fees ?? "";
  $("pf-ship").value = e?.shipping ?? "";
  $("pf-url").value = e?.item_url ?? "";
}

async function submitPfForm(ev) {
  ev.preventDefault();
  const id = $("pf-id").value;
  const body = {
    title: $("pf-title").value.trim(),
    buy_price: $("pf-buy").value ? Number($("pf-buy").value) : null,
    sold_price: $("pf-sold").value ? Number($("pf-sold").value) : null,
    sold_at: $("pf-sold").value ? new Date().toISOString() : null,
    fees: $("pf-fees").value ? Number($("pf-fees").value) : 0,
    shipping: $("pf-ship").value ? Number($("pf-ship").value) : 0,
    item_url: $("pf-url").value.trim() || null,
  };
  try {
    if (id) await db.updatePortfolio(id, body);
    else await db.addPortfolio(body);
    $("pf-form").hidden = true;
    await loadPortfolio();
    renderPortfolio();
  } catch (e) { toast(e.message); }
}

// ── Wiring ────────────────────────────────────────────────────────────────────

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", async () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x === t));
    document.querySelectorAll(".pane").forEach((p) =>
      p.classList.toggle("on", p.id === `tab-${t.dataset.tab}`));
    if (t.dataset.tab === "portfolio") { await loadPortfolio(); renderPortfolio(); }
    if (t.dataset.tab === "saved") { await loadSaved(); renderSaved(); }
  }));

$("btn-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("gate-btn").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("btn-add-search").addEventListener("click", () => openSearchForm(null));
$("sf-cancel").addEventListener("click", () => ($("search-form").hidden = true));
$("sf-test").addEventListener("click", testSearchForm);
$("search-form").addEventListener("submit", submitSearchForm);
$("sf-delete").addEventListener("click", async () => {
  const id = $("sf-id").value;
  if (!id || !confirm("Delete this saved search?")) return;
  await db.deleteSearch(id);
  $("search-form").hidden = true;
  await loadSearches();
  renderSearchChips();
  chrome.runtime.sendMessage({ type: "resync" }).catch(() => {});
});
$("search-filter").addEventListener("change", (e) => {
  state.searchFilter = e.target.value; renderFeed();
});
let filterTimer = null;
$("feed-filter").addEventListener("input", (e) => {
  state.feedFilter = e.target.value;
  clearTimeout(filterTimer);
  filterTimer = setTimeout(renderFeed, 120); // don't rebuild 100 cards per keystroke
});
$("btn-clear-unseen").addEventListener("click", async () => {
  state.feed = state.feed.map((i) => ({ ...i, isNew: false }));
  await chrome.storage.local.set({ fw_feed: state.feed });
  chrome.runtime.sendMessage({ type: "clear-unseen" }).catch(() => {});
  renderFeed();
});
$("btn-clear-saved").addEventListener("click", async () => {
  if (!confirm("Remove all saved listings?")) return;
  await db.clearSaved();
  await loadSaved();
  renderSaved(); renderFeed();
});
$("btn-add-pf").addEventListener("click", () => openPfForm(null));
$("pf-cancel").addEventListener("click", () => ($("pf-form").hidden = true));
$("pf-form").addEventListener("submit", submitPfForm);
$("btn-upgrade-auction").addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "feed-updated") {
    loadFeedFromCache().then(() => { renderFeed(); renderAuctions(); });
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.fw_session) return;
  // fw_session also changes on hourly token refreshes — only re-boot (which
  // resets the whole UI) when the signed-in user actually changed.
  const before = changes.fw_session.oldValue?.user?.id ?? null;
  const after = changes.fw_session.newValue?.user?.id ?? null;
  if (before !== after) boot();
});

boot();
