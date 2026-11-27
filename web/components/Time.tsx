import { ago, dur } from "../lib/format.ts";
import { useNow } from "../lib/hooks.ts";

// How long ago, kept current; its title says when exactly.
export function Ago({ at, className = "" }: { at: string | null | undefined; className?: string }) {
  useNow(30e3);
  if (!at) return null;
  return (
    <time className={className || undefined} dateTime={at} title={new Date(at).toLocaleString()}>
      {ago(at)}
    </time>
  );
}
// How long since `since`, counting up every second: a <time>, as the stylesheet sizes one (.live time keeps it on
// one line).
export function Since({ since, className = "" }: { since: string; className?: string }) {
  const now = useNow(1000);
  return (
    <time className={className || undefined} data-since={since}>
      {dur(now - Date.parse(since))}
    </time>
  );
}
