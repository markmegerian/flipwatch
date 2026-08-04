// GET/POST /functions/v1/ebay-account-deletion  (deploy with --no-verify-jwt)
// eBay Marketplace Account Deletion endpoint — required before eBay marks a
// production keyset compliant and serves it traffic. eBay validates the
// endpoint with a GET challenge handshake, then POSTs a notification whenever
// an eBay member requests account deletion; we must ack 200 and erase any
// data tied to that member.
//
// Configure in the eBay developer portal (Alerts & Notifications →
// Marketplace Account Deletion):
//   endpoint:           <SUPABASE_URL>/functions/v1/ebay-account-deletion
//   verification token: EBAY_VERIFICATION_TOKEN secret (falls back to the
//                       baked-in default so the handshake works out of the box)
// The challenge hash covers token + endpoint URL, so rotating either means
// updating the eBay portal to match.
import { adminClient, json } from "../_shared/mod.ts";

const DEFAULT_TOKEN = "4404fd9951b2f274cac9a1bc371fa0f90f0b0ce946ba78f84b36239aa16c7b10";

function verificationToken(): string {
  return Deno.env.get("EBAY_VERIFICATION_TOKEN") ?? DEFAULT_TOKEN;
}

function endpointUrl(): string {
  return Deno.env.get("EBAY_DELETION_ENDPOINT") ??
    `${Deno.env.get("SUPABASE_URL")}/functions/v1/ebay-account-deletion`;
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  // ── Challenge handshake: eBay validates the endpoint when you save it ───────
  if (req.method === "GET") {
    const code = new URL(req.url).searchParams.get("challenge_code");
    if (!code) return json({ error: "missing_challenge_code" }, 400);
    const challengeResponse = await sha256Hex(code + verificationToken() + endpointUrl());
    return json({ challengeResponse });
  }

  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // ── Deletion notification ────────────────────────────────────────────────────
  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const data = payload?.notification?.data ?? {};
  console.log("marketplace account deletion", {
    notificationId: payload?.notification?.notificationId ?? null,
    username: data.username ?? null,
    userId: data.userId ?? null,
  });

  // Flipwatch holds no eBay member accounts; the only member data we persist is
  // the seller username on saved listings — null it for the deleted member.
  // Notification signatures aren't verified (yet), so do nothing a forged POST
  // could exploit: e.g. NOT removing the name from users' blocked_sellers lists,
  // which would let a blocked seller unblock themselves.
  if (data.username) {
    await adminClient()
      .from("saved_listings")
      .update({ seller: null })
      .eq("seller", String(data.username));
  }
  return json({ received: true });
});
