import { tool, text, served, clip } from "./tool.ts";

function taskList(d) {
  const who = d.person || "the person";
  const tags = (t) => [t.workspace, t.page && `on the page "${t.page}"`, t.group && t.for !== "group" && `in the group "${t.group}"`, t.source && `${t.source}${t.closes ? `, ticking it closes it in ${t.closes}` : ""}`, t.mine ? (t.thread ? "your to-do for them, on your thread" : "your to-do for them") : t.from && `from ${t.from}`, t.owner ? `${t.owner}'s, shared with ${who}: only ${t.owner} ticks it off` : t.with?.length && `shared with ${t.with.map((u) => `@${u}`).join(", ")}`].filter(Boolean).map((x) => `  [${x}]`).join("");
  const row = (t) => `  ${t.id}  ${clip(t.text)}${tags(t)}${t.note ? `\n      ${clip(t.note.replace(/\s+/g, " "), 200)}` : ""}`;
  const byWhom = (t) => (t.by_me ? "you" : t.done_by === "agent" ? "another agent" : t.done_by === "sync" ? "its connector" : who);
  const sections = [
    ["Linked to your thread", d.open.filter((t) => t.for === "post")],
    ["In your group", d.open.filter((t) => t.for === "group")],
    ["For your agent", d.open.filter((t) => t.for === "agent")],
    ["In this workspace", d.open.filter((t) => t.for === "workspace")],
    [`${who[0].toUpperCase() + who.slice(1)}'s other tasks, in their order`, d.open.filter((t) => !t.for)],
  ].filter(([, list]) => list.length);
  const lines = sections.flatMap(([head, list]) => [`${head}:`, ...list.map(row), ""]);
  if (d.more) lines.splice(-1, 0, `  …and ${d.more} more.`);
  if (!lines.length) lines.push(`Nothing open on ${who}'s list.`, "");
  if (d.hub_error) lines.push(`${who[0].toUpperCase() + who.slice(1)}'s tasks on the hub aren't here: ${d.hub_error}.`, "");
  if (d.done.length) lines.push("Ticked in the last day:", ...d.done.map((t) => `${row(t)}  (by ${byWhom(t)})`), "");
  lines.push("Tick with done: [ids] once it's really done; undone: [ids] puts one back. link: [ids] links your thread to a task, unlink: [ids] takes it off. Everyone on a shared task sees the threads linked to it.");
  return lines.join("\n");
}
function tickLine(r, done) {
  if (r.missing) return `${r.id}: there's no task with that id on their list.`;
  if (r.refused) return `${r.id} ${clip(r.text, 80)} isn't yours to tick: ${r.refused}.`;
  if (r.error) return `${r.id}: couldn't reach it, ${r.error}.`;
  if (!r.ok) return `${r.id} ${clip(r.text, 80)} ${done ? "was already ticked" : "wasn't ticked"}.`;
  const issue = r.closes ? `; ${r.source || "its issue"} ${done ? "closes" : "opens again"} in ${r.closes} too` : "";
  return `${done ? "Ticked off" : "Put back"} ${r.id} ${clip(r.text, 80)}${issue}.`;
}
function linkLine(r, linked) {
  if (r.missing) return `${r.id}: there's no task with that id on their list.`;
  if (r.error) return `${r.id}: couldn't reach it, ${r.error}.`;
  if (!r.ok) return `${r.id} ${clip(r.text, 80)} ${linked ? "was already linked to your thread" : "wasn't linked to your thread"}.`;
  const shared = linked && r.shared_with?.length ? ` It's shared with ${r.shared_with.map((u) => `@${u}`).join(", ")}: they see your thread now, its steps too, so keep secrets out of it.` : "";
  return `${linked ? "Linked your thread to" : "Unlinked your thread from"} ${r.id} ${clip(r.text, 80)}.${shared}`;
}

export default tool({
  name: "ab_tasks",
  description: "The person's Tasks list: their own tasks, and the to-dos agents left them (yours too). With no arguments, lists the open ones with their ids, the ones linked to your thread first. done: [ids] ticks those off, once the work is really done (merged, shipped, or done by them), not when it's only waiting for review. undone: [ids] puts ticked ones back. They see which agent ticked each one. link: [ids] links your thread to tasks you're working on or need done too (a task has any number of threads), unlink: [ids] takes it off.",
  inputSchema: {
    type: "object",
    properties: {
      done: { type: "array", items: { type: "string" }, description: "Ids of tasks to tick off." },
      undone: { type: "array", items: { type: "string" }, description: "Ids of ticked ones to put back on the list." },
      link: { type: "array", items: { type: "string" }, description: "Ids of tasks to link your thread to." },
      unlink: { type: "array", items: { type: "string" }, description: "Ids of tasks to unlink your thread from." },
    },
  },
  brief: "ab_tasks: the person's Tasks list. Tick off a task (your own to-dos included) once it's really done; link your thread to a task you're working on.",
  async run(args, { call }) {
    const ids = (k) => (Array.isArray(args[k]) ? args[k] : args[k] ? [args[k]] : []).map(String).filter(Boolean);
    const lines = [];
    for (const [k, done] of [["done", true], ["undone", false]]) {
      if (!ids(k).length) continue;
      const { results } = await call("POST", "/tasks/done", { ids: ids(k), done });
      lines.push(...results.map((r) => tickLine(r, done)));
    }
    for (const [k, linked] of [["link", true], ["unlink", false]]) {
      if (!ids(k).length) continue;
      const { results } = await call("POST", "/tasks/link", { ids: ids(k), linked });
      lines.push(...results.map((r) => linkLine(r, linked)));
    }
    if (lines.length) return text(lines.join("\n"));
    const list = await call("GET", "/tasks");
    return text(served(list, taskList(list)));
  },
});
