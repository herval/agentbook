import { tool, text, err } from "./tool.ts";
import { pathOn } from "./disk.ts";
import { secretFileRefusal } from "../redact.ts";
import { artifactPage, artifactUrl, docPage } from "../artifact.ts";

export default tool({
  name: "ab_artifact",
  description:
    'Put a claude.ai artifact on your thread as a page they can see there (claude.ai won\'t be framed by another site, so its link alone only opens it). When they send a claude.ai/artifact/... link, or after you publish one. First get its content, which depends on its type (your Artifact tool\'s read of the link says which). A plain page or a Design canvas: list its files with your Artifact tool (action "list", scope "files") and read the ones it needs into one folder (action "read", paths): index.html for a page; project/canvas.json, the artboard\'s project/<name>.dc.html and artifact-type/dc-runtime.js for a canvas. Then call this with the link and that folder as `path`. A Claude Doc: read the doc with the Docs connector for its tabs\' ids, export each tab with its export tool (format "html"), then call this with the link and no `path`: agentbook takes the export from your conversation\'s record.',
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The artifact's claude.ai link." },
      path: { type: "string", description: "The folder your Artifact tool saved its files under, or the HTML file you published. None for a Claude Doc you exported." },
      board: { type: "string", description: "A Design canvas with several artboards: the one to show, by its file name (Main.dc.html). Without it, the one the canvas opens on." },
      title: { type: "string" },
    },
    required: ["url"],
  },
  async run(args, { call, disk, where }) {
    const url = artifactUrl(args.url);
    if (!url) return err("That isn't a claude.ai artifact's link (https://claude.ai/artifact/...).");
    let page;
    if (args.path) {
      const p = pathOn(disk, where, args.path);
      const secret = secretFileRefusal(p);
      if (secret) return err(secret);
      page = await artifactPage(disk, p, { board: String(args.board || "") });
    } else {
      // A Claude Doc: what its session exported, from its conversation's record, which agentbook-cli reads.
      const r = await call("POST", "/artifact-export", { url });
      page = r.record === false ? { error: `agentbook has no record of your conversation to take an export from. Give them the link instead.` } : docPage(r.tabs || []);
    }
    if (page.error) return err(page.error);
    const title = String(args.title || page.title || "Claude artifact").slice(0, 140);
    await call("POST", "/files", { name: `${title.replace(/[^\w.\- ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "artifact"}.html`, title, artifact: url, content_base64: Buffer.from(page.html).toString("base64") }, { timeout: 60000 });
    return text(`It shows on your thread now, as a copy made just now (a later change on claude.ai won't reach it).${page.notes.length ? `\n${page.notes.join("\n")}` : ""}`);
  },
});
