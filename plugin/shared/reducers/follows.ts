import type { FollowOp } from "../ops.ts";
import type { AgentFollow, Contact, Iso, State } from "../types.ts";

// Two people's contact record's key: their account ids in order, so either one finds it.
export const contactKey = (x: string, y: string): string => (x < y ? `${x}|${y}` : `${y}|${x}`);

// An op from before follows were your feed only (one with a level, an ask or a grant) does nothing: what it did is in
// the state it was checkpointed with, which the page reads into contacts once (contactsFromFollows, server side).
const legacy = (op: object) => "level" in op || "ask" in op || "granted" in op;

export function applyFollow(state: State, op: FollowOp, now: Iso): void {
  switch (op.t) {
    case "agent.follow": {
      if (!op.agent || !op.user || legacy(op)) break;
      const key = `${op.agent}|${op.user}`;
      const follows = (state.agent_follows ||= {});
      if (op.remove) {
        delete follows[key];
        break;
      }
      const f: AgentFollow = { agent: op.agent, user: op.user, at: follows[key]?.at || now };
      if (op.off) f.off = true;
      follows[key] = f;
      break;
    }
    case "person.follow": {
      if (!op.person || !op.user || op.person === op.user || legacy(op)) break;
      const key = `${op.person}|${op.user}`;
      const follows = (state.person_follows ||= {});
      if (op.remove) delete follows[key];
      else follows[key] = { person: op.person, user: op.user, at: follows[key]?.at || now };
      break;
    }
    case "thread.people": {
      if (!op.post || !op.user) break;
      const all = (state.thread_people ||= {});
      const people = (all[op.post]?.people || []).filter((p) => p.user !== op.user);
      if (!op.remove) people.push({ user: op.user, by: op.by ?? null, at: now });
      if (people.length) all[op.post] = { post: op.post, people };
      else delete all[op.post];
      break;
    }
    case "contact": {
      // `user` acts, about `person`. The routes check who may do what; this keeps it consistent whatever came.
      if (!op.user || !op.person || op.user === op.person) break;
      const key = contactKey(op.user, op.person);
      const all = (state.contacts ||= {});
      const c: Contact | undefined = all[key];
      const [a, b] = op.user < op.person ? [op.user, op.person] : [op.person, op.user];
      // A new contact starts followed, both ways: their public things are in each other's feed.
      const connect = () => {
        all[key] = { a, b, at: now, ...(c?.ask ? { by: c.ask } : {}) };
        const follows = (state.person_follows ||= {});
        follows[`${a}|${b}`] ||= { person: a, user: b, at: now };
        follows[`${b}|${a}`] ||= { person: b, user: a, at: now };
      };
      switch (op.act) {
        case "ask":
          if (c?.at) break;
          // They asked too: that's a yes from both.
          if (c?.ask === op.person) connect();
          else all[key] = { a, b, ask: op.user, ask_at: now, ...(op.note ? { note: String(op.note).slice(0, 500) } : {}) };
          break;
        case "take_back":
          if (c && !c.at && c.ask === op.user) delete all[key];
          break;
        case "yes":
          if (c && !c.at && c.ask === op.person) connect();
          break;
        case "no":
          if (c && !c.at && c.ask === op.person) delete all[key];
          break;
        case "remove":
          delete all[key];
          break;
        case "connect":
          if (!c?.at) connect();
          break;
      }
      break;
    }
  }
}
