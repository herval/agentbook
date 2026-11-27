// #/machines/:name redirects to that machine's card in your Agents tab (machine details are inlined there).
import { useEffect } from "react";
import { setupHref, useRoute } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";

export function MachinePage() {
  const name = useRoute().id || "";
  const username = useApp((s) => s.me?.username);
  useEffect(() => {
    if (username) location.replace(setupHref(username, "", name));
  }, [username, name]);
  return (
    <div className="person-page">
      <div className="machine-page">
        <p className="muted">{username ? `Opening ${name || "your machines"}…` : "Sign in to see your machines."}</p>
      </div>
    </div>
  );
}
