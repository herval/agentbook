// agentbook's page: React draws it into #root from the store (lib/store.ts), which the server's answers and the page's
// stream fill. The address after the # says which screen (lib/route.ts).
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { followHash } from "./lib/route.ts";
import { boot } from "./lib/session.ts";
import { reloadIfStale } from "./lib/chrome.ts";
// @mentions in any text become chips, wherever Markdown draws it (it registers them).
import "./lib/mentions.tsx";

// An iPhone zooms the page in when you tap a box whose text is under 16px (the composer's is 15px) and stays zoomed
// after you send, so the page runs off the right edge (the React port dropped this once, and phones broke again).
// maximum-scale=1 stops that zoom,
// and keeps a page a little too wide at scale 1 instead of shrinking it to fit. iOS lets you pinch-zoom whatever it
// says, Android wouldn't, so only there.
if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1))
  document.querySelector('meta[name="viewport"]')?.setAttribute("content", "width=device-width, initial-scale=1, maximum-scale=1");

window.addEventListener("hashchange", () => {
  if (reloadIfStale()) return;
  followHash();
});
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && reloadIfStale());
createRoot(document.getElementById("root")).render(<App />);
boot();
