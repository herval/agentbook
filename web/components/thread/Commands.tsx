// / at the start of a thread's reply box: what its agent can run from here, in a popup
// over the box, one list: what starts with what you typed first, then what has it in its name, then in what it does.
// Each says what it takes and where it's from. ↑ ↓ move, Tab adds it to the box to write what it takes, Enter runs it
// (or adds it, when it needs something), Esc closes. A line under the box (CmdNote) says when it won't go as it is.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { kindCaps } from "../../lib/agents.ts";
import { post } from "../../lib/api.ts";
import { hueVars, isTalkId } from "../../lib/format.ts";
import { setDraft, useDraft } from "../../lib/hooks.ts";
import { agentOf, threadRow } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import { Icon } from "../Icon.tsx";

// A command a thread's agent can run: its name, what it does, what it takes (`hint`; `takes` "req" when it needs it),
// and where it's from (built in, a plugin's, the project's). One it can't run from here says why (`why`).
export interface Cmd {
  name: string;
  description: string;
  hint?: string;
  takes?: string;
  from?: string;
  plugin?: string;
  why?: string;
  isOff?: boolean;
}
// A thread's commands, from its machine: { runs: true, list, off } or { runs: false, why }, or { error }.
export interface Cmds {
  runs?: boolean;
  list?: Cmd[];
  off?: Cmd[];
  why?: string;
  error?: string;
}

const CMDS_MS = 5 * 60e3;
const cmdsKept = new Map<string, { at: number; data?: Cmds; wait?: Promise<Cmds> }>(); // thread -> { at, data } (or { at, wait } while it's asked)
// A thread's commands, asked of its machine at most every five minutes.
export function threadCmds(id: string): Promise<Cmds> {
  const have = cmdsKept.get(id);
  if (have?.wait) return have.wait;
  if (have && Date.now() - have.at < CMDS_MS) return Promise.resolve(have.data);
  const wait = fetch(`/api/sessions/${encodeURIComponent(id)}/commands`)
    .then(async (r) => {
      const d = await r.json().catch(() => ({}));
      return (r.ok ? d : { error: d.error || `HTTP ${r.status}` }) as Cmds;
    })
    .catch((e) => ({ error: e.message }) as Cmds)
    .then((data) => {
      cmdsKept.set(id, { at: data.error ? 0 : Date.now(), data });
      return data;
    });
  cmdsKept.set(id, { at: Date.now(), wait });
  return wait;
}
const cmdsNow = (id: string) => cmdsKept.get(id)?.data || null;
// "/name what it takes", as the box holds it: the command it names (or one left out), and what follows it.
export function cmdIn(text: string, data: Cmds | null) {
  const m = /^\/([\w:.-]*)(\s+([\s\S]*))?$/.exec(text);
  if (!m || !data?.runs) return null;
  return { name: m[1], spaced: m[2] != null, args: (m[3] || "").trim(), cmd: data.list.find((c) => c.name === m[1]) || null, off: (data.off || []).find((c) => c.name === m[1]) || null };
}
const CMD_FIRST = ["compact", "context", "code-review", "review", "model", "effort", "status", "think", "goal", "init", "rename"];
export function cmdRows(q: string, data: Cmds): Cmd[] {
  const first = (c: Cmd) => CMD_FIRST.indexOf(c.name) + 1 || 99;
  q = q.toLowerCase();
  if (!q) return [...data.list].sort((a, b) => first(a) - first(b) || a.name.localeCompare(b.name));
  const score = (c: Cmd) => (c.name.toLowerCase().startsWith(q) ? 0 : c.name.toLowerCase().includes(q) ? 1 : c.description.toLowerCase().includes(q) ? 2 : 9);
  const hits = data.list.filter((c) => score(c) < 9).sort((a, b) => score(a) - score(b) || first(a) - first(b) || a.name.localeCompare(b.name));
  return [...hits, ...(data.off || []).filter((c) => c.name.startsWith(q)).map((c) => ({ ...c, isOff: true }))];
}

// What the box last said it couldn't send (cmdToSend), by thread, until what's in it changes.
const useSaid = create<{ said: Record<string, { bad: boolean; node: ReactNode; text: string } | null> }>(() => ({ said: {} }));
const setSaid = (id: string, v: { bad: boolean; node: ReactNode; text: string } | null) => useSaid.setState((s) => ({ said: { ...s.said, [id]: v } }));
// The threads whose box shows its note (CmdNote): cmdToSend says why there, else in a toast.
const noted = new Set<string>();

// What the box sends, when it holds a command: its name (it goes as one), null (it goes as words), or false when it
// doesn't go: one left out, one that needs what it takes, and /model, which is the model picker's. `draftKey`: its
// box's, emptied once /model switched it.
export async function cmdToSend(threadId: string, text: string, draftKey = `c:${threadId}`): Promise<string | null | false> {
  if (isTalkId(threadId)) return null;
  const data = await threadCmds(threadId);
  const c = cmdIn(text, data);
  if (!c) return null;
  const say = (node: ReactNode, words: string) => {
    setSaid(threadId, { bad: true, node, text: words });
    if (!noted.has(threadId)) toast(words);
    return false as const;
  };
  if (c.off) return say(`Not from here: /${c.name} ${c.off.why}.`, `Not from here: /${c.name} ${c.off.why}.`);
  if (!c.cmd) return null;
  const s = threadRow(threadId);
  const a = agentOf(s?.agent);
  const models = a.models?.list;
  // A /model its runtime takes as a command, with the models it lists (shared/runtimes.ts): one of those, by id or name.
  if (c.name === "model" && kindCaps(a.kind)?.commands && kindCaps(a.kind)?.models && models?.length) {
    const want = c.args.toLowerCase();
    const m = models.find((x) => x.id.toLowerCase() === want || x.name.toLowerCase() === want);
    if (!m)
      return say(
        <>
          Pick one of its models:{" "}
          {models.map((x, i) => (
            <span key={x.id}>
              {i ? ", " : ""}
              <code>/model {x.id}</code>
            </span>
          ))}
          .
        </>,
        `Pick one of its models: ${models.map((x) => `/model ${x.id}`).join(", ")}.`,
      );
    const r = await post(`/api/sessions/${encodeURIComponent(threadId)}/model`, { model: m.id });
    if (r.ok) {
      toast(`It switches to ${m.name} from its next turn.`);
      setDraft(draftKey, "");
      setSaid(threadId, null);
    }
    return false;
  }
  if (c.cmd.takes === "req" && !c.args) {
    const choices = (c.cmd.hint || "").replace(/^[<[]|[>\]]$/g, "").split("|");
    const eg = choices[Math.min(2, choices.length - 1)];
    const words = `/${c.name} needs ${c.cmd.hint}: /${c.name} ${eg}. Bare, it opens a picker nobody can answer in the background.`;
    return say(
      <>
        /{c.name} needs {c.cmd.hint}:{" "}
        <code>
          /{c.name} {eg}
        </code>
        . Bare, it opens a picker nobody can answer in the background.
      </>,
      words,
    );
  }
  setSaid(threadId, null);
  return c.cmd.name;
}

// The line under a thread's box while it holds a command: why it won't go as it is (one left out, one it doesn't
// have), that it goes in when the turn ends (`working`), or what cmdToSend said.
export function CmdNote({ threadId, draftKey, working = false }: { threadId: string; draftKey: string; working?: boolean }) {
  const [text] = useDraft(draftKey);
  const said = useSaid((s) => s.said[threadId] || null);
  const [data, setData] = useState<Cmds | null>(() => cmdsNow(threadId));
  useEffect(() => {
    noted.add(threadId);
    return () => void noted.delete(threadId);
  }, [threadId]);
  // What it said goes once what's in the box changes.
  const was = useRef(text);
  useEffect(() => {
    if (was.current !== text && said) setSaid(threadId, null);
    was.current = text;
  }, [text, threadId, said]);
  useEffect(() => {
    if (!data && text.startsWith("/") && !isTalkId(threadId)) threadCmds(threadId).then(setData);
  }, [text, data, threadId]);
  const c = cmdIn(text, data);
  const note = said || (c?.off ? { bad: true, node: `Not from here: /${c.name} ${c.off.why}.` } : c && !c.cmd && c.spaced && c.name ? { bad: false, node: `It has no /${c.name} here: this goes as text.` } : c?.cmd && working ? { bad: false, node: <><Icon name="clock" />Commands run between turns: this one goes in when the turn ends.</> } : null);
  if (!note) return null;
  return <p className={`cmd-note${note.bad ? " is-bad" : ""}`}>{note.node}</p>;
}

// The list of what a thread's agent can run, over its box while the box holds "/" and a name being typed. It finds the
// box as the .text-box in the form it's drawn in. `onRun`: what Enter does with "/name" (the form sends by default).
export function CmdPop({ threadId, draftKey, onRun }: { threadId: string; draftKey: string; onRun?: (text: string) => void }) {
  const [text] = useDraft(draftKey);
  const anchor = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  // What the box held when Esc (or the window resizing) closed it: it stays closed until that changes.
  const [shut, setShut] = useState<string | null>(null);
  const [data, setData] = useState<Cmds | null>(() => cmdsNow(threadId));
  const [sel, setSel] = useState(0);
  const [, redraw] = useState(0);
  const box = () => anchor.current?.closest("form")?.querySelector<HTMLElement>(".text-box") || null;
  const m = /^\/([\w:.-]*)$/.exec(text);
  const q = m ? m[1] : "";
  const open = !!m && focused && shut !== text && !isTalkId(threadId);
  const rows = open && data?.runs ? cmdRows(q, data) : [];
  const ok = rows.map((r, i) => (r.isOff ? -1 : i)).filter((i) => i >= 0);
  const at = ok.includes(sel) ? sel : (ok[0] ?? 0);

  // Whether the box has the keys: the list shows only while it does.
  useEffect(() => {
    const tb = box();
    if (!tb) return;
    const on = () => setFocused(true);
    const off = (e: FocusEvent) => !tb.contains(e.relatedTarget as Node) && setFocused(false);
    tb.addEventListener("focusin", on);
    tb.addEventListener("focusout", off);
    if (tb.contains(document.activeElement)) setFocused(true);
    return () => {
      tb.removeEventListener("focusin", on);
      tb.removeEventListener("focusout", off);
    };
  }, []);
  useEffect(() => {
    if (open && !data) threadCmds(threadId).then(setData);
  }, [open, data, threadId]);
  // A new name typed: the first it can run is picked.
  useEffect(() => setSel(0), [q]);

  // Tab: "/name " in the box, to write what it takes. Enter: run it, unless it needs something.
  const pick = (i: number, run: boolean) => {
    const c = rows[i];
    if (!c || c.isOff) return;
    setDraft(draftKey, `/${c.name} `);
    setShut(`/${c.name} `);
    if (!(run && c.takes !== "req")) return;
    const form = anchor.current?.closest("form");
    setTimeout(() => (onRun ? onRun(`/${c.name}`) : form?.requestSubmit()));
  };

  // Its keys come first, before Enter sends.
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      const tb = box();
      if (!tb || !tb.contains(e.target as Node) || e.isComposing) return;
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && ok.length) {
        const i = ok.indexOf(at);
        setSel(ok[(i + (e.key === "ArrowDown" ? 1 : -1) + ok.length) % ok.length]);
      } else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && ok.includes(at)) pick(at, e.key === "Enter");
      else if (e.key === "Escape") setShut(text);
      // A name it doesn't have, half typed, doesn't go: a space after it sends it as words.
      else if (e.key === "Enter" && !e.shiftKey && data?.runs && q) {
        /* stays */
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    const resize = () => setShut(text);
    const scroll = () => redraw((n) => n + 1);
    document.addEventListener("keydown", key, true);
    addEventListener("resize", resize);
    document.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      removeEventListener("resize", resize);
      document.removeEventListener("scroll", scroll, true);
    };
  });

  // Over the box (under it when there's no room above), as wide as it, within the window.
  useLayoutEffect(() => {
    const el = pop.current;
    const tb = box();
    if (!el || !tb) return;
    const r = tb.getBoundingClientRect();
    const width = Math.min(Math.max(380, r.width), innerWidth - 24, 600);
    el.style.width = `${width}px`;
    el.style.left = `${Math.max(12, Math.min(r.left, innerWidth - width - 12))}px`;
    const h = el.offsetHeight;
    el.style.top = `${r.top - h - 8 > 8 ? r.top - h - 8 : r.bottom + 8}px`;
    el.querySelector(".is-on")?.scrollIntoView({ block: "nearest" });
    // The box says which row is picked, for a screen reader.
    const input = tb.querySelector<HTMLElement>("[contenteditable], textarea, input");
    if (input) {
      input.setAttribute("aria-controls", "cmd-pop");
      if (rows[at] && !rows[at].isOff) input.setAttribute("aria-activedescendant", `cp-${at}`);
      else input.removeAttribute("aria-activedescendant");
    }
  });
  useEffect(() => {
    if (open) return;
    box()?.querySelector("[aria-activedescendant]")?.removeAttribute("aria-activedescendant");
  }, [open]);

  const s = threadRow(threadId);
  const agent = s ? agentOf(s.agent) : null;
  const head = (left: ReactNode, right: ReactNode = "") => (
    <div className="mp-h">
      <span>{left}</span>
      <span>{right}</span>
    </div>
  );
  const bold = (name: string) =>
    q && name.toLowerCase().startsWith(q.toLowerCase()) ? (
      <>
        <b>/{name.slice(0, q.length)}</b>
        {name.slice(q.length)}
      </>
    ) : (
      `/${name}`
    );
  const chip = (c: Cmd) => (c.from === "plugin" ? <span className="chip cmd-from cmd-from--plugin">{c.plugin || "plugin"}</span> : c.from === "project" ? <span className="chip cmd-from cmd-from--project">project</span> : <span className="chip cmd-from">{c.from}</span>);
  let body: ReactNode;
  if (!data)
    body = (
      <>
        {head("Commands")}
        <p className="mp-none">Asking {agent?.name || "its machine"} what it can run…</p>
      </>
    );
  else if (data.error)
    body = (
      <>
        {head("Commands")}
        <p className="mp-none">Couldn't list its commands: {data.error}</p>
      </>
    );
  else if (!data.runs)
    body = (
      <>
        {head("Commands")}
        <p className="mp-none">
          <Icon name="terminal" /> {data.why === "terminal" ? "This session is open in a terminal, so its commands run there." : `${agent?.name || "Its agent"} takes no commands from here.`} What you write here reaches it as text.
        </p>
      </>
    );
  else
    body = (
      <>
        {head(q ? `Matching “/${q}”` : `What ${agent?.name || "it"} can run here`, `${agent?.name || ""} · ${data.list.length}`)}
        <div className="mp-rows">
          {rows.length ? (
            rows.map((c, i) =>
              c.isOff ? (
                <div className="mp-row is-off" role="option" aria-disabled="true" key={`off-${c.name}`}>
                  <span className="mp-k mp-k--cmd">/</span>
                  <span className="mp-t">
                    <span className="cmd-name">/{c.name}</span>
                    <small>Not from here: it {c.why}.</small>
                  </span>
                </div>
              ) : (
                <button className={`mp-row${i === at ? " is-on" : ""}`} type="button" role="option" id={`cp-${i}`} aria-selected={i === at} key={c.name} onClick={() => pick(i, false)}>
                  <span className="mp-k mp-k--cmd">/</span>
                  <span className="mp-t">
                    <span className="cmd-name">
                      {bold(c.name)}
                      {c.hint && <span className="cmd-hint">{c.hint}</span>}
                    </span>
                    <small title={c.description}>{c.description}</small>
                  </span>
                  {chip(c)}
                </button>
              ),
            )
          ) : (
            <p className="mp-none">
              It has no <b>/{q}</b>. Keep typing, or a space leaves it as text.
            </p>
          )}
        </div>
        <div className="mp-keys">
          <span>↑↓ move</span>
          <span>Tab adds it</span>
          <span>Enter runs it</span>
          <span>Esc closes</span>
        </div>
      </>
    );
  return (
    <>
      <span ref={anchor} hidden />
      {open &&
        createPortal(
          // The box keeps its cursor: a press on the list doesn't take it.
          <div className="cmd-pop" role="listbox" id="cmd-pop" ref={pop} style={s ? hueVars(s.agent) : undefined} onMouseDown={(e) => e.preventDefault()}>
            {body}
          </div>,
          document.body,
        )}
    </>
  );
}
