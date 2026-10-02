// Fill these in from your Supabase project (Settings → API).
// The anon key is safe to ship in the extension — all data access is protected
// by row-level security and the edge-function paywall; the anon key alone
// grants nothing.
export const SUPABASE_URL = "https://kiynmpyqwjcpsurhgibl.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtpeW5tcHlxd2pjcHN1cmhnaWJsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5MDI1NTUsImV4cCI6MjA5OTQ3ODU1NX0._l35WagMXknzfp84CzAnmwqnnPzJI-gRN_iT3RbQLQ8";

// Marketing site (checkout success/cancel pages live here too).
export const SITE_URL = "https://example.com";

// Auctions are only surfaced in their final stretch — the Auctions tab is a
// "bid now" list, not a browse list. Polling is newest-first, so auctions are
// fetched separately by soonest-ending to populate it.
export const CLOSING_WINDOW_MS = 5 * 60 * 1000;
