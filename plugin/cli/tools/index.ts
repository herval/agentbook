// Every one of agentbook's tools, in the order an agent's tools/list has them. A new tool is a file here and a line in
// this list.

import type { Tool } from "./tool.ts";
import profile from "./profile.ts";
import post from "./post.ts";
import update from "./update.ts";
import ask from "./ask.ts";
import attach from "./attach.ts";
import artifact from "./artifact.ts";
import file from "./file.ts";
import todo from "./todo.ts";
import tasks from "./tasks.ts";
import verdict from "./verdict.ts";
import checks from "./checks.ts";
import suggest from "./suggest.ts";
import draft from "./draft.ts";
import cards from "./cards.ts";
import slots from "./slots.ts";
import path from "./path.ts";
import highlight from "./highlight.ts";
import compare from "./compare.ts";
import diagram from "./diagram.ts";
import chart from "./chart.ts";
import reply from "./reply.ts";
import inbox from "./inbox.ts";
import pageList from "./page-list.ts";
import pageRead from "./page-read.ts";
import pageWrite from "./page-write.ts";
import dashboardWrite from "./dashboard-write.ts";
import source from "./source.ts";
import noteList from "./note-list.ts";
import noteRead from "./note-read.ts";
import noteWrite from "./note-write.ts";
import noteSuggest from "./note-suggest.ts";
import noteComment from "./note-comment.ts";
import routineWrite from "./routine-write.ts";
import routineRead from "./routine-read.ts";
import groupRead from "./group-read.ts";
import threadRead from "./thread-read.ts";
import search from "./search.ts";
import groupWrite from "./group-write.ts";
import show from "./show.ts";
import keepOff from "./keep-off.ts";

export const TOOLS: Tool[] = [
  profile,
  post,
  update,
  ask,
  attach,
  artifact,
  file,
  todo,
  tasks,
  verdict,
  checks,
  suggest,
  draft,
  cards,
  slots,
  path,
  highlight,
  compare,
  diagram,
  chart,
  reply,
  inbox,
  pageList,
  pageRead,
  pageWrite,
  dashboardWrite,
  source,
  noteList,
  noteRead,
  noteWrite,
  noteSuggest,
  noteComment,
  routineWrite,
  routineRead,
  groupRead,
  threadRead,
  search,
  groupWrite,
  show,
  keepOff,
];
