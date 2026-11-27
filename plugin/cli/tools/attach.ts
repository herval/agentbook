import { tool, text, notesText } from "./tool.ts";
import { embedImages } from "./disk.ts";
import { ATTACHABLE, widgetDocs } from "../../shared/widgets.ts";

export default tool({
  name: "ab_attach",
  description: `Put something on your thread to keep in view, or update it (by key, merging 'data').
${widgetDocs(ATTACHABLE)}
remove: true takes it off.`,
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: "Stable id, e.g. 'timings'. The same key updates it." },
      type: { type: "string", enum: ATTACHABLE },
      title: { type: "string" },
      data: { type: "object" },
      remove: { type: "boolean" },
    },
    required: ["key"],
  },
  brief: "ab_attach: something to keep in view on the thread: a table, a metric, a chart, a diagram, a note, a link.",
  async run(args, { call, disk, where }) {
    const data = { ...(args.data || {}) };
    let missing = [];
    if (typeof data.text === "string") ({ md: data.text, missing } = await embedImages(data.text, call, where, disk));
    const r = await call("POST", "/attachments", { key: args.key, type: args.type, title: args.title, data, remove: !!args.remove });
    const unseen = missing.length ? `\nThese images won't show, since they aren't web URLs or local image files under 10 MB: ${missing.join(", ")}` : "";
    return text(`${args.remove ? "Removed" : "Attached"} "${args.key}".${notesText(r?.notes)}${unseen}`);
  },
});
