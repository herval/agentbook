// What a page types in a thread's terminal, until its shell has it (server/terminals.ts, plugin/cli/terminals.ts).
// The server stopping takes what's on its way through it, so a page keeps each piece until it hears the shell got it,
// and sends what it still has again, in order and under the same id, each time its socket says hello. The process
// that holds the shell takes an id once, so sending again never types anything twice. A terminal that can't say what
// it got (an older machine, or a shell that was running before it updated) hears each piece once, as it always has:
// only what's typed with no socket waits for one.

const KEPT_MAX = 64 * 1024;

// A piece typed, by its id: the process that holds the shell types each id once.
interface Piece {
  id: string;
  data: string;
}
export interface Typing {
  type(data: string): void;
  open(saysGot: boolean): void;
  says(saysGot: boolean): void;
  closed(): void;
  got(id: string): void;
}

// `send(message)`: on the socket, if it's open. -> whether it went.
export function createTyping(send: (message: { t: "in" } & Piece) => boolean): Typing {
  const me = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
  let n = 0;
  let live = false; // its socket said hello
  let acks = false; // its shell says what it got
  let kept: Piece[] = [];
  const size = () => kept.reduce((all, x) => all + x.data.length, 0);
  return {
    type(data: string) {
      const x = { id: `${me}.${++n}`, data };
      const sent = live && send({ t: "in", ...x });
      if ((!sent || acks) && size() + data.length <= KEPT_MAX) kept.push(x);
    },
    // Its socket said hello: what's still kept goes, in order.
    open(saysGot: boolean) {
      live = true;
      acks = saysGot;
      for (const x of kept) send({ t: "in", ...x });
      if (!acks) kept = [];
    },
    // Its machine's line came back, and said whether this terminal says what it got.
    says: (saysGot: boolean) => (acks = saysGot),
    closed: () => (live = false),
    got: (id: string) => (kept = kept.filter((x) => x.id !== id)),
  };
}
