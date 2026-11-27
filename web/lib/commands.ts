// An agent's `! command` in its text: Claude Code's way of saying "type this at its prompt", where it runs in the
// session's folder. Outside a code block, a table, a heading or a quote, each one is made a code block of its own (in
// sh), so it shows as one and ▶ runs it as any block runs (md() in app.ts). Its line is cut there: the text before it
// ends with ":" where it ended in a word, the text after it goes on under the block, without the punctuation that
// followed the command. In a list item, the block is the item's.
// plugin/shared/text.ts does the same, so its codeBlocks finds and numbers a message's blocks as the page does;
// test/runs.ts checks the two agree.
const COMMAND = /`!\s+([^`\n]*[^`\s][^`\n]*)`/;
const KEPT = /^\s*(\||#{1,6}\s|>)/;
const ITEM = /^\s*([-*+]|\d+[.)])\s+/;
const FENCE = /^\s*```/;

export function commandFences(text: unknown): string {
  const all = String(text ?? "");
  if (!all.includes("`!")) return all;
  const out: string[] = [];
  let fenced = false;
  for (const line of all.split("\n")) {
    const fence = FENCE.test(line);
    if (fence) fenced = !fenced;
    if (fence || fenced || KEPT.test(line) || !COMMAND.test(line)) {
      out.push(line);
      continue;
    }
    const item = line.match(ITEM);
    let head = item ? item[0] : line.match(/^\s*/)[0];
    const pad = head.replace(/\S/g, " ");
    let rest = line.slice(head.length);
    for (let m; (m = COMMAND.exec(rest)); ) {
      const before = rest.slice(0, m.index).trimEnd();
      if (before || head !== pad) out.push(`${head}${before}${/[\p{L}\p{N}]$/u.test(before) ? ":" : ""}`);
      out.push(`${pad}\`\`\`sh`, `${pad}${m[1].trim()}`, `${pad}\`\`\``);
      head = pad;
      rest = rest.slice(m.index + m[0].length).replace(/^[\s.,;:!?)\]]+/, "");
    }
    if (rest.trim()) out.push(`${head}${rest}`);
  }
  return out.join("\n");
}

// How many code blocks a text has, as md() draws them: for the part of a message drawn after another part.
export function codeBlockCount(text: unknown): number {
  let n = 0;
  let fenced = false;
  for (const line of commandFences(text).split("\n")) {
    if (!FENCE.test(line)) continue;
    if (!fenced) n++;
    fenced = !fenced;
  }
  return n;
}
