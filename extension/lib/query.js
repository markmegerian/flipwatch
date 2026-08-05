// Flipwatch search-query mini-syntax.
//
// A saved search's `keywords` column stays the single source of truth, but it
// stores a small human-readable syntax so the form can offer separate fields
// without needing new columns:
//
//   vintage pokemon holo            → every listing must contain these words
//   (base set,fossil,jungle)        → ...and ANY ONE of these
//   -damaged -"water stained"       → ...and NONE of these
//
// The parenthesised group is real eBay Browse API syntax and is passed through
// untouched. Exclusions are ours: eBay has no NOT operator, so we strip them
// from the query and filter the returned titles ourselves.

/** Split a stored keywords string into the fields the form edits. */
export function parseQuery(keywords = "") {
  const src = String(keywords ?? "");
  // Optional reference price, e.g. `value:250`. Stored here rather than in a
  // column because the schema can't be migrated from this session; it is
  // stripped before the query reaches eBay (see ebayQuery).
  let value = null;
  const withoutValue = src.replace(/(?:^|\s)value:(\d+(?:\.\d+)?)/i, (_, v) => {
    const n = Number(v);
    if (isFinite(n) && n > 0) value = n;
    return " ";
  });
  const exclude = [];
  // -word  or  -"several words"
  const withoutNots = withoutValue.replace(/-(?:"([^"]*)"|(\S+))/g, (_, quoted, bare) => {
    const w = (quoted ?? bare ?? "").trim();
    if (w) exclude.push(w);
    return " ";
  });
  let anyOf = [];
  const withoutAny = withoutNots.replace(/\(([^)]*)\)/, (_, inner) => {
    anyOf = inner.split(",").map((s) => s.trim()).filter(Boolean);
    return " ";
  });
  return { base: withoutAny.replace(/\s+/g, " ").trim(), anyOf, exclude, value };
}

/** Rebuild the stored keywords string from the form's fields. */
export function composeQuery({ base = "", anyOf = [], exclude = [], value = null } = {}) {
  const parts = [String(base).trim()];
  const any = anyOf.map((s) => String(s).trim()).filter(Boolean);
  if (any.length) parts.push(`(${any.join(",")})`);
  for (const w of exclude.map((s) => String(s).trim()).filter(Boolean)) {
    parts.push(/\s/.test(w) ? `-"${w}"` : `-${w}`);
  }
  const v = Number(value);
  if (isFinite(v) && v > 0) parts.push(`value:${v}`);
  return parts.filter(Boolean).join(" ").trim();
}

/**
 * Compare a listing price against the search's reference value.
 * Returns null when either is missing, so callers can skip the badge.
 */
export function targetStanding(price, value) {
  const p = Number(price), v = Number(value);
  if (!isFinite(p) || p <= 0 || !isFinite(v) || v <= 0) return null;
  const pct = Math.round((p / v) * 100);
  return { pct, tone: pct <= 70 ? "good" : pct <= 100 ? "mid" : "bad" };
}

/** The query actually sent to eBay: exclusions removed, OR-group kept. */
export function ebayQuery(keywords) {
  const { base, anyOf } = parseQuery(keywords);
  return composeQuery({ base, anyOf });
}

/** Drop items whose title contains an excluded word (eBay can't do this). */
export function applyExclusions(keywords, items) {
  const { exclude } = parseQuery(keywords);
  if (!exclude.length) return items;
  const bad = exclude.map((w) => w.toLowerCase());
  return items.filter((it) => {
    const title = String(it?.title ?? "").toLowerCase();
    return !bad.some((w) => title.includes(w));
  });
}

// ── Deal-score comparables ────────────────────────────────────────────────────
// eBay titles are keyword-stuffed ("... w/ Dock & Joy-Con FREE SHIP L@@K"), so
// using one verbatim as the comp query gives every listing a different, noisy
// comp set: six near-identical Switch OLEDs came back with medians 1.4x apart
// and one had only 9 comps. Reducing the title to its distinctive product words
// gives a stable query and a full sample.
const COMP_NOISE = new Set(`
lot lots bundle set pack pcs pieces piece with and for the of in to
new used open box sealed mint near excellent very good acceptable condition
tested works working perfect rare htf vintage authentic genuine original
oem official free shipping fast ship ships bonus extra plus complete cib loose
read please see description look wow nice awesome great deal sale price obo
best offer nib nwt bnib model system unit included includes incl brand
`.trim().split(/\s+/));

/** Reduce a listing title to a short, stable query for pricing comparables. */
export function compQuery(title, max = 5) {
  const out = [];
  for (const t of String(title ?? "").toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)) {
    if (!t || t.length < 2 || COMP_NOISE.has(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length >= max) break;
  }
  return out.join(" ");
}

/**
 * eBay condition label → the condition IDs the Browse API filters on, so a
 * for-parts unit isn't priced against new ones. Deliberately broad buckets:
 * narrower ones shrink the comp sample until the median is noise again.
 */
export function conditionIdsFor(condition) {
  const c = String(condition ?? "").toLowerCase();
  if (!c) return undefined;
  if (c.includes("part") || c.includes("not working")) return ["7000"];
  if (c.includes("refurb")) return ["2000", "2010", "2020", "2030", "2500"];
  if (c.includes("new") || c.includes("open box")) return ["1000", "1500"];
  if (c.includes("used") || c.includes("good") || c.includes("acceptable")) {
    return ["3000", "4000", "5000", "6000"];
  }
  return undefined; // unknown label — don't over-filter
}

/** A short plain-English summary of a search, for the form's live preview. */
export function describeQuery({ base, anyOf, exclude }) {
  const bits = [];
  if (base) bits.push(`must contain “${base}”`);
  if (anyOf?.length) bits.push(`plus any of ${anyOf.map((w) => `“${w}”`).join(", ")}`);
  if (exclude?.length) bits.push(`but never ${exclude.map((w) => `“${w}”`).join(", ")}`);
  return bits.length ? bits.join(", ") : "everything (no words yet)";
}
