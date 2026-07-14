// GET /functions/v1/privacy  (deploy with --no-verify-jwt — public)
// Stable privacy-policy URL on our own domain. Supabase's gateway deliberately
// neutralizes HTML served from functions/storage on the shared supabase.co
// domain (forced text/plain + CSP sandbox, an anti-phishing measure), so the
// page itself is hosted elsewhere and this endpoint just redirects to it.
// Re-point via the PRIVACY_URL secret when the policy moves to a real domain;
// the canonical source lives in site/privacy.html.

const TARGET = Deno.env.get("PRIVACY_URL") ??
  "https://claude.ai/code/artifact/fe6ab293-1cf9-4d0c-8cba-2946de8cb202";

Deno.serve(() =>
  new Response(null, {
    status: 302,
    headers: { Location: TARGET, "Cache-Control": "public, max-age=300" },
  })
);
