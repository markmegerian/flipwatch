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

/** Split a stored keywords string into the three fields the form edits. */
export function parseQuery(keywords = "") {
  const src = String(keywords ?? "");
  const exclude = [];
  // -word  or  -"several words"
  const withoutNots = src.replace(/-(?:"([^"]*)"|(\S+))/g, (_, quoted, bare) => {
    const w = (quoted ?? bare ?? "").trim();
    if (w) exclude.push(w);
    return " ";
  });
  let anyOf = [];
  const withoutAny = withoutNots.replace(/\(([^)]*)\)/, (_, inner) => {
    anyOf = inner.split(",").map((s) => s.trim()).filter(Boolean);
    return " ";
  });
  return { base: withoutAny.replace(/\s+/g, " ").trim(), anyOf, exclude };
}

/** Rebuild the stored keywords string from the form's three fields. */
export function composeQuery({ base = "", anyOf = [], exclude = [] } = {}) {
  const parts = [String(base).trim()];
  const any = anyOf.map((s) => String(s).trim()).filter(Boolean);
  if (any.length) parts.push(`(${any.join(",")})`);
  for (const w of exclude.map((s) => String(s).trim()).filter(Boolean)) {
    parts.push(/\s/.test(w) ? `-"${w}"` : `-${w}`);
  }
  return parts.filter(Boolean).join(" ").trim();
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

/** A short plain-English summary of a search, for the form's live preview. */
export function describeQuery({ base, anyOf, exclude }) {
  const bits = [];
  if (base) bits.push(`must contain “${base}”`);
  if (anyOf?.length) bits.push(`plus any of ${anyOf.map((w) => `“${w}”`).join(", ")}`);
  if (exclude?.length) bits.push(`but never ${exclude.map((w) => `“${w}”`).join(", ")}`);
  return bits.length ? bits.join(", ") : "everything (no words yet)";
}
