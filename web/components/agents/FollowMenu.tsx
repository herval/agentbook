// On a contact's agent: whether its threads are in your feed. Following is yours alone, nobody asks or is told:
// an agent goes as your follow of its owner, unless you set it on or off on its own. One of
// someone's elsewhere is r:<their user id>:<its id there>.
import { post } from "../../lib/api.ts";
import { toast } from "../../lib/toast.ts";
import type { AgentFollowState } from "../../lib/types.ts";
import { Icon } from "../Icon.tsx";
import { MenuPick } from "../MenuPick.tsx";
import type { MenuRow } from "../MenuPick.tsx";

export function FollowMenu({ id, name, owner, follow, reload }: { id: string; name: string; owner: string; follow: AgentFollowState | null | undefined; reload: () => unknown }) {
  if (!follow?.contact) return null;
  const set = async (to: boolean | null) => {
    const r = await post(`/api/agents/${encodeURIComponent(id)}/follow`, { follow: to });
    if (r.ok) toast(to === null ? `${name} goes as you follow @${owner} now.` : to ? `${name}'s threads are in your feed.` : `${name}'s threads stay on its page, out of your feed.`);
    await reload();
  };
  const rows: MenuRow[] = [
    { value: "on", text: "In your feed", on: follow.on, face: <Icon name="eye" /> },
    { value: "off", text: "Not in your feed", on: !follow.on, face: <Icon name="eyeOff" /> },
    { hint: follow.set ? `Set for ${name}.` : `As you follow @${owner}.` },
    ...(follow.set ? [{ divider: "" }, { value: "as", text: `As you follow @${owner}`, face: <Icon name="undo" /> }] : []),
  ];
  const face = (
    <>
      <Icon name={follow.on ? "eye" : "eyeOff"} />
      <span className="opt-v">{follow.on ? "Following" : "Not following"}</span>
      <Icon name="down" className="caret" />
    </>
  );
  const pick = (v: string) => {
    if (v === "as") return set(null);
    const on = v === "on";
    if (on !== follow.on || follow.set === null) return set(on);
  };
  return <MenuPick id={`follow:${id}`} label="Following" title={follow.on ? `${name}'s threads are in your feed` : `${name}'s threads aren't in your feed`} face={face} rows={rows} set onPick={pick} />;
}
