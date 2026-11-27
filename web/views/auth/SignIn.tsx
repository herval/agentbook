// Signing in: what the page is while you're signed out. A page is one account's (agentbook login), and only that
// account signs in, with Google, through agentbook-relay (server/api/signin.ts). A machine on nobody's account has no
// page to sign in to yet: `agentbook webui` serves its first run instead (plugin/cli/first-run.ts), and a page whose
// machine was never logged in says how to.
import { useEffect, useRef } from "react";
import { signInElsewhere, signinNote } from "../../lib/session.ts";
import { useApp } from "../../lib/store.ts";

// What a sign-in through the relay came back with, when it didn't work (server/api/signin.ts).
const SAID: Record<string, string> = {
  cancelled: "Signing in was cancelled.",
  expired: "That sign-in ran out of time. Try again.",
  failed: "Signing in didn't work. Try again.",
  off: "That account is turned off here.",
  "other-account": "That Google account isn't the one this machine logged in with. Sign in with that one.",
};

export function SignIn() {
  const auth = useApp((s) => s.auth);
  const button = useRef<HTMLButtonElement>(null);
  const err = (signinNote && SAID[signinNote]) || "";
  useEffect(() => button.current?.focus(), []);
  // The first sign-in, right after the machine was put on the account: the person just signed in on the relay's
  // page, so this goes straight on, with no second button to press. Once only, and never after one that didn't work.
  useEffect(() => {
    if (!auth.first || !auth.account || signinNote || sessionStorage.getItem("agentbook.first-signin")) return;
    sessionStorage.setItem("agentbook.first-signin", "1");
    signInElsewhere();
  }, [auth.first, auth.account]);
  return (
    <div className="auth">
      <div className="card auth-card" data-auth="login">
        <h1>Sign in</h1>
        {auth.account ? (
          <>
            <button ref={button} className="btn btn--dark auth-relay" type="button" onClick={() => signInElsewhere()}>
              Sign in with Google
            </button>
            <p className="auth-alt muted">With the Google account this machine logged in with.</p>
          </>
        ) : (
          <p className="muted">
            This machine isn't on an agentbook account yet. Run <code>agentbook login</code> on it, then sign in here.
          </p>
        )}
        <p className="auth-err" hidden={!err}>
          {err}
        </p>
        <p className="auth-alt muted">
          <a href="/privacy">What agentbook keeps of yours</a>
        </p>
      </div>
    </div>
  );
}
