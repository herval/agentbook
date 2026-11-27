// Handing a post's queued events to its runtime, one post at a time (the threads core's, for every runtime but one
// that delivers by itself). Allow/Deny and answers to what it asked go to `answer` (true when it took the event);
// everything else is sent as one message. The files you attached are named in it with their paths here, or, with
// `sendsFiles` (a runtime that may be on another machine), handed to `send` to go with it: [{ name, size, path }].
// What doesn't get there is the host's to say (undelivered: your messages stay, to send again or delete).
//
// A slash command goes alone, as typed, with nothing after it (not even its group's news): what's before it goes
// first, what's after it next time. With `waits` (Codex's), it waits for a running turn to end, never steered into it,
// and what answers something the runtime waits on (`awaits`) goes meanwhile, since a turn waiting on one wouldn't end.
//
// `send` hears `owner` too: whether all of it is its owner's own words (messages, with no news from its group riding
// along, and none written by someone else back when an owner could let others operate an agent), which a runtime may
// send with more than it sends anything else (OpenClaw's admin).
//
// While a thread `holds` (its turn runs, and its runtime takes one prompt at a time: caps.delivery.midTurn "hold"),
// only what answers it goes: the rest waits, queued, until its runtime delivers again (as the turn ends).

import type { AnswerEvent, AnswerFile, FileEvent, OutboxEntry, OutboxEvent, PermissionEvent } from "../../shared/types.ts";
import type { SendOpts } from "./runtime.ts";

export interface DeliveryOpts {
  pending(id: string): OutboxEntry[];
  ack(oids: string[]): void;
  attached(files: AnswerFile[] | undefined): string;
  describe(event: OutboxEvent): string;
  news?(id: string): Promise<string | null> | string | null;
  undelivered(id: string, events: OutboxEntry[], why: string): void;
  log(line: string): void;
  name: string;
  answer(id: string, e: PermissionEvent | AnswerEvent): Promise<boolean> | boolean;
  send(id: string, text: string, files: (AnswerFile | FileEvent)[], opts: SendOpts): Promise<unknown>;
  // A slash command, run as the call it is; else it's sent as typed, said to be one.
  command?(id: string, text: string, command: string): Promise<unknown>;
  sendsFiles?: boolean;
  // A slash command waits for the turn that's running (`working`) to end.
  waits?: boolean;
  working?(id: string): boolean;
  awaits?(id: string, e: OutboxEvent): boolean;
  // Only answers go to it now: the rest of its queue waits.
  holds?(id: string): boolean;
  // What it's about to be sent, so its echo isn't shown twice.
  echo?(id: string, text: string): void;
}

export function deliverer(o: DeliveryOpts) {
  const busy = new Set<string>();
  const again = new Set<string>();
  return async function deliver(id: string): Promise<void> {
    if (busy.has(id)) return void again.add(id);
    busy.add(id);
    const pending = o.pending(id);
    const holding = !!o.holds?.(id);
    const at = holding ? -1 : pending.findIndex((x) => x.event.type === "message" && x.event.command);
    const events = holding ? pending.filter((x) => x.event.type === "permission" || x.event.type === "answer") : at < 0 ? pending : pending.slice(0, at);
    if (o.waits && at >= 0) events.push(...pending.slice(at + 1).filter((x) => o.awaits?.(id, x.event)));
    const taken = new Set<OutboxEntry>();
    let trying = events;
    try {
      // Held: what it takes goes, and an Allow/Deny it no longer asks is dropped (as it is any time). An answer it
      // doesn't take waits with the rest, to go as words.
      if (holding) {
        for (const x of events) if ((await o.answer(id, x.event as PermissionEvent | AnswerEvent)) || x.event.type === "permission") taken.add(x);
        if (taken.size) o.ack([...taken].map((x) => x.oid));
        return;
      }
      if (events.length) {
        const texts: string[] = [];
        const files: (AnswerFile | FileEvent)[] = [];
        let owner = true;
        for (const x of events) {
          const e = x.event;
          if ((e.type === "permission" || e.type === "answer") && (await o.answer(id, e))) {
            taken.add(x);
            continue;
          }
          if (e.type !== "message" || e.user) owner = false;
          if (e.type === "message" && o.sendsFiles) {
            if (e.text?.trim()) texts.push(e.text.trim());
            files.push(...(e.files || []));
          } else if (e.type === "file" && o.sendsFiles) files.push(e);
          else if (e.type === "message") texts.push(`${e.text || ""}${o.attached(e.files)}`.trim());
          else if (e.type !== "permission") texts.push(o.describe(e));
        }
        // What changed in its group since it last heard rides along; it never makes a message of its own.
        const news = texts.length || files.length ? await Promise.resolve(o.news?.(id)).catch(() => null) : null;
        if (texts.length || files.length) {
          const text = [...texts, news].filter(Boolean).join("\n\n");
          o.echo?.(id, text);
          await o.send(id, text, files, { owner: owner && !news });
        }
        o.ack(events.map((x) => x.oid));
      }
      if (at < 0) return;
      // Without `waits`, what's before a command goes on its own round, and the command on the next.
      if (!o.waits && at > 0) return void again.add(id);
      // With it, the command waits for its turn to be over (agentbook tries again as the outbox changes, and as turns end).
      if (o.waits && o.working?.(id)) return;
      const x = pending[at];
      const e = x.event;
      if (e.type !== "message") return; // `at` found a message with a command, so it's always one
      trying = [x];
      o.echo?.(id, e.text || "");
      await (o.command ? o.command(id, e.text || "", e.command) : o.send(id, e.text || "", [], { command: e.command, owner: !e.user }));
      o.ack([x.oid]);
      if (pending.length > at + 1) again.add(id);
    } catch (e) {
      o.log(`${o.name.toLowerCase()} deliver ${id}: ${e.message}`);
      if (taken.size) o.ack([...taken].map((x) => x.oid));
      o.undelivered(
        id,
        trying.filter((x) => !taken.has(x)),
        `couldn't reach ${o.name}: ${e.message}`,
      );
    } finally {
      busy.delete(id);
      if (again.delete(id)) deliver(id);
    }
  };
}
