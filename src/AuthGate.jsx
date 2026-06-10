import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { checkForUpdates } from "./updater.js";

// Synapse is a HyperVoice Suite app: it gates on the user's HyperVoice account
// having suite access (Pro / Lifetime). This wraps the whole app — children only
// render once entitlement is confirmed.
//
// States:
//   checking  — verifying the linked account (or first load)
//   signin    — no linked account; show "Sign in with HyperVoice"
//   free      — linked, but the account has no suite access (upsell)
//   ok        — entitled; render the app
//
// Offline grace: the last good entitlement is cached; if the network is
// unreachable we honor a recent cached "ok" so a connectivity blip doesn't lock
// the user out.

const ENT_CACHE_KEY = "synapse.ent.v1";
const GRACE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const PRICING_URL = "https://hypervoice.app/pricing";

function readCache() {
  try {
    const raw = localStorage.getItem(ENT_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function writeCache(ent) {
  try {
    localStorage.setItem(ENT_CACHE_KEY, JSON.stringify({ ts: Date.now(), ent }));
  } catch {
    /* ignore */
  }
}

export default function AuthGate({ children }) {
  const [phase, setPhase] = useState("checking");
  const [ent, setEnt] = useState(null);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false); // sign-in opened in browser
  const checkedUpdates = useRef(false);

  const evaluate = useCallback(async () => {
    setPhase((p) => (p === "ok" ? "ok" : "checking"));
    try {
      const e = await invoke("get_entitlement");
      setOffline(false);
      if (!e || e.linked === false) {
        setPhase("signin");
        return;
      }
      setEnt(e);
      if (e.suite_access) {
        writeCache(e);
        setWaiting(false);
        setPhase("ok");
      } else {
        setPhase("free");
      }
    } catch {
      // Network/back-end unreachable — fall back to a recent cached "ok".
      const cached = readCache();
      if (cached && cached.ent && cached.ent.suite_access && Date.now() - cached.ts < GRACE_MS) {
        setEnt(cached.ent);
        setOffline(true);
        setPhase("ok");
      } else {
        setPhase("signin");
      }
    }
  }, []);

  // Initial check.
  useEffect(() => {
    evaluate();
  }, [evaluate]);

  // Re-check when the deep-link claim lands (account just linked).
  useEffect(() => {
    const un = listen("hv-auth-claimed", () => {
      setWaiting(false);
      evaluate();
    });
    return () => {
      un.then((f) => f());
    };
  }, [evaluate]);

  // Re-check when the window regains focus (e.g. after finishing in the browser).
  useEffect(() => {
    const onFocus = () => {
      if (phase === "signin" || phase === "free") evaluate();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [phase, evaluate]);

  // Kick the updater once we're entitled.
  useEffect(() => {
    if (phase === "ok" && !checkedUpdates.current) {
      checkedUpdates.current = true;
      checkForUpdates();
    }
  }, [phase]);

  const signIn = async () => {
    setBusy(true);
    try {
      await invoke("auth_begin_signin");
      setWaiting(true);
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await invoke("auth_sign_out");
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
      setEnt(null);
      setPhase("signin");
    }
  };

  const openExternal = (url) => invoke("open_external", { url }).catch(() => {});

  if (phase === "ok") {
    return (
      <>
        {offline && <div className="gate-offline">Offline — using your last verified Suite access</div>}
        {children}
      </>
    );
  }

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="gate-logo">◆ Synapse</div>
        <div className="gate-sub">Claude Code Workspace · HyperVoice Suite</div>

        {phase === "checking" && <div className="gate-msg">Checking your account…</div>}

        {phase === "signin" && (
          <>
            <div className="gate-msg">
              Synapse is part of the HyperVoice Suite. Sign in with your HyperVoice account to continue.
            </div>
            <button className="gate-btn" onClick={signIn} disabled={busy}>
              {waiting ? "Waiting for the browser…" : "Sign in with HyperVoice"}
            </button>
            {waiting && (
              <button className="gate-link" onClick={evaluate}>
                I've finished signing in — re-check
              </button>
            )}
          </>
        )}

        {phase === "free" && (
          <>
            <div className="gate-msg">
              {ent?.email ? <>Signed in as <b>{ent.email}</b>. </> : null}
              Your plan doesn't include Suite access. Upgrade to HyperVoice Pro or Lifetime to use Synapse.
            </div>
            <button
              className="gate-btn"
              onClick={() => openExternal(ent?.customer_portal_url || PRICING_URL)}
            >
              Upgrade HyperVoice
            </button>
            <button className="gate-link" onClick={evaluate} disabled={busy}>
              I've upgraded — re-check
            </button>
            <button className="gate-link" onClick={signOut} disabled={busy}>
              Use a different account
            </button>
          </>
        )}
      </div>
    </div>
  );
}
