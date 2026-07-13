// Flipwatch options page — auth, subscription, notification prefs.
import { createCheckout, db, getSession, signIn, signOut, signUp } from "../lib/api.js";

const $ = (id) => document.getElementById(id);
let mode = "signin"; // or "signup"

async function render() {
  const session = await getSession();
  $("auth-card").hidden = !!session;
  $("account-card").hidden = !session;
  $("billing-card").hidden = !session;
  $("notif-card").hidden = !session;
  if (!session) return;

  $("acct-email").textContent = session.user?.email ?? "";
  try {
    const subs = await db.mySubscription();
    const sub = subs?.[0];
    if (sub) {
      $("acct-plan").textContent = sub.tier;
      $("acct-status").textContent = sub.status;
      const row = $("acct-renew-row");
      if (sub.status === "trialing") {
        row.hidden = false;
        $("acct-renew-label").textContent = "Trial ends";
        $("acct-renew").textContent = new Date(sub.trial_ends_at).toLocaleDateString();
      } else if (sub.current_period_end) {
        row.hidden = false;
        $("acct-renew-label").textContent = "Renews";
        $("acct-renew").textContent = new Date(sub.current_period_end).toLocaleDateString();
      }
    }
  } catch (e) {
    $("acct-plan").textContent = "—";
    $("acct-status").textContent = e.message;
  }

  const { fw_settings = {} } = await chrome.storage.local.get("fw_settings");
  $("opt-desktop").checked = fw_settings.desktopNotifications !== false;
  $("opt-sound").checked = !!fw_settings.sound;
}

$("auth-toggle").addEventListener("click", (e) => {
  e.preventDefault();
  mode = mode === "signin" ? "signup" : "signin";
  $("auth-title").textContent = mode === "signin" ? "Sign in" : "Create your account";
  $("auth-submit").textContent = mode === "signin" ? "Sign in" : "Start free trial";
  $("auth-toggle").textContent = mode === "signin"
    ? "New here? Create an account — 7-day free trial, no card required."
    : "Already have an account? Sign in.";
});

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("auth-error");
  err.hidden = true;
  $("auth-submit").disabled = true;
  try {
    const email = $("auth-email").value.trim();
    const pass = $("auth-pass").value;
    if (mode === "signup") {
      const res = await signUp(email, pass);
      if (!res.access_token) {
        err.hidden = false;
        err.textContent = "Check your email to confirm your account, then sign in.";
        return;
      }
    } else {
      await signIn(email, pass);
    }
    chrome.runtime.sendMessage({ type: "resync" }).catch(() => {});
    await render();
  } catch (ex) {
    err.hidden = false;
    err.textContent = ex.message;
  } finally {
    $("auth-submit").disabled = false;
  }
});

$("btn-signout").addEventListener("click", async () => {
  await signOut();
  chrome.runtime.sendMessage({ type: "resync" }).catch(() => {});
  render();
});

document.querySelectorAll("[data-tier]").forEach((btn) =>
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const url = await createCheckout(btn.dataset.tier);
      chrome.tabs.create({ url });
    } catch (e) {
      alert(`Could not open checkout: ${e.message}`);
    } finally {
      btn.disabled = false;
    }
  }));

for (const id of ["opt-desktop", "opt-sound"]) {
  $(id).addEventListener("change", async () => {
    const { fw_settings = {} } = await chrome.storage.local.get("fw_settings");
    fw_settings.desktopNotifications = $("opt-desktop").checked;
    fw_settings.sound = $("opt-sound").checked;
    await chrome.storage.local.set({ fw_settings });
  });
}

render();
