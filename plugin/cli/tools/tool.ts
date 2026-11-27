// One of agentbook's tools (ab_*), as an agent calls it over MCP: its name, what it tells the agent it does, what it
// takes, and what it does. Each tool is a file in this folder, index.ts lists them, and mcp.ts serves that list, all
// of it to every agent; what else names them (OpenClaw's manifest) is checked against it (test/tools.ts).

import { fromServer } from "../context.ts";
import { isDrivenProc } from "../../shared/runtimes.ts";

// A machine's files, as an agent's tools read them: this one's, or (`who.disk`) another's, through its driver.
export interface Disk {
  home: string;
  // A file's size, or null when there's none there.
  stat(p: string): Promise<{ size: number } | null>;
  read(p: string): Promise<Buffer>;
}
// Who a call is from: see mcp.ts's handle.
export interface Who {
  proc: string;
  live?: boolean;
  cwd?: string | null;
  disk?: Disk;
  codex?: boolean;
  // Not logged in to a server: every tool says so.
  login?: boolean;
  // Why its login to the server was lost, or null.
  loginLost?: string | null;
}

// Agents agentbook runs through a runtime other than Claude Code: it registers their posts and hands them what the
// person sends.
export const isDriven = (proc: string) => isDrivenProc(proc);

// agentbook, called as the caller's post: one of agentbook-cli's /api/procs/<proc> routes.
export type Call = (method: string, route: string, body?: unknown, opts?: { timeout?: number }) => Promise<any>;

// What a tool's run has to go on.
export interface Ctx {
  who: Who;
  call: Call;
  // Whether agentbook runs its agent (isDriven): what the person sends then comes as its next message.
  driven: boolean;
  // The machine its files are on, and the folder its relative paths are in.
  disk: Disk;
  where: string;
}

// What a tool answers: MCP's tools/call result.
export interface Result {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

// A tool's inputSchema, a JSON Schema as MCP lists it.
export interface Schema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: readonly string[];
  additionalProperties?: boolean;
}
// What a tool's arguments are, read from its inputSchema: each property it lists, typed as the schema says, and
// optional unless the schema requires it. Nothing checks what an agent sends against the schema on the way in, so a
// tool still checks what it relies on (Array.isArray, String(...)); the types catch a property the schema doesn't
// have, or one used as the wrong kind of thing.
export type Infer<S> = S extends { enum: readonly (infer E)[] }
  ? E
  : S extends { anyOf: readonly (infer A)[] }
    ? Infer<A>
    : S extends { type: "string" }
      ? string
      : S extends { type: "number" }
        ? number
        : S extends { type: "boolean" }
          ? boolean
          : S extends { type: "array"; items: infer I }
            ? Infer<I>[]
            : S extends { type: "array" }
              ? unknown[]
              : S extends { type: "object"; properties: infer P }
                ? Props<P, S extends { required: readonly (infer R)[] } ? R : never>
                : S extends { type: "object" }
                  ? Record<string, unknown>
                  : unknown;
type Props<P, R> = { [K in keyof P as K extends R ? K : never]: Infer<P[K]> } & { [K in keyof P as K extends R ? never : K]?: Infer<P[K]> };

export interface Tool {
  name: `ab_${string}`;
  description: string;
  inputSchema: Schema;
  // Its line in what agentbook tells an agent about its tools (mcp.ts), when it has one: one for every agent, or one
  // for Claude Code's sessions and one for the agents agentbook runs (null: no line there).
  brief?: string | { session: string | null; driven: string };
  run(args: Record<string, unknown>, ctx: Ctx): Promise<Result>;
}
// A tool as its file writes it: its run takes the arguments its inputSchema says.
export interface Typed<S extends Schema> extends Omit<Tool, "inputSchema" | "run"> {
  inputSchema: S;
  run(args: Infer<S>, ctx: Ctx): Promise<Result>;
}
// A tool, its arguments typed from its inputSchema.
export const tool = <const S extends Schema>(t: Typed<S>): Tool => t;

export const text = (t: string): Result => ({ content: [{ type: "text", text: t }] });
export const err = (t: string): Result => ({ content: [{ type: "text", text: t }], isError: true });
// What a server elsewhere wrote, marked as that when agentbook-cli says so (`from_server`, from its routes).
export const served = (r, t: string) => (r?.from_server ? fromServer(r.from_server, t) : t);
export const without = ({ from_server, ...rest }) => rest;
// Something an agent or the person wrote, quoted and cut short.
export const clip = (s: string, n = 140) => `"${s.length > n ? s.slice(0, n - 1) + "…" : s}"`;
// What was cut or left out of what it wrote (widgets.ts), so it writes it right next time.
export const notesText = (notes?: string[]) => (notes?.length ? `\nNot all of it went in as sent:\n${notes.map((n) => `- ${n}`).join("\n")}` : "");
