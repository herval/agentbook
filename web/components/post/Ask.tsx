// What a thread asks you, in its conversation (askBlock): a permission prompt, an approval, a pick of one or several,
// a file, or words; and why it needs you when there's nothing to answer here (waitingElsewhere: a prompt elsewhere, or
// an API error that cut off its turn, cutOffLine, which an expired login is, loginExpired).
import { useState } from "react";
import type { ReactNode } from "react";
import { create } from "zustand";
import { drivenBy, typedIn, waits } from "../../lib/agents.ts";
import { pickFile, post, upload } from "../../lib/api.ts";
import type { Reply } from "../../lib/api.ts";
import { ago, clock, hueVars, plural } from "../../lib/format.ts";
import { toast } from "../../lib/toast.ts";
import { threadRow, useThreadRecord, useThreadRow } from "../../lib/store.ts";
import type { Message, Question, Thread } from "../../lib/types.ts";
import { seen } from "./util.tsx";
import { Avatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import { modesOf, switchesHere } from "../thread/Switch.tsx";
import type { Mode } from "../../../plugin/shared/runtimes.ts";

// A bare URL in plain text, without the punctuation, emphasis or quote that ends it.
const BARE_URL = /(^|[\s(*_~…<"'])(https?:\/\/[^\s<*"']*[^\s<.,;:!?)*_~"'])/g;
export function LinkUrls({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(BARE_URL)) {
    const at = m.index + m[1].length;
    out.push(text.slice(last, at));
    out.push(
      <a className="md-link" href={m[2]} target="_blank" rel="noopener" key={at}>
        {m[2]}
      </a>,
    );
    last = at + m[2].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

// An answer that waits for its machine says so.
export const answerWaits = (r: Reply) => r?.ok && r.data?.queued && toast(waits(r.data, "your answer reaches it if that's within a minute"));
export const answerQ = (id: string, body: { value?: string; skip?: boolean; mode?: Mode }) => post(`/api/questions/${encodeURIComponent(id)}/answer`, body).then(answerWaits);

// What you've ticked of a question that takes several (S.multi), until you send them.
const useMulti = create<Record<string, string[]>>(() => ({}));

// What a question is about, as it is (the command, the message to send, the link to open), with its URLs as links:
// every kind of question shows it, not only a yes/no.
const AskPreview = ({ q }: { q: Question }) =>
  q.preview ? (
    <pre className="cmd">
      <LinkUrls text={q.preview} />
    </pre>
  ) : null;
const Detail = ({ q }: { q: Question }) => (q.detail ? <p className="ask-text">{q.detail}</p> : null);

export function AskBlock({ q }: { q: Question }) {
  const s = useThreadRow(q.post);
  const picked = useMulti((m) => m[q.id]) || [];
  const [sending, setSending] = useState(false);
  const elsewhere = s?.rt?.kind === "background" ? "It waits for you here" : drivenBy(s) ? `Also waiting in ${drivenBy(s).name}` : `Also waiting in ${typedIn(s)}`;
  const hint = q.default && q.until ? <p className="poll-note">If you don't answer by {clock(q.until)}, it goes with “{q.default}”.</p> : null;
  const answer = (value: string, mode?: Mode) => {
    setSending(true);
    answerQ(q.id, { value, ...(mode ? { mode } : {}) });
  };
  // Allow + Auto, on a thread in Ask that can be switched to Auto: the prompts it would ask next, it doesn't.
  const full = useThreadRecord(q.post);
  const toAuto = q.kind === "permission" && !!full && full.mode === "ask" && switchesHere(full) && modesOf(full).includes("auto");
  // Your own words, in a box.
  const textForm = (other: boolean) => (
    <form
      className={`ask-form${other ? " ask-form--other" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        const v = (e.currentTarget.querySelector("input") as HTMLInputElement).value.trim();
        if (v) answerQ(q.id, { value: v });
      }}
    >
      <input type="text" placeholder={other ? "Or answer in your own words" : "Your answer"} aria-label={other ? "Your own answer" : "Your answer"} defaultValue={other ? undefined : q.default || undefined} />
      <button className={other ? "btn" : "btn btn--dark"} type="submit">
        Send
      </button>
    </form>
  );
  let body: ReactNode;
  if (q.kind === "permission") {
    body = (
      <>
        <Detail q={q} />
        <AskPreview q={q} />
        <div className="ask-acts">
          <button className="btn btn--dark" type="button" onClick={() => answer("allow")}>
            Allow
          </button>
          {toAuto && (
            <button className="btn" type="button" data-allow-auto="" title="Allow this, and switch the thread to Auto: it stops asking about steps that aren't risky" onClick={() => answer("allow", "auto")}>
              Allow + Auto
            </button>
          )}
          <button className="btn" type="button" onClick={() => answer("deny")}>
            Deny
          </button>
          <span className="muted">{elsewhere}</span>
        </div>
      </>
    );
  } else if (q.kind === "approve") {
    const [yes, no] = [q.options[0]?.label || "Approve", q.options[1]?.label || "Reject"];
    body = (
      <>
        <Detail q={q} />
        <AskPreview q={q} />
        <div className="ask-acts">
          <button className="btn btn--dark" type="button" onClick={() => answer(yes)}>
            {yes}
          </button>
          <button className="btn" type="button" onClick={() => answer(no)}>
            {no}
          </button>
        </div>
        {hint}
      </>
    );
  } else if (q.kind === "choice") {
    body = (
      <>
        <Detail q={q} />
        <AskPreview q={q} />
        <div className="poll">
          {q.options.map((o) => (
            <button className="poll-opt" type="button" key={o.label} onClick={() => answer(o.label)}>
              <b>{o.label}</b>
              {o.detail && <small>{o.detail}</small>}
              {q.default === o.label && <span className="pick">Its pick</span>}
            </button>
          ))}
        </div>
        {hint}
      </>
    );
  } else if (q.kind === "multi") {
    const on = new Set(picked);
    body = (
      <>
        <Detail q={q} />
        <AskPreview q={q} />
        <div className="poll poll--multi">
          {q.options.map((o) => (
            <button
              className={`poll-opt${on.has(o.label) ? " is-on" : ""}`}
              type="button"
              key={o.label}
              aria-pressed={on.has(o.label)}
              onClick={() => useMulti.setState((m) => ({ [q.id]: on.has(o.label) ? (m[q.id] || []).filter((x) => x !== o.label) : [...(m[q.id] || []), o.label] }))}
            >
              <b>{o.label}</b>
              {o.detail && <small>{o.detail}</small>}
            </button>
          ))}
        </div>
        <div className="ask-acts">
          <button className="btn btn--dark" type="button" disabled={!on.size} onClick={() => on.size && answer(picked.join(", "))}>
            Send {on.size ? plural(on.size, "choice") : "your choices"}
          </button>
          <span className="muted">Pick any that apply.</span>
        </div>
      </>
    );
  } else if (q.kind === "file") {
    body = (
      <>
        <Detail q={q} />
        <AskPreview q={q} />
        <div className="ask-acts">
          <button className="btn btn--dark" type="button" onClick={() => pickFile((file) => upload(file, { question: q.id }))}>
            <Icon name="clip" />
            Choose a file
          </button>
        </div>
        {hint}
      </>
    );
  } else {
    body = (
      <>
        <Detail q={q} />
        <AskPreview q={q} />
        {textForm(false)}
        {hint}
      </>
    );
  }
  const flag = q.kind === "permission" ? `Wants to use ${q.tool_name || "a tool"}` : "Asks you";
  return (
    <div className={`ask${sending ? " is-sending" : ""}`} data-ask={q.id}>
      <p className="ask-flag">
        <Icon name="hand" />
        {flag}
        <span className="muted">{ago(q.asked)}</span>
        {/* Any question but a permission prompt (that's what Deny is for) can be skipped. */}
        {q.kind !== "permission" && (
          <button
            className="ask-skip"
            type="button"
            onClick={() => {
              setSending(true);
              answerQ(q.id, { skip: true });
            }}
          >
            Skip
          </button>
        )}
      </p>
      {q.kind !== "permission" && <p className="ask-q">{q.title}</p>}
      {body}
      {/* Claude's questions take an answer of your own too, as its terminal prompt does. */}
      {q.other && (q.kind === "choice" || q.kind === "multi") && textForm(true)}
    </div>
  );
}

// A question still open, or a prompt it waits on elsewhere, as the agent's turn in the conversation.
export const InConvo = ({ thread: s, children }: { thread: Pick<Thread, "agent">; children: ReactNode }) => (
  <div className="cmt cmt-agent cmt-open" style={hueVars(s.agent)}>
    <Avatar agent={s.agent} size="av--sm" />
    <div className="cmt-wide">{children}</div>
  </div>
);
// Where a question goes in the conversation: under the first message its agent wrote after asking it, if it was
// still open then and you hadn't written since. Agents ask, then end their turn summing up what the question is
// about, and the question reads under that, as what it leads to. One the agent waits on (Claude's own questions,
// a permission prompt) is answered before it writes again, and stays where it was asked. A file it sent isn't
// something it wrote. Listed after the messages, the sort keeps it under the one it goes with.
export function askSpot(q: Question, messages: Message[]): string {
  const next = messages.reduce<Message | null>((a, m) => (m.at > q.asked && (m.from === "human" || m.text) && (!a || m.at < a.at) ? m : a), null);
  return next && next.from !== "human" && (!q.answered || q.answered > next.at) ? next.at : q.asked;
}
export const askerOf = (q: Question, s: Thread): Thread => (q.post === s.id ? s : { ...s, agent: (s.guests || []).find((g) => g.id === q.post)?.agent ?? s.agent });
// The questions of a thread's conversation: its own, those its guests ask, and those a guest that left had answered.
export function threadQs(s: Thread, qs: Question[]): Question[] {
  const on = new Set((s.guests || []).filter((g) => !seen(g).removed).map((g) => g.id));
  const was = new Set((s.guests || []).map((g) => g.id));
  return qs.filter((q) => q.post === s.id || on.has(q.post) || (was.has(q.post) && q.answered));
}

// A session that needs you, with nothing to answer here: it waits in a prompt of its own (say where), or an API
// error stopped its turn (cutOffLine says which). One whose turn ended saying it needs you or is blocked (`asking`)
// says what in that reply, with replies to pick.
export function WaitingElsewhere({ thread: s }: { thread: Thread }) {
  if (s.mine === false) return null;
  if (s.effective !== "needs" || s.failed) return <CutOffLine thread={s} />;
  if (seen(s).asking) return null;
  const bg = s.rt?.kind === "background";
  const where = bg ? "It's waiting in Claude Code's own prompt, which only a terminal reaches." : drivenBy(s) ? `It's waiting in ${drivenBy(s).name}.` : "It's waiting in its terminal.";
  return (
    <div className="ask">
      <p className="ask-flag">
        <Icon name="hand" />
        {s.doing || "Waiting for you"}
      </p>
      <p className="ask-text">{where}</p>
    </div>
  );
}
// Whether WaitingElsewhere draws anything, so the card leaves out its place in the conversation when it doesn't.
export const waitsElsewhere = (s: Thread) => s.mine !== false && (s.effective !== "needs" || s.failed ? cutsOff(s) : !seen(s).asking);

// Retry picks a turn back up now.
function PickupButton({ thread: s }: { thread: Thread }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn btn--line btn--sm"
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const r = await post(`/api/sessions/${encodeURIComponent(s.id)}/pickup`, {});
        if (!r.ok) setBusy(false);
        else if (r.data.queued) toast(waits(r.data, "it's picked up"));
      }}
    >
      <Icon name="sync" />
      <span>{busy ? "Retrying…" : "Retry"}</span>
    </button>
  );
}

// A turn an API error cut off (the network dropped, the computer slept mid-reply): its machine picks it up again once
// Claude's API answers (`pickup`: when it next tries), and writing to it picks it up now. One that time won't fix
// needs you: an expired login, its machine picks up once you've signed in again (`pickup` "login"), and one in a
// terminal, once you write to it; its account, once you write to it; a usage limit or a refused request, once you
// write to it or press Retry.
const ACCOUNT_ERRORS = new Set(["oauth_org_not_allowed", "account_on_hold", "verification_required", "billing_error"]);
const cutsOff = (s: Thread) => !(!s.failed || s.busy || s.state === "done" || s.offline || s.effective === "working");
export function CutOffLine({ thread: s }: { thread: Thread }) {
  if (!cutsOff(s)) return null;
  const why = s.failed.text || "An API error ended its turn";
  const error = s.failed.error;
  const picking = !!s.pickup && Date.parse(s.pickup) <= Date.now();
  // Retry picks it up now, whatever cut it off, in the background (one in a terminal is written to there).
  const retry = s.mine !== false && !picking && (s.rt?.kind === "background" || s.asleep);
  if (s.effective === "needs") {
    const said = why.replace(/\.$/, "");
    if (error === "authentication_failed") return <LoginExpired thread={s} />;
    if (ACCOUNT_ERRORS.has(error)) return <AskNote flag="Your Claude account needs you" icon="alert" text={`Claude Code couldn't reply: ${said}. Sort it out with your Anthropic account, then write to it to pick it up.`} />;
    const limit = error === "rate_limit";
    const how = picking ? "Picking it up." : `It won't go on by itself: ${retry ? "press Retry or write to it" : "write to it"}${limit ? " once that has reset" : ""}.`;
    return (
      <AskNote flag={limit ? "Usage limit" : "Claude stopped this turn"} icon="alert" text={`${said}. ${how}`}>
        {retry && (
          <div className="ask-acts">
            <PickupButton thread={s} />
          </div>
        )}
      </AskNote>
    );
  }
  const next = !s.pickup ? "write to it to pick it up" : picking ? "picking it up" : `picks up again at ${clock(s.pickup)}`;
  return (
    <div className="live live--cut" title={why}>
      <Icon name="alert" />
      <b>{why.split(/(?<=\.)\s/)[0]}</b>
      <span className="muted live-n">{next}</span>
      {retry && (
        <span className="live-acts">
          <PickupButton thread={s} />
        </span>
      )}
    </div>
  );
}
// A note in a question's frame: what, and why.
function AskNote({ flag, icon, text, children }: { flag: string; icon: "alert" | "check" | "hand"; text: ReactNode; children?: ReactNode }) {
  return (
    <div className="ask">
      <p className="ask-flag">
        <Icon name={icon} />
        {flag}
      </p>
      <p className="ask-text">{text}</p>
      {children}
    </div>
  );
}

// Claude Code's expired login, signed in again from here (cli/claude-signin.ts, through /claude-login): Sign in gets
// a link to claude.ai from the thread's machine, you sign in there wherever you are, and paste back the code it shows
// you. Kept per machine, so every thread that login cut off shows the same link: { url, at, sending } while there's
// a link (its machine ends it after 10 minutes), { done } once it's signed in.
const useSignins = create<Record<string, { url?: string; at?: number; sending?: boolean; done?: number; starting?: boolean }>>(() => ({}));
const SIGNIN_LINK_MS = 9 * 60e3;
export function LoginExpired({ thread: s }: { thread: Thread }) {
  const si = useSignins((x) => (s.machine ? x[s.machine] : undefined));
  const [code, setCode] = useState("");
  const on = s.machine ? ` on ${s.machine}` : "";
  const auto = s.pickup === "login";
  const can = s.mine !== false && !!s.machine && !s.cloud;
  const m = s.machine || "";
  const set = (v: Record<string, unknown> | null) => useSignins.setState((x) => (v ? { ...x, [m]: { ...x[m], ...v } } : Object.fromEntries(Object.entries(x).filter(([k]) => k !== m))));
  // Signed in, its machine picks it up a moment later (`pickup` turns from "login" to when); one in a terminal waits.
  if (can && si?.done && si.done > Date.parse(s.failed?.at || "0"))
    return (
      <AskNote flag="Signed in" icon="check" text={`Claude Code${on} is signed in again. ${s.pickup ? "It picks up by itself in a moment." : "Write to it to pick it up."}`} />
    );
  if (can && si?.url && Date.now() - si.at < SIGNIN_LINK_MS) {
    // The code claude.ai showed: its machine's Claude Code finishes signing in with it, and the threads that login cut
    // off are picked up. A code it didn't take uses its link up.
    const send = async (e: React.FormEvent) => {
      e.preventDefault();
      const c = code.trim();
      if (!c || si.sending) return;
      set({ sending: true });
      (document.activeElement as HTMLElement | null)?.blur();
      const r = await post<{ ended?: boolean }>(`/api/sessions/${encodeURIComponent(s.id)}/claude-login`, { step: "code", code: c });
      if (r.ok) {
        useSignins.setState((x) => ({ ...x, [m]: { done: Date.now() } }));
        toast(`Claude Code on ${m} is signed in again.`);
      } else if (r.data.ended) set(null);
      else set({ sending: false });
    };
    return (
      <AskNote flag="Sign in to Claude" icon="alert" text={`Sign in to claude.ai with the account Claude Code${on} should use, then paste the code it shows you here.`}>
        <div className="ask-acts">
          <a className="btn btn--line btn--sm" href={si.url} target="_blank" rel="noopener noreferrer">
            <Icon name="external" />
            Open claude.ai
          </a>
          <button className="ask-skip" type="button" onClick={() => set(null)}>
            Cancel
          </button>
        </div>
        <form className="ask-form" onSubmit={send}>
          <input type="text" name="code" placeholder="Paste the code" aria-label="The code claude.ai shows you" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={si.sending} value={code} onChange={(e) => setCode(e.target.value)} />
          <button className="btn btn--dark" type="submit" disabled={si.sending}>
            {si.sending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </AskNote>
    );
  }
  if (!can)
    return (
      <AskNote
        flag="Login expired"
        icon="alert"
        text={
          <>
            Claude Code's login expired, so it couldn't reply. Sign in again{on}: <code>/login</code> in any Claude Code session, or <code>claude auth login</code> in a terminal. {auto ? "It picks up by itself once you have." : "Then write to it to pick it up."}
          </>
        }
      />
    );
  // Sign in on a Login expired card: its machine starts signing Claude Code in, and the card shows the link.
  const start = async () => {
    set({ starting: true });
    const r = await post<{ url: string }>(`/api/sessions/${encodeURIComponent(s.id)}/claude-login`, { step: "start" });
    if (r.ok) useSignins.setState((x) => ({ ...x, [m]: { url: r.data.url, at: Date.now() } }));
    else set({ starting: false });
  };
  return (
    <AskNote
      flag="Login expired"
      icon="alert"
      text={
        <>
          Claude Code's login{on} expired, so it couldn't reply. Sign in again here{auto ? " and it picks up by itself" : ", then write to it to pick it up"}, or with <code>/login</code> in any Claude Code session there.
        </>
      }
    >
      <div className="ask-acts">
        <button className="btn btn--dark btn--sm" type="button" disabled={si?.starting} onClick={start}>
          <Icon name="key" />
          <span>{si?.starting ? "Getting a link…" : "Sign in"}</span>
        </button>
      </div>
    </AskNote>
  );
}
export const threadOfQ = (q: Question) => threadRow(q.post);
