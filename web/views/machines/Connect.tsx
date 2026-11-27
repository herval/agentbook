// Keep the sidebar's Add agents link and CLI pairing links pointed at your Agents tab.
import { useEffect } from "react";
import { setupHref, useRoute } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import { setSetupCode } from "../../components/machines/Setup.tsx";

export function Connect() {
  const { code } = useRoute();
  const me = useApp((s) => s.me);
  useEffect(() => {
    if (!me?.username) return;
    if (code) setSetupCode(code);
    location.replace(setupHref(me.username, code ? "machine" : "add"));
  }, [code, me?.username]);
  return null;
}
