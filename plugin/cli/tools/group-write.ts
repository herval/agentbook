import { tool, text, err } from "./tool.ts";
import { pathOn } from "./disk.ts";
import { secretFileRefusal } from "../redact.ts";

export default tool({
  name: "ab_group_write",
  description: "Write a file in your group's folder, which every agent in the group reads. Each write is a version the person can see and restore. If you can write the folder itself (you're told its path), you can just write there; this is for when you can't.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Its path in the group's folder, e.g. release-notes.md or screenshots/feed.png." },
      text: { type: "string", description: "The whole file, as text." },
      from: { type: "string", description: "Instead of text: a local file to copy in (a picture, a PDF)." },
    },
    required: ["path"],
  },
  async run(args, { call, disk, where }) {
    if (!args.path) return err("Say where in the group's folder: its path, e.g. notes.md.");
    // Its text, or a file's bytes.
    let body: { path: string; text?: string; content_base64?: string } = { path: args.path, text: args.text ?? "" };
    if (args.from) {
      const p = pathOn(disk, where, args.from);
      if (!(await disk.stat(p))) return err(`No file at ${p}`);
      const secret = secretFileRefusal(p);
      if (secret) return err(secret);
      body = { path: args.path, content_base64: (await disk.read(p)).toString("base64") };
    }
    const r = await call("POST", "/group/files", body, { timeout: 30000 });
    return text(`Saved ${r.path} as v${r.v} in the group's folder: ${r.url}`);
  },
});
