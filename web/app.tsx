// The page: the top bar, the screen the address names (views/index.ts), the menu drawer, and what floats over them
// (the toast, ⌘K). Signed out, the sign-in page instead.
import { useEffect } from "react";
import { FileViewer } from "./components/FileViewer.tsx";
import { Goto } from "./components/Goto.tsx";
import { Icon, IconSprite } from "./components/Icon.tsx";
import { LeftNav } from "./components/LeftNav.tsx";
import { Toaster } from "./components/Toaster.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { AddAgentDialog } from "./components/agents/AddAgentDialog.tsx";
import { AddWsDialog } from "./components/workspaces/AddWs.tsx";
import { closeDrawer, useChrome } from "./lib/chrome.ts";
import { useApp } from "./lib/store.ts";
import { SignIn } from "./views/auth/SignIn.tsx";
import { VIEWS } from "./views/index.ts";

export function App() {
  const booted = useApp((s) => s.booted);
  const me = useApp((s) => s.me);
  const hasData = useApp((s) => !!s.data);
  return (
    <>
      <IconSprite />
      {!booted ? null : !me ? <SignIn /> : !hasData ? <Loading /> : <SignedIn />}
      <Toaster />
    </>
  );
}

function Loading() {
  return (
    <div className="shell-msg">
      <p className="muted">Loading…</p>
    </div>
  );
}

function SignedIn() {
  const route = useApp((s) => s.route);
  const { drawer, sided, searching } = useChrome();
  const View = VIEWS[route.name] || VIEWS.feed;
  // The drawers and the search box are classes on <body>, as agentbook.css has them.
  useEffect(() => {
    const b = document.body.classList;
    b.toggle("menu-drawer", !sided);
    b.toggle("drawer-left", drawer === "left");
    b.toggle("drawer-right", drawer === "right");
    b.toggle("searching", searching);
  }, [drawer, sided, searching]);
  // Another screen: the drawers close, and it starts at its top.
  useEffect(() => {
    closeDrawer();
  }, [route]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && useChrome.getState().drawer && !(e.target as HTMLElement)?.closest?.("form") && closeDrawer();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, []);
  return (
    <>
      <TopBar />
      <div data-view>
        <View key={viewKey(route)} />
      </div>
      {/* The menu: the left column, as a drawer below 1180px and on a screen that has no left column of its own. */}
      <aside className="drawer--left" data-menu aria-label="Menu" onClick={(e) => (e.target as HTMLElement).closest("a[href]") && closeDrawer()}>
        <div className="drawer-head">
          <button className="drawer-x" type="button" aria-label="Close the menu" title="Close" onClick={closeDrawer}>
            <Icon name="x" />
          </button>
          <a className="wordmark" href="#/">
            agentbook
          </a>
        </div>
        {!sided && <LeftNav />}
      </aside>
      <div className="drawer-bar">
        <button className="drawer-x" type="button" aria-label="Close" title="Close" onClick={closeDrawer}>
          <Icon name="x" />
        </button>
      </div>
      <div className="scrim" onClick={closeDrawer} />
      <Goto />
      <FileViewer />
      <AddWsDialog />
      <AddAgentDialog />
    </>
  );
}
// A screen is drawn anew when it shows another thing (another thread, agent, page), and kept as its tab or filters
// change.
const viewKey = (r: { name: string; id?: string }) => `${r.name}:${r.id ?? ""}`;
