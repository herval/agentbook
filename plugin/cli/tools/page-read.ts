import { tool, text, err, served, without } from "./tool.ts";

export default tool({
  name: "ab_page_read",
  description: "Read a page: its widgets as data, with their ids, so you can update them with ab_page_write, and its latest versions: who changed what, and when.",
  inputSchema: { type: "object", properties: { page: { type: "string", description: "The page's id, from ab_page_list." } }, required: ["page"] },
  async run(args, { call }) {
    if (!args.page) return err("Say which page: its id, from ab_page_list.");
    const page = await call("GET", `/pages/${encodeURIComponent(args.page)}`);
    return text(served(page, JSON.stringify(without(page), null, 1)));
  },
});
