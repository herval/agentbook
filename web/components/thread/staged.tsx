// Files attached to a box (📎, or pasted): they go out when you send. By the box's draft key ("c:<thread>", "launch").
// A picture shows as itself, from the browser's own copy of it (nothing is uploaded until you send); a click opens it
// whole in the viewer, its arrows going through the box's other pictures, where a click on it comments on that spot
// (the viewer's marks). Its address is dropped once the picture is on no box.
import { create } from "zustand";
import { kb, ext, plural } from "../../lib/format.ts";
import { isImage } from "../../lib/markdown.ts";
import { openStagedPic } from "../../lib/viewer.ts";
import { Icon } from "../Icon.tsx";

const useStagedStore = create<{ staged: Record<string, File[]> }>(() => ({ staged: {} }));
const NONE: File[] = [];
export const useStaged = (key: string): File[] => useStagedStore((s) => s.staged[key] || NONE);
export const stagedOf = (key: string): File[] => useStagedStore.getState().staged[key] || NONE;
export function setStaged(key: string, files: File[]) {
  useStagedStore.setState((s) => ({ staged: { ...s.staged, [key]: files } }));
  dropUnused();
}
export const stage = (key: string, files: File[]) => setStaged(key, [...stagedOf(key), ...files]);
// Take them off the box as it sends; putBack puts them back in front of any attached since, when it didn't go.
export function takeStaged(key: string): File[] {
  const files = stagedOf(key);
  setStaged(key, []);
  return files;
}
export const putBackStaged = (key: string, files: File[]) => files.length && setStaged(key, [...files, ...stagedOf(key)]);

// Comments on a picture you haven't sent (the viewer's marks): the picture on the box becomes the copy with your
// numbered marks drawn on it, its thumbnail saying how many, and what you said about each is added to your message as
// it goes out (saidWith), in the words a sent picture's comments go in. The copy -> { orig: the picture as it was,
// block: those words, n: how many comments }.
export const stagedMarks = new WeakMap<File, { orig: File; block: string; n: number }>();
// What goes out with a box's files: what you wrote, then your comments on each picture you marked.
export const saidWith = (text: string, files: File[]) => [text, ...files.map((f) => stagedMarks.get(f)?.block).filter(Boolean)].filter(Boolean).join("\n\n");

// A picture's address in this browser, made once.
const stagedPics = new Map<File, string>();
export function stagedPic(f: File): string {
  if (!stagedPics.has(f)) stagedPics.set(f, URL.createObjectURL(f));
  return stagedPics.get(f);
}
function dropUnused() {
  const all = new Set(Object.values(useStagedStore.getState().staged).flat());
  for (const f of [...all]) if (stagedMarks.has(f)) all.add(stagedMarks.get(f).orig);
  for (const [f, url] of stagedPics)
    if (!all.has(f)) {
      URL.revokeObjectURL(url);
      stagedPics.delete(f);
    }
}
export const isPicFile = (f: { name?: string; type?: string } | null | undefined) => isImage(f?.name || "") || /^image\//.test(f?.type || "");
// Called back when one is taken off the box (its marks go with it).
let onUnstage: ((orig: File) => void) | null = null;
export const whenUnstaged = (fn: (orig: File) => void) => void (onUnstage = fn);

// The chips of a box's files, under it: a picture as itself (a click opens it in the viewer), any other file by its
// name and size, each with × to take it off.
export function StagedChips({ draftKey }: { draftKey: string }) {
  const files = useStaged(draftKey);
  if (!files.length) return <div data-staged-for={draftKey} />;
  const x = (f: File, i: number) => (
    <button
      type="button"
      aria-label={`Remove ${f.name}`}
      onClick={() => {
        const list = [...stagedOf(draftKey)];
        const [gone] = list.splice(i, 1);
        const said = gone && stagedMarks.get(gone);
        if (said) onUnstage?.(said.orig);
        setStaged(draftKey, list);
      }}
    >
      ×
    </button>
  );
  return (
    <div data-staged-for={draftKey}>
      <div className="staged">
        {files.map((f, i) =>
          isPicFile(f) ? (
            <span className="staged-pic" key={i} title={`${(stagedMarks.get(f)?.orig || f).name}, ${kb(f.size)}`}>
              <a
                href={stagedPic(f)}
                target="_blank"
                rel="noopener"
                aria-label={`Open ${f.name}`}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  openStagedPic(draftKey, i);
                }}
              >
                <img src={stagedPic(f)} alt={f.name} />
                {stagedMarks.has(f) && (
                  <b className="staged-said" title={`${plural(stagedMarks.get(f).n, "comment")} on it, sent with your message`}>
                    <Icon name="comment" />
                    {stagedMarks.get(f).n}
                  </b>
                )}
              </a>
              {x(f, i)}
            </span>
          ) : (
            <span className="staged-file" key={i}>
              <span className="ext">{ext(f.name)}</span>
              <span>
                <b>{f.name}</b>
                <small>{kb(f.size)}</small>
              </span>
              {x(f, i)}
            </span>
          ),
        )}
      </div>
    </div>
  );
}
