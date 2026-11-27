// Your agent's avatar on its profile opens a menu to change it: a picture, an emoji, or back to its own (an OpenClaw
// agent's) or its letter. Yours on your profile does too (key: ME), and goes back to your letter.
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { pickFile, post } from "../../lib/api.ts";
import { hueVars } from "../../lib/format.ts";
import { useDismiss } from "../../lib/hooks.ts";
import { signedOut } from "../../lib/session.ts";
import { getApp, ME, setApp, useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { Person } from "../../lib/types.ts";
import { Avatar, avatarUrl, glyph, PersonAvatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import type { AgentRow } from "./types.ts";
import { AVATAR_FROM } from "./words.ts";

// A picture you pick, as an avatar: the square in its middle, at most 256 pixels across.
async function squarePicture(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || 256;
    const h = img.naturalHeight || 256;
    const side = Math.min(w, h);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = Math.min(256, side);
    canvas.getContext("2d").drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((done, failed) => canvas.toBlob((b) => (b ? done(b) : failed(new Error("no picture"))), "image/webp", 0.9));
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Set an avatar: a picture (its bytes), an emoji, or none ({ avatar: null }). An agent's comes back with the state;
// yours is only in what this page knows about you.
async function setAvatar(key: string, body: Blob | object): Promise<{ ok: boolean }> {
  const url = key === ME ? "/api/me/avatar" : `/api/agents/${encodeURIComponent(key)}/avatar`;
  let r: { ok: boolean; data?: { user?: Person; error?: string } };
  if (!(body instanceof Blob)) r = await post<{ user?: Person }>(url, body);
  else {
    const res = await fetch(url, { method: "POST", headers: { "content-type": body.type || "image/png" }, body });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) signedOut();
    else if (!res.ok) toast(data.error || `Something went wrong (HTTP ${res.status})`);
    r = { ok: res.ok, data };
  }
  const user = r.data?.user;
  if (r.ok && key === ME && user) setApp((s) => ({ me: user, people: s.people ? s.people.map((u) => (u.id === user.id ? user : u)) : s.people }));
  return r;
}

// The menu: Upload a picture, an emoji, and back to its own (`back`, when there's one to go back to).
function AvatarMenu({ k, face, title, emoji, back }: { k: string; face: ReactNode; title: string; emoji: string; back: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(emoji);
  // The emoji box loses focus first, or the menu would wait for you to be done typing in it.
  const close = useCallback(() => {
    if ((document.activeElement as HTMLElement)?.closest?.(".av-menu")) (document.activeElement as HTMLElement).blur();
    setOpen(false);
  }, []);
  const ref = useDismiss<HTMLDivElement>(open, close);
  return (
    <div className="av-pick" ref={ref}>
      <button
        className="av-btn"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => {
          setTyped(emoji);
          setOpen(!open);
        }}
      >
        {face}
      </button>
      {open && (
        <div className="av-menu" role="menu" aria-label={title}>
          <button
            className="av-opt"
            type="button"
            role="menuitem"
            onClick={() =>
              pickFile(async (file) => {
                const picture = await squarePicture(file).catch(() => null);
                if (!picture) return toast("That file isn't a picture this browser can open.");
                if ((await setAvatar(k, picture)).ok) close();
              }, "image/*")
            }
          >
            <Icon name="image" />
            Upload a picture
          </button>
          <form
            className="av-emoji"
            onSubmit={async (e) => {
              e.preventDefault();
              const v = typed.trim();
              if (v && (await setAvatar(k, { emoji: v })).ok) close();
            }}
          >
            <Icon name="smile" />
            <input name="emoji" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Or type an emoji" title="⌃⌘Space opens the emoji picker on a Mac" aria-label="An emoji" autoComplete="off" spellCheck={false} />
            <button className="btn btn--sm" type="submit">
              Use
            </button>
          </form>
          {back && (
            <button
              className="av-opt"
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                setAvatar(k, { avatar: null });
              }}
            >
              {back}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
// A small face of an agent's in the menu: its own avatar (`pic`), or its letter.
function Mini({ agent, pic }: { agent: string; pic: AgentRow["avatar"] }) {
  const data = useApp((s) => s.data);
  return (
    <span className={`av av--xs${pic?.image ? " av--pic" : ""}`} style={hueVars(agent)}>
      {pic?.image ? <img src={avatarUrl(agent, pic)} alt="" draggable={false} /> : pic?.emoji ? EMOJI.test(pic.emoji) ? <span className="em">{pic.emoji}</span> : pic.emoji : glyph(agent, data)}
    </span>
  );
}

export function AgentAvatarPicker({ agent: a, on }: { agent: AgentRow; on: string }) {
  const def = a.avatar_default;
  const back = !a.avatar ? null : def ? (
    <>
      <Mini agent={a.id} pic={def} />
      Use {AVATAR_FROM[a.kind] || "its own"}'s
    </>
  ) : (
    <>
      <Mini agent={a.id} pic={null} />
      Use its letter
    </>
  );
  return <AvatarMenu k={a.id} face={<Avatar agent={a.id} size="av--hero" on={on} />} title="Change its avatar" emoji={a.avatar?.emoji || ""} back={back} />;
}

export function YourAvatarPicker() {
  const me = useApp((s) => s.me);
  const back = me?.avatar ? (
    <>
      <PersonAvatar who={{ ...me, avatar: null }} size="av--xs" />
      Use your letter
    </>
  ) : null;
  return <AvatarMenu k={ME} face={<PersonAvatar who={me} size="av--hero" />} title="Change your picture" emoji={me?.avatar?.emoji || getApp().me?.avatar?.emoji || ""} back={back} />;
}
