/* ---------- the Contacts box on your profile ---------- */
// Your contacts and the asks waiting, in one list: asks to you first, then yours, then your contacts by name. Becoming
// contacts is an ask the other says yes to; then each sees
// what the other made public. Whether a contact's things are in your feed is yours alone ("Follow is only used for
// content staying in your main feed or not"). Removing one takes each of you off everything of the other's.
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { create } from "zustand";
import { post } from "../../lib/api.ts";
import { agoText } from "../../lib/format.ts";
import { personHref } from "../../lib/route.ts";
import { loadPeople } from "../../lib/session.ts";
import { getApp, useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { ContactState, ContactsList, Person, RemoteInfo } from "../../lib/types.ts";
import { PersonAvatar } from "../Avatar.tsx";
import { day } from "../agents/words.ts";
import { Icon } from "../Icon.tsx";
import { MenuPick } from "../MenuPick.tsx";

// The box's own state, kept while you move about the page: the Add box, what's typed in it, and a remove waiting for
// its second click (the username).
interface CtState {
  adding: boolean;
  q: string;
  note: string;
  suggest: boolean;
  removing: string | null;
}
const useCt = create<CtState>(() => ({ adding: false, q: "", note: "", suggest: false, removing: null }));
const setCt = (p: Partial<CtState>) => useCt.setState(p);

// A change of how you and someone stand, said, then the page read again (`reload`).
async function contactDo(username: string, act: string, reload: () => unknown, said: string, note = "") {
  const r = await post(`/api/people/${encodeURIComponent(username)}/contact`, { act, ...(note ? { note } : {}) });
  if (r.ok) toast(said);
  setCt({ removing: null });
  await reload();
  return r;
}
async function followDo(username: string, follow: boolean, reload: () => unknown) {
  const r = await post(`/api/people/${encodeURIComponent(username)}/follow`, { follow });
  if (r.ok) toast(follow ? `@${username}'s public things are in your feed.` : `@${username}'s things stay on their profile, out of your feed.`);
  await reload();
}
const ASK_SAID = (u: string) => `Asked @${u}. You're contacts once they say yes.`;

// A contact's menu: Following (their public things in your feed) or not, and removing them.
function ContactMenu({ user, following, reload }: { user: string; following: boolean; reload: () => unknown }) {
  return (
    <MenuPick
      id={`ct:${user}`}
      label="Contact"
      title={following ? `@${user}'s public things are in your feed` : `@${user}'s public things are on their profile, not in your feed`}
      face={
        <>
          <Icon name={following ? "eye" : "eyeOff"} />
          <span className="opt-v">{following ? "Following" : "Not following"}</span>
          <Icon name="down" className="caret" />
        </>
      }
      rows={[
        { value: "on", text: "Following", on: following, face: <Icon name="eye" />, note: "In your feed" },
        { value: "off", text: "Not following", on: !following, face: <Icon name="eyeOff" />, note: "On their profile" },
        { divider: "" },
        { value: "remove", text: "Remove contact", face: <Icon name="x" /> },
      ]}
      onPick={(v) => (v === "remove" ? setCt({ removing: user }) : (v === "on") !== following ? followDo(user, v === "on", reload) : undefined)}
    />
  );
}
// Before removing someone: what goes with it.
function RemoveConfirm({ user, reload }: { user: string; reload: () => unknown }) {
  return (
    <>
      <p className="fl-says">
        <b>@{user}</b> stops seeing what you made public, and comes off everything of yours they're on (threads, tasks, groups, pages, notes), as you do off theirs.
      </p>
      <div className="fl-asks">
        <button className="btn btn--dark btn--sm" type="button" onClick={(e) => ((e.currentTarget.disabled = true), contactDo(user, "remove", reload, `@${user} isn't your contact any more.`))}>
          Remove @{user}
        </button>
        <button className="btn btn--line btn--sm" type="button" onClick={() => setCt({ removing: null })}>
          Back
        </button>
      </div>
    </>
  );
}
// Yes or no to someone's ask.
function Answer({ user, reload }: { user: string; reload: () => unknown }) {
  return (
    <div className="fl-asks">
      <button className="btn btn--dark btn--sm" type="button" title={`You each see what the other made public, and @${user}'s is in your feed`} onClick={() => contactDo(user, "yes", reload, `You and @${user} are contacts now.`)}>
        Yes
      </button>
      <button className="btn btn--line btn--sm" type="button" onClick={() => contactDo(user, "no", reload, `Said no. @${user} can ask again.`)}>
        No
      </button>
    </div>
  );
}
// Someone on another agentbook: said so, and what waits for their door while it's off.
function Elsewhere({ remote }: { remote: RemoteInfo }) {
  const off = remote.reach && !remote.reach.ok;
  return (
    <p className="fl-where">
      On their own agentbook
      {remote.waiting > 0 ? ` · ${remote.waiting} waiting for their machine${off ? `, off since ${agoText(new Date(remote.reach.at).toISOString())}` : ""}` : ""}
    </p>
  );
}

type Row = { user: string; display_name: string; remote?: unknown; kind: "asks" | "asked" | "contact"; at: string | null; note?: string | null; following?: boolean };
function rowsOf(d: ContactsList): Row[] {
  const rank = { asks: 0, asked: 1, contact: 2 };
  const asks: Row[] = d.asks.map((a) => ({ ...a, kind: a.yours ? "asked" : "asks", at: a.at }));
  const contacts: Row[] = d.contacts.map((c) => ({ ...c, kind: "contact", at: c.since }));
  return [...asks, ...contacts].sort((a, b) => rank[a.kind] - rank[b.kind] || (a.kind === "contact" ? a.display_name.localeCompare(b.display_name) : String(b.at).localeCompare(String(a.at))));
}
function ContactRow({ r, reload }: { r: Row; reload: () => unknown }) {
  const removing = useCt((s) => s.removing === r.user);
  let body: ReactNode;
  if (r.kind === "asks")
    body = (
      <>
        <div className="fl-chips">
          <span className="chip chip--sun">Asks to be your contact</span>
        </div>
        {r.note && <p className="fl-says">“{r.note}”</p>}
        <Answer user={r.user} reload={reload} />
      </>
    );
  else if (r.kind === "asked")
    body = (
      <div className="fl-chips">
        <span className="fl-c fl-c--wait" title={`Waiting for @${r.user} to say yes`}>
          Asked {agoText(r.at)}
          <button className="chip-x" type="button" aria-label="Take back your ask" title="Take back your ask" onClick={() => contactDo(r.user, "take_back", reload, "Took back your ask.")}>
            <Icon name="x" />
          </button>
        </span>
      </div>
    );
  else
    body = removing ? (
      <RemoveConfirm user={r.user} reload={reload} />
    ) : (
      <div className="fl-chips">
        <ContactMenu user={r.user} following={!!r.following} reload={reload} />
      </div>
    );
  return (
    <li className={`fl-row${r.kind === "asks" ? " fl-row--ask" : ""}`}>
      <a href={personHref(r.user)}>
        <PersonAvatar who={r.user} size="av--sm" />
      </a>
      <div>
        <a className="fl-nm" href={personHref(r.user)}>
          <b>{r.display_name}</b>
          <small>@{r.user}</small>
          {r.at && <time title={r.kind === "contact" ? `Contacts since ${day(r.at)}` : undefined}>{r.kind === "contact" ? `since ${day(r.at)}` : agoText(r.at)}</time>}
        </a>
        {r.remote ? <Elsewhere remote={r.remote as RemoteInfo} /> : null}
        {body}
      </div>
    </li>
  );
}

// An invite link someone gave you (server/door.ts's inviteLink), or what's after its #.
const isInvite = (q: string) => /\/invite#v1\.|^\s*v1\.[A-Za-z0-9_-]{20,}/.test(q);
// People here to ask: not you, not a contact, not asked either way.
function Suggest({ d, reload }: { d: ContactsList; reload: () => unknown }) {
  const q0 = useCt((s) => s.q);
  const note = useCt((s) => s.note);
  const people = useApp((s) => s.people);
  const me = useApp((s) => s.me);
  const known = new Set([...d.contacts.map((c) => c.user), ...d.asks.map((a) => a.user)]);
  const q = q0.trim().replace(/^@/, "").toLowerCase();
  const hit = (s: string | null | undefined) => !q || String(s || "").toLowerCase().includes(q);
  const shown = (people || []).filter((x) => x.username !== me?.username && !x.deleted && !x.disabled && !known.has(x.username) && (hit(x.display_name) || hit(x.username))).slice(0, 8);
  if (shown.length)
    return (
      <div className="fb-menu">
        <div className="fb-list">
          {shown.map((u) => (
            <button key={u.username} className="fb-row" type="button" onClick={() => (setCt({ adding: false, q: "", note: "" }), contactDo(u.username, "ask", reload, ASK_SAID(u.username), note.trim()))}>
              <PersonAvatar who={u.username} size="av--xs" />
              <span className="fb-nm">
                {u.display_name || u.username} <small>@{u.username}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  return q0.trim() ? (
    <div className="fb-menu">
      <p className="fl-none">{isInvite(q0) ? "Your ask goes to whoever this invite link is for." : "Nobody here called that. For someone on another agentbook, paste the invite link they gave you."}</p>
    </div>
  ) : null;
}
function AddBox({ d, reload }: { d: ContactsList; reload: () => unknown }) {
  const { adding, q, note, suggest } = useCt();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (adding) input.current?.focus();
  }, [adding]);
  if (!adding) return null;
  const ask = (username: string) => {
    setCt({ adding: false, q: "", note: "" });
    return contactDo(username, "ask", reload, ASK_SAID(username), note.trim());
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const s = getApp();
    // Someone on another agentbook, by the invite link they gave you (server/api/door.ts): their row here, then asked.
    if (isInvite(q))
      return void post<{ user: Person }>("/api/people/find", { link: q.trim() }).then((r) => {
        if (!r.ok) return;
        loadPeople();
        return ask(r.data.user.username);
      });
    const who = q.trim().replace(/^@/, "").toLowerCase();
    if (!who) return void toast("Who? Type their @username, or paste their invite link.");
    const u = (s.people || []).find((x) => x.username === who);
    if (u && u.username !== s.me?.username) return void ask(u.username);
    toast(`Nobody here is @${who}. For someone on another agentbook, paste the invite link they gave you.`);
  };
  return (
    <div className="fl-add">
      <p>Ask someone here by their @username, or someone on another agentbook by pasting the invite link they gave you. You're contacts once they say yes: each of you sees what the other made public.</p>
      <form onSubmit={submit}>
        <input ref={input} value={q} placeholder="@username or an invite link" autoComplete="off" spellCheck={false} aria-label="Who to ask" onChange={(e) => setCt({ q: e.target.value, suggest: true })} onKeyDown={(e) => e.key === "Escape" && setCt({ adding: false })} />
        <input value={note} placeholder="A line for them (optional)" maxLength={500} aria-label="A line for them" onChange={(e) => setCt({ note: e.target.value })} onKeyDown={(e) => e.key === "Escape" && setCt({ adding: false })} />
        <button className="btn btn--dark btn--sm" type="submit">
          Ask
        </button>
        <button className="btn btn--line btn--sm" type="button" onClick={() => setCt({ adding: false })}>
          Cancel
        </button>
      </form>
      <div>{suggest ? <Suggest d={d} reload={reload} /> : null}</div>
    </div>
  );
}

export function ContactsBox({ contacts: d, reload }: { contacts: ContactsList | null; reload: () => unknown }) {
  useApp((s) => s.people); // names, as everyone's are known
  if (!d)
    return (
      <section className="card box fl-box">
        <h3>Contacts</h3>
        <p className="muted">Loading…</p>
      </section>
    );
  const rows = rowsOf(d);
  const asking = d.asks.filter((a) => !a.yours).length;
  const add = () => {
    const adding = !useCt.getState().adding;
    setCt({ adding, suggest: adding, q: "", note: "" });
    if (adding) loadPeople();
  };
  return (
    <section className="card box fl-box">
      <h3>
        <span>
          Contacts
          {asking > 0 && (
            <>
              {" "}
              <span className="chip chip--sun" title={`${asking} waiting for you to say yes or no`}>
                {asking} asking
              </span>
            </>
          )}
        </span>
        <button className="fl-h-btn" type="button" title="Ask someone to be your contact" onClick={add}>
          <Icon name="plus" />
          Add a contact
        </button>
      </h3>
      <AddBox d={d} reload={reload} />
      {rows.length ? (
        <ul className="fl-list">
          {rows.map((r) => (
            <ContactRow key={`${r.kind}:${r.user}`} r={r} reload={reload} />
          ))}
        </ul>
      ) : (
        <p className="fl-empty">No contacts yet. Add someone: once they say yes, each of you sees what the other made public.</p>
      )}
    </section>
  );
}

// On someone else's profile: how you two stand, and what you can do about it.
export function PersonContactActs({ u, c, reload }: { u: Person; c: ContactState | null | undefined; reload: () => unknown }) {
  const removing = useCt((s) => s.removing === u.username);
  if (!c || u.deleted) return null;
  if (c.contact)
    return removing ? (
      <div className="prof-confirm">
        <RemoveConfirm user={u.username} reload={reload} />
      </div>
    ) : (
      <>
        <span className="chip" title={c.since ? `Contacts since ${day(c.since)}` : "Your contact"}>
          <Icon name="check" />
          Contact
        </span>
        <ContactMenu user={u.username} following={c.following} reload={reload} />
      </>
    );
  if (u.disabled) return null;
  if (c.asks_you)
    return (
      <>
        <span className="chip chip--sun" title={c.note ? `“${c.note}”` : undefined}>
          Asks to be your contact
        </span>
        <Answer user={u.username} reload={reload} />
      </>
    );
  if (c.asked)
    return (
      <>
        <span className="chip chip--sun" title={`Waiting for @${u.username} to say yes`}>
          Asked {agoText(c.asked)}
        </span>
        <button className="btn btn--line" type="button" onClick={() => contactDo(u.username, "take_back", reload, "Took back your ask.")}>
          <Icon name="x" />
          Take back
        </button>
      </>
    );
  return (
    <button className="btn btn--dark" type="button" title={`Ask @${u.username} to be your contact: once they say yes, each of you sees what the other made public.`} onClick={() => contactDo(u.username, "ask", reload, ASK_SAID(u.username))}>
      <Icon name="plus" />
      Add as contact
    </button>
  );
}
