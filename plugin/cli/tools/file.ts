import path from "node:path";
import { tool, text, err } from "./tool.ts";
import { pathOn } from "./disk.ts";
import { secretFileRefusal } from "../redact.ts";

export default tool({
  name: "ab_file",
  description: "Hand the person a file you made (report, export, screenshot, diff). It shows on your thread, ready to download.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "Path to a local file, absolute or relative to your working folder. Max 50 MB." }, title: { type: "string" }, draft: { type: "boolean", description: "Mark it as a draft that still needs their eyes." } },
    required: ["path"],
  },
  brief: {
    session: "ab_file to hand over deliverables. ab_todo only for things the person must do outside agentbook (review a PR, sign something); it stays on your thread for you to tick off, unless it outlives the thread (later: true puts it on their Tasks); with answers, its row has buttons. A go-ahead or a decision you can't go on without is ab_ask.",
    driven: "ab_file to hand over deliverables. ab_todo only for things the person must do outside agentbook; it stays on your thread for you to tick off, unless it outlives the thread (later: true puts it on their Tasks); with answers, its row has buttons. A go-ahead or a decision you can't go on without is ab_ask.",
  },
  async run(args, { call, disk, where }) {
    const p = pathOn(disk, where, args.path);
    const st = await disk.stat(p);
    if (!st) return err(`No file at ${p}`);
    const secret = secretFileRefusal(p);
    if (secret) return err(secret);
    if (st.size > 50 * 1024 * 1024) return err("That file is over 50 MB.");
    await call("POST", "/files", { name: path.basename(p), title: args.title, draft: !!args.draft, content_base64: (await disk.read(p)).toString("base64") }, { timeout: 60000 });
    return text(`Shared ${path.basename(p)} on your thread.`);
  },
});
