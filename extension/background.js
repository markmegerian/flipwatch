// Flipwatch background service worker (MV3, module).
// Responsibilities:
//   1. Poll each active saved search on its own chrome.alarms schedule.
//   2. Surface new listings: badge count, chrome notification, feed cache.
//   3. Snipe assist: at T-minus lead time, open the listing and alert the user
//      to place their bid. (No automated bidding — see docs/COMPLIANCE.md.)
import { AuthError, PlanError, db, getSession, searchEbay } from "./lib/api.js";
import { applyExclusions, ebayQuery } from "./lib/query.js";

const FEED_MAX = 200; // items kept in the local feed cache

// ── Alarm scheduling ──────────────────────────────────────────────────────────

async function rescheduleAll() {
  const alarms = await chrome.alarms.getAll();
  for (const a of alarms) {
    if (a.name.startsWith("poll:") || a.name === "resync") {
      await chrome.alarms.clear(a.name);
    }
  }
  const session = await getSession();
  if (!session) return;

  let searches = [];
  try {
    searches = await db.listSearches();
  } catch (e) {
    console.warn("resync: cannot load searches", e);
  }
  for (const s of searches.filter((s) => s.active)) {
    // chrome.alarms minimum period is 30s (Chrome 120+; 60s before).
    const mins = Math.max(s.poll_seconds, 30) / 60;
    chrome.alarms.create(`poll:${s.id}`, { periodInMinutes: mins, delayInMinutes: 0.05 });
  }
  // Re-read the search list every 10 minutes to pick up edits from other devices.
  chrome.alarms.create("resync", { periodInMinutes: 10 });
  await chrome.storage.local.set({ fw_searches: searches });
}

chrome.runtime.onInstalled.addListener(rescheduleAll);
chrome.runtime.onStartup.addListener(rescheduleAll);

// ── Polling ───────────────────────────────────────────────────────────────────

async function pollSearch(searchId) {
  const { fw_searches = [] } = await chrome.storage.local.get("fw_searches");
  const search = fw_searches.find((s) => s.id === searchId);
  if (!search || !search.active) { chrome.alarms.clear(`poll:${searchId}`); return; }

  let result;
  try {
    result = await searchEbay({
      searchId: search.id,
      keywords: ebayQuery(search.keywords), // "-word" exclusions aren't eBay syntax
      priceMin: search.price_min,
      priceMax: search.price_max,
      buyingOptions: search.buying_options,
      usOnly: search.us_only,
      categoryIds: search.category_ids ?? undefined,
      conditionIds: search.condition_ids ?? undefined,
      blockedSellers: search.blocked_sellers,
      // Always newest-first. The Auctions tab re-sorts by end time in the
      // browser, so asking eBay for endingSoonest bought nothing and cost us
      // new-listing detection entirely: a "Both" search returned listings a
      // week old and nothing under 10 minutes.
      sort: "newlyListed",
    });
  } catch (e) {
    if (e instanceof AuthError ||
        (e instanceof PlanError && e.message === "subscription_expired")) {
      // Stop hammering the API; the panel will show the sign-in/renew state.
      await pauseAllPolling(e.message);
    } else if (e instanceof PlanError) {
      // This one search needs a higher plan (e.g. auctions on Standard) —
      // stop only its alarm so the user's other searches keep polling.
      chrome.alarms.clear(`poll:${search.id}`);
      console.warn(`poll ${search.label}: ${e.message} — this search paused`);
    } else {
      console.warn(`poll ${search.label}:`, e.message);
    }
    return;
  }

  // eBay has no NOT operator, so excluded words are filtered here — before the
  // feed and before alerts, so a blocked word never reaches a notification.
  const kept = applyExclusions(search.keywords, result.items ?? []);
  const keptIds = new Set(kept.map((i) => i.itemId));
  result = {
    ...result,
    items: kept,
    newItems: (result.newItems ?? []).filter((id) => keptIds.has(id)),
  };

  await updateFeed(search, result);

  const fresh = result.newItems
    .map((id) => result.items.find((i) => i.itemId === id))
    .filter(Boolean);
  if (fresh.length) await notifyNewItems(search, fresh);
}

// chrome.storage has no transactions: two polls finishing together interleave
// their read-modify-writes of fw_feed / fw_unseen and drop each other's
// updates. Chain every mutation through one promise so they run in turn.
let storageChain = Promise.resolve();
function withStorageLock(fn) {
  const run = storageChain.then(fn);
  storageChain = run.catch(() => {});
  return run;
}

function updateFeed(search, result) {
  return withStorageLock(() => updateFeedLocked(search, result));
}

async function updateFeedLocked(search, result) {
  const { fw_feed = [] } = await chrome.storage.local.get("fw_feed");
  const known = new Set(fw_feed.map((f) => f.itemId));
  const newSet = new Set(result.newItems ?? []);
  const additions = result.items
    .filter((i) => !known.has(i.itemId))
    .map((i) => ({
      ...i,
      searchId: search.id,
      searchLabel: search.label,
      isNew: newSet.has(i.itemId),
      fetchedAt: Date.now(),
    }));
  if (!additions.length) return;
  const merged = [...additions, ...fw_feed].slice(0, FEED_MAX);
  await chrome.storage.local.set({ fw_feed: merged });
  chrome.runtime.sendMessage({ type: "feed-updated" }).catch(() => {});
}

async function notifyNewItems(search, fresh) {
  if (!search.notify) return;
  const { unseen, fw_settings } = await withStorageLock(async () => {
    const got = await chrome.storage.local.get(["fw_unseen", "fw_settings"]);
    const next = (got.fw_unseen ?? 0) + fresh.length;
    await chrome.storage.local.set({ fw_unseen: next });
    return { unseen: next, fw_settings: got.fw_settings ?? {} };
  });
  chrome.action.setBadgeText({ text: unseen > 99 ? "99+" : String(unseen) });
  chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });

  if (fw_settings.desktopNotifications !== false) {
    const first = fresh[0];
    chrome.notifications.create(`new:${first.itemId}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: fresh.length === 1
        ? `New: ${first.title.slice(0, 60)}`
        : `${fresh.length} new listings — ${search.label}`,
      message: fresh.length === 1
        ? `$${first.price ?? "?"} · ${search.label}`
        : fresh.map((f) => `$${f.price ?? "?"} ${f.title.slice(0, 40)}`).slice(0, 3).join("\n"),
      priority: 2,
    });
  }
}

async function pauseAllPolling(reason) {
  const alarms = await chrome.alarms.getAll();
  for (const a of alarms) if (a.name.startsWith("poll:")) chrome.alarms.clear(a.name);
  await chrome.storage.local.set({ fw_paused: reason });
  chrome.action.setBadgeText({ text: "!" });
  chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
}

// ── Snipe assist ──────────────────────────────────────────────────────────────
// The panel schedules `snipe:<id>` alarms. When one fires we open the listing
// in a focused tab and raise a must-act notification with the planned max bid.
// The user places the bid — their account, their click, their decision.

async function fireSnipe(snipeId) {
  let snipes = [];
  try { snipes = await db.listSnipes(); } catch { /* offline — use nothing */ }
  const snipe = snipes.find((s) => s.id === snipeId);
  if (!snipe || snipe.status !== "armed") return;

  await chrome.tabs.create({ url: snipe.item_url, active: true });
  chrome.notifications.create(`snipe:${snipeId}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "🎯 Snipe window open — bid now",
    message: `${(snipe.title ?? "Auction").slice(0, 60)}\nYour planned max: $${snipe.max_bid}`,
    priority: 2,
    requireInteraction: true,
  });
  try { await db.updateSnipe(snipeId, { status: "fired" }); } catch {}
}

// ── Event wiring ──────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith("poll:")) pollSearch(alarm.name.slice(5));
  else if (alarm.name.startsWith("snipe:")) fireSnipe(alarm.name.slice(6));
  else if (alarm.name === "resync") rescheduleAll();
});

chrome.notifications.onClicked.addListener(async (notifId) => {
  if (notifId.startsWith("new:")) {
    const itemId = notifId.slice(4);
    const { fw_feed = [] } = await chrome.storage.local.get("fw_feed");
    const item = fw_feed.find((f) => f.itemId === itemId);
    if (item?.url) chrome.tabs.create({ url: item.url });
    chrome.notifications.clear(notifId);
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

// Messages from panel/options pages.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "resync": await rescheduleAll(); sendResponse({ ok: true }); break;
      case "clear-unseen":
        await withStorageLock(() => chrome.storage.local.set({ fw_unseen: 0 }));
        chrome.action.setBadgeText({ text: "" });
        sendResponse({ ok: true });
        break;
      case "resume-polling":
        await chrome.storage.local.remove("fw_paused");
        chrome.action.setBadgeText({ text: "" });
        await rescheduleAll();
        sendResponse({ ok: true });
        break;
      case "schedule-snipe": {
        // msg.snipe = row from db.addSnipe()
        const at = new Date(msg.snipe.end_time).getTime() -
          (msg.snipe.lead_seconds ?? 20) * 1000;
        chrome.alarms.create(`snipe:${msg.snipe.id}`, { when: Math.max(at, Date.now() + 1000) });
        sendResponse({ ok: true });
        break;
      }
      case "cancel-snipe":
        await chrome.alarms.clear(`snipe:${msg.snipeId}`);
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true; // async response
});
