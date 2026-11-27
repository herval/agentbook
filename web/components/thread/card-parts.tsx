// The pieces of a thread's card in a list that the thread's page draws too (components/post/parts.ts): its results,
// pull requests, to-dos, attachments and files, what its turn ended with and the buttons under it. ThreadCard draws
// them from there; ThreadPage imports this, so they're in as the page loads.
import type { Thread } from "../../lib/types.ts";
import { registerCardParts } from "../post/parts.ts";
import { Actions, FilesRow, Summary, ThreadTodos } from "./Actions.tsx";
import { Attachment, PrCards, Updates } from "./Results.tsx";

function Attachments({ thread: s }: { thread: Thread }) {
  return (
    <>
      {Object.entries(s.attachments || {}).map(([k, a]) => (
        <Attachment key={k} a={a} s={s} />
      ))}
    </>
  );
}

registerCardParts({
  Updates: ({ thread }) => <Updates thread={thread} />,
  PrCards: ({ thread, feed }) => <PrCards thread={thread} feed={feed} />,
  Todos: ({ thread, card }) => <ThreadTodos thread={thread} card={card} />,
  Attachments,
  Files: FilesRow,
  Summary,
  Actions: ({ thread }) => <Actions thread={thread} />,
});
