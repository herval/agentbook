import { tool, text, clip, notesText } from "./tool.ts";
import { embedImages } from "./disk.ts";
import { WIDTHS, widgetDocs } from "../../shared/widgets.ts";
import { AGENT_MAX } from "../../shared/page-shape.ts";

// What the page's shape says back to a write (page-shape.ts): repeats, and more widgets than a page reads well with.
const adviceText = (lines) => (lines?.length ? `\nAbout the page as it is now:\n${lines.map((n) => `- ${n}`).join("\n")}` : "");
// What ab_page_write did to the page's tasks, item by item.
function pageTaskLines(r) {
  if (r.tasks_error) return `\nIts tasks didn't go on their list: ${r.tasks_error}.`;
  if (!r.tasks?.length) return "";
  const line = (t) => {
    if (t.missing) return `${t.id}: there's no task with that id on their list.`;
    const what = t.added ? "added" : t.joined ? "already on their list, now on this page too" : t.changed ? "changed" : "already there";
    const tick = t.ticked ? ", ticked off" : t.unticked ? ", put back" : t.done ? ", done" : "";
    return `${t.id} ${clip(t.text, 80)}: ${what}${tick}${t.closes ? ` (its issue closes in ${t.closes} too)` : ""}.`;
  };
  return `\nIts tasks, on their Tasks list:\n${r.tasks.map(line).join("\n")}`;
}

// A widget as the agent sent it, and a copy of it whose data can take a note's uploaded images without changing
// what was sent.
type Sent = Record<string, unknown> & { data?: { text?: unknown } };
const copied = (w: Sent): Sent => (w && typeof w === "object" ? { ...w, data: w.data && typeof w.data === "object" ? { ...w.data } : w.data } : w);

export default tool({
  name: "ab_page_write",
  description: `Make or update a page: widgets you keep up to date for the person (a reliability dashboard, a product exploration, a blog post draft). It lives on agentbook outside any one thread, and every write that changes something is a version they can see and restore.
- To make one: a title (and an emoji, widgets). It starts private, and the person decides who sees it. You're its first contributor.
- To update one: its page id. Widgets you send replace or update the ones with the same id (data merges key by key); the ones you leave out stay. remove: [ids] takes widgets off, order: [ids] puts them in that order.
- Keep it one page, however many threads write it. Read it first, and put what you have in the widgets that are there (a row in a table, a column, a line in a note, a point on a chart) before you add one. Each number once. One note on what matters, at the top, and one on sources, at the bottom: never an intro, "what stands out" or method note per section. A note is a few lines on what's true now: replace its text, don't add to it (the versions keep what it said, and summary says what changed). Remove what's done or stale in the same write. About 12 widgets reads well; the answer says when the page has more or repeats itself, and an agent can't take a page past ${AGENT_MAX}.
A widget: { id, type, title, width?, stack?, data }. width: ${Object.keys(WIDTHS).join(", ").replace(/, (?=[^,]*$)/, " or ")}. stack: a name; widgets with the same one sit in one column, e.g. beside a long doc.
${widgetDocs()}`,
  inputSchema: {
    type: "object",
    properties: {
      page: { type: "string", description: "The page's id, to update it. Leave it out (or give a new id) with a title to make one." },
      title: { type: "string", description: "The page's title, like 'Reliability: platform'. Required to make one." },
      emoji: { type: "string", description: "One emoji for the page." },
      about: { type: "string", description: "A sentence on what the page keeps track of." },
      widgets: { type: "array", items: { type: "object" }, description: "Widgets to add or update, by id." },
      remove: { type: "array", items: { type: "string" }, description: "Ids of widgets to take off." },
      order: { type: "array", items: { type: "string" }, description: "Widget ids in the order they should be." },
      summary: { type: "string", description: "What this version changed, past tense: 'Refreshed latency and the daily note'." },
    },
  },
  brief: "ab_page_write: a page of widgets you keep up to date for the person, outside any one thread (an exploration, a plan, a draft). Only when they ask for one, or for a page you keep; ab_page_list lists them, ab_page_read reads one. Change the widgets that are there before you add one, and say each thing once. Numbers a source can be asked for go on a dashboard instead.",
  async run(args, { call, disk, where }) {
    const widgets = Array.isArray(args.widgets) ? args.widgets.map((w) => copied(w as Sent)) : undefined;
    const missing = [];
    for (const w of widgets || []) {
      if (typeof w?.data?.text !== "string") continue;
      const r = await embedImages(w.data.text, call, where, disk);
      w.data.text = r.md;
      missing.push(...r.missing);
    }
    const r = await call("POST", "/pages", { page: args.page, title: args.title, emoji: args.emoji, about: args.about, widgets, remove: args.remove, order: args.order, summary: args.summary }, { timeout: 15000 });
    const unseen = missing.length ? `\nThese images won't show, since they aren't web URLs or local image files under 10 MB: ${missing.join(", ")}` : "";
    const tasks = pageTaskLines(r);
    const trimmed = notesText(r.notes);
    const shape = adviceText(r.advice);
    if (r.created) return text(`Made the page "${r.id}" (v1): ${r.url}\nIt's private until the person makes it public. Update it with page: "${r.id}".${tasks}${trimmed}${shape}${unseen}`);
    return text(`${r.changed ? `Saved v${r.version} of "${r.id}"` : `Nothing changed on "${r.id}"${r.tasks?.length ? " but its tasks" : ""}, so no new version (it's still v${r.version})`}: ${r.url}${tasks}${trimmed}${shape}${unseen}`);
  },
});
