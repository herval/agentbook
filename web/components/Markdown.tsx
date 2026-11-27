// Agents write markdown: <Markdown text={…}/> draws it, safely (no HTML of theirs reaches the page), with GitHub's
// tables, task lists and bare links, a line break where they broke a line, headings two sizes down, and code blocks
// with Copy (and ▶, where they can run). Words other parts of the page know (an @page, a thread's name, a file
// path) become what they name: lib/markdown.ts.
import type { Element } from "hast";
import type { Code, Emphasis, PhrasingContent, Root } from "mdast";
import { findAndReplace } from "mdast-util-find-and-replace";
import type { FindAndReplaceTuple, RegExpMatchObject } from "mdast-util-find-and-replace";
import { Children, Fragment, isValidElement, memo, useMemo, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { visit } from "unist-util-visit";
import { commandFences } from "../lib/commands.ts";
import { webUrl } from "../lib/format.ts";
import { filePath, inlineTokens, localPic, mdActions, mdUrl } from "../lib/markdown.ts";
import type { MdContext } from "../lib/markdown.ts";
import { Icon } from "./Icon.tsx";

// Each code block has Copy in its corner. One in a thread's message, in a shell's language or none (not a drawing), can
// be run in the thread's folder on its machine (▶). A code block wraps its long lines, each wrapped part indented under
// it; one laid out in columns or drawn (a table, a tree) keeps its lines whole and scrolls sideways.
const RUNS_IN = new Set(["", "sh", "bash", "zsh", "shell", "console", "terminal", "fish"]);
const MD_LAID_OUT = /[─-▟]|\S {2,}\S/;
const runnable = (lang: string, lines: string[]) => RUNS_IN.has(lang) && !lines.some((l) => /[─-▟]/.test(l)) && lines.some((l) => l.trim());
const indentOf = (line: string) => line.match(/^\s*/)[0].length;

// Where its code blocks may run: the thread and message, from which block on (a part of a message drawn after
// another), and whether you may.
export interface MdRun {
  post: string;
  mid: string;
  first?: number;
  play?: boolean;
}

// Numbers each code block as it comes (as the machine finds them, plugin/shared/text.ts's codeBlocks), and turns the
// words registered in lib/markdown.ts into <ab-token> elements the components below draw.
function remarkAgentbook(cx: MdContext, tokens: Map<string, { name: string; m: RegExpExecArray }>) {
  return () => (tree: Root) => {
    let n = 0;
    visit(tree, "code", (node: Code) => {
      node.data = { ...(node.data || {}), hProperties: { ...(node.data?.hProperties || {}), "data-block": n++ } };
    });
    const list: FindAndReplaceTuple[] = [];
    for (const t of inlineTokens) {
      const re = t.re(cx);
      if (!re) continue;
      list.push([
        re,
        (...args: [...string[], RegExpMatchObject]): PhrasingContent | PhrasingContent[] => {
          const at = args.at(-1) as RegExpMatchObject;
          const match = args.slice(0, -1) as unknown as RegExpExecArray;
          const pre = re.source.startsWith("(^|") ? match[1] || "" : "";
          const key = `t${tokens.size}`;
          const m = Object.assign([...match], { index: at.index, input: at.input }) as unknown as RegExpExecArray;
          tokens.set(key, { name: t.name, m });
          // Any node with an hName becomes that element; an emphasis is one markdown already has a place for inline.
          const node: Emphasis = { type: "emphasis", data: { hName: "ab-token", hProperties: { k: key } }, children: [{ type: "text", value: match[0].slice(pre.length) }] };
          return pre ? [{ type: "text", value: pre }, node] : node;
        },
      ]);
    }
    if (list.length) findAndReplace(tree, list, { ignore: ["link", "linkReference", "inlineCode", "code"] });
  };
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="md-code-btn"
      type="button"
      title={done ? "Copied" : "Copy"}
      aria-label="Copy"
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      <Icon name={done ? "check" : "copy"} />
    </button>
  );
}

// A code block runs nowhere unless the thread page's code says otherwise (mdActions.useRunning).
const notRunning = () => false;
function CodeBlock({ code, lang, block, run }: { code: string; lang: string; block: number; run: MdRun | null }) {
  const lines = code.replace(/\n$/, "").split("\n");
  const at = run && runnable(lang, lines) ? { post: run.post, mid: run.mid, block: (run.first || 0) + block, play: run.play, code } : null;
  const running = (mdActions.useRunning || notRunning)(at);
  const pre = lines.some((l) => MD_LAID_OUT.test(l)) ? (
    <pre>
      <code>{lines.join("\n")}</code>
    </pre>
  ) : (
    <pre className="is-wrap">
      <code>
        {lines.map((l, i) => (
          <span className="ln" key={i} style={indentOf(l) ? ({ "--in": `${indentOf(l)}ch` } as React.CSSProperties) : undefined}>
            {l}
            {i < lines.length - 1 ? "\n" : ""}
          </span>
        ))}
      </code>
    </pre>
  );
  return (
    <div className={`md-code${at ? " md-code--run" : ""}${running ? " is-running" : ""}`} data-run-post={at?.post} data-run-msg={at?.mid} data-run-block={at?.block}>
      {pre}
      <span className="md-code-acts">
        {at && mdActions.play?.(at)}
        <CopyButton text={code.replace(/\n$/, "")} />
      </span>
      {at && mdActions.runs?.(at)}
    </div>
  );
}

function PeekButton({ peek, path, line, children }: { peek: string; path: string; line: string; children: ReactNode }) {
  return (
    <button className="md-path" type="button" title={`Open ${path}`} onClick={() => mdActions.peek?.(peek, path, line)}>
      {children}
    </button>
  );
}

function Md({ text, peek = null, pics = null, from = null, run = null, className = "md" }: { text: string; peek?: string | null; pics?: string | null; from?: string | null; run?: MdRun | null; className?: string }) {
  const cx: MdContext = { peek, pics, from };
  const out = useMemo(() => {
    const tokens = new Map<string, { name: string; m: RegExpExecArray }>();
    const components: Components = {
      h1: ({ children }) => <h3>{children}</h3>,
      h2: ({ children }) => <h4>{children}</h4>,
      h3: ({ children }) => <h5>{children}</h5>,
      h4: ({ children }) => <h5>{children}</h5>,
      h5: ({ children }) => <h5>{children}</h5>,
      h6: ({ children }) => <h5>{children}</h5>,
      table: ({ children }) => (
        <div className="md-tbl">
          <table className="mini-tbl">{children}</table>
        </div>
      ),
      // A quote's paragraphs inline, one line each, as the page always drew a quote: no paragraph in it, so none of a
      // paragraph's margin under it. Anything else in a quote (a list, code) stays as it is.
      blockquote: ({ children }) => {
        const parts = Children.toArray(children).filter((c) => typeof c !== "string" || c.trim());
        if (!parts.length || !parts.every((c) => isValidElement(c) && c.type === "p")) return <blockquote>{children}</blockquote>;
        return (
          <blockquote>
            {parts.map((c, i) => (
              <Fragment key={i}>
                {i ? <br /> : null}
                {(c as ReactElement<{ children?: ReactNode }>).props.children}
              </Fragment>
            ))}
          </blockquote>
        );
      },
      li: ({ children, className: c }) => <li className={c?.includes("task-list-item") ? "md-task" : undefined}>{children}</li>,
      a: ({ href, children }) => {
        const url = mdUrl(href || "");
        if (url)
          return (
            <a className="md-link" href={url} target="_blank" rel="noopener">
              {children}
            </a>
          );
        const f = peek && filePath(href || "");
        return f ? (
          <PeekButton peek={peek} path={f.path} line={f.line}>
            {children}
          </PeekButton>
        ) : (
          <>{children}</>
        );
      },
      img: ({ src, alt }) => {
        const url = String(src || "");
        const s = pics && (webUrl(url) || localPic(url)) ? `${pics}?url=${encodeURIComponent(url)}` : mdUrl(url);
        return s ? (
          <a className="md-img" href={s} target="_blank" rel="noopener">
            <img src={s} alt={alt || ""} loading="lazy" />
          </a>
        ) : (
          <>{alt}</>
        );
      },
      code: ({ className: c, children }) => {
        const code = String(children ?? "");
        if (/^https?:\/\/\S+$/i.test(code))
          return (
            <a className="md-link" href={code} target="_blank" rel="noopener">
              <code>{code}</code>
            </a>
          );
        const f = peek && !c && filePath(code);
        return f ? (
          <PeekButton peek={peek} path={f.path} line={f.line}>
            <code>{code}</code>
          </PeekButton>
        ) : (
          <code className={c}>{children}</code>
        );
      },
      pre: ({ node }) => {
        const code = node?.children?.[0] as Element | undefined;
        const lang = String(code?.properties?.className?.[0] || "").replace(/^language-/, "").toLowerCase();
        const text = (code?.children || []).map((c) => (c.type === "text" ? c.value : "")).join("");
        return <CodeBlock code={text} lang={lang} block={Number(code?.properties?.dataBlock ?? 0)} run={run} />;
      },
      "ab-token": ({ k, children }: { k?: string; children?: ReactNode }) => {
        const t = tokens.get(k);
        const def = t && inlineTokens.find((x) => x.name === t.name);
        return <>{(def && def.render(t.m, cx)) ?? children}</>;
      },
    } as Components;
    return (
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks, remarkAgentbook(cx, tokens)]} components={components}>
        {run ? commandFences(text) : text}
      </ReactMarkdown>
    );
  }, [text, peek, pics, from, run?.post, run?.mid, run?.first, run?.play]);
  return <div className={className}>{out}</div>;
}
export const Markdown = memo(Md);
