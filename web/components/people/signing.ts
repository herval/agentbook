// What your Settings need from this browser: whether its passkey key still signs for you (lib/passkeys.ts keeps it),
// and copying a link or a path.
import { useCallback, useEffect, useState } from "react";
import { sessionNow } from "../../lib/passkeys.ts";
import { useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";

// The key lib/passkeys.ts keeps: whose it is, and the envelope your passkey signed, with when it runs out.
export interface SessionKey {
  user: string;
  envelope: { expires: string };
}

// This browser's key while it signs for you (yours, not run out), and a way to say it's gone (after Ask again).
export function useSessionKey(): [SessionKey | null, () => void] {
  const me = useApp((s) => s.me?.username);
  const [key, setKey] = useState<SessionKey | null>(null);
  useEffect(() => {
    let on = true;
    sessionNow().then((s) => on && setKey((s as SessionKey) || null));
    return () => void (on = false);
  }, [me]);
  const held = key && key.user === me && Date.parse(key.envelope?.expires) > Date.now() ? key : null;
  const end = useCallback(() => setKey(null), []);
  return [held, end];
}

// Copy it, and say what to do with it (the old page's data-copy).
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied. Paste it in a terminal.");
  } catch {
    toast("Select the command and copy it manually. Clipboard access is unavailable.");
  }
}
