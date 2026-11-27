// What a paste or a drop holds as text. A box that reads only text/plain finds nothing in most of what an iPhone
// copies apart from text: the share sheet's Copy leaves a link alone (text/uri-list), and rich text can come without
// plain text (text/html). "" means there's no text in it: whoever asks should then leave the paste to the browser,
// not cancel it. test/clip.ts checks these.

const BLOCK = /^(P|DIV|LI|TR|H[1-6]|PRE|BLOCKQUOTE)$/;

// What htmlText reads of the DOM DOMParser makes: Node has none, so the server's check of this file (test/clip.ts
// runs it) knows the parser as this.
interface TextNode {
  nodeType: number;
  nodeName: string;
  data?: string;
  childNodes: Iterable<TextNode>;
}
declare const DOMParser: new () => { parseFromString(html: string, type: "text/html"): { body: TextNode } };

// Rich text's words, a line to each block.
function htmlText(html: string): string {
  let out = "";
  const line = () => out && !out.endsWith("\n") && (out += "\n");
  const walk = (node: TextNode) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) {
        const words = n.data.replace(/\s+/g, " ");
        out += !out || out.endsWith("\n") ? words.trimStart() : words; // the space between two blocks isn't a line
      } else if (n.nodeName === "BR") out += "\n";
      else if (n.nodeType === 1 && !/^(STYLE|SCRIPT)$/.test(n.nodeName)) {
        const block = BLOCK.test(n.nodeName);
        if (block) line();
        walk(n);
        if (block) line();
      }
    }
  };
  walk(new DOMParser().parseFromString(html, "text/html").body);
  return out.replace(/ +\n/g, "\n").trim();
}

// data: a paste's or a drop's DataTransfer, as clipText reads it.
export function clipText(data: { getData(type: string): string; files?: Iterable<{ name: string }> } | null): string {
  const text = data?.getData("text/plain");
  if (text) {
    // A file copied in Finder comes with its name as text: the file is what was copied.
    const names = [...(data.files || [])].map((f) => f.name);
    return names.length && text.trim().split(/\r?\n/).every((l) => names.includes(l.trim())) ? "" : text;
  }
  // One link to a line, and # starts a comment (RFC 2483).
  const urls = (data?.getData("text/uri-list") || "").split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
  if (urls.length) return urls.join("\n");
  const html = data?.getData("text/html");
  return html ? htmlText(html) : "";
}
