import type { ComponentType } from "react";
import { Feed } from "./feed/Feed.tsx";
import { ThreadPage } from "./thread/ThreadPage.tsx";
import { Tasks } from "./tasks/Tasks.tsx";
import { TaskPage } from "./tasks/TaskPage.tsx";
import { Connectors } from "./tasks/Connectors.tsx";
import { Worktrees } from "./worktrees/Worktrees.tsx";
import { WorktreePage } from "./worktrees/WorktreePage.tsx";
import { Pages } from "./pages/Pages.tsx";
import { PageView } from "./pages/PageView.tsx";
import { Routines } from "./routines/Routines.tsx";
import { MyRoutine } from "./routines/MyRoutine.tsx";
import { Notes } from "./notes/Notes.tsx";
import { NotePage } from "./notes/NotePage.tsx";
import { Groups } from "./groups/Groups.tsx";
import { GroupPage } from "./groups/GroupPage.tsx";
import { Agents } from "./agents/Agents.tsx";
import { AgentPage } from "./agents/AgentPage.tsx";
import { SkillPage } from "./agents/SkillPage.tsx";
import { AgentRoutine } from "./agents/AgentRoutine.tsx";
import { PersonPage } from "./people/PersonPage.tsx";
import { MachinePage } from "./machines/MachinePage.tsx";
import { Connect } from "./machines/Connect.tsx";
import { ImagePage } from "./machines/ImagePage.tsx";
import { WorkspacePage } from "./workspaces/WorkspacePage.tsx";
import { AddWorkspace } from "./workspaces/AddWorkspace.tsx";

export const VIEWS: Record<string, ComponentType> = {
  feed: Feed,
  session: ThreadPage,
  tasks: Tasks,
  task: TaskPage,
  connectors: Connectors,
  worktrees: Worktrees,
  worktree: WorktreePage,
  pages: Pages,
  dashboards: Pages,
  page: PageView,
  routines: Routines,
  myroutine: MyRoutine,
  notes: Notes,
  note: NotePage,
  groups: Groups,
  group: GroupPage,
  agents: Agents,
  agent: AgentPage,
  skill: SkillPage,
  routine: AgentRoutine,
  person: PersonPage,
  machine: MachinePage,
  connect: Connect,
  image: ImagePage,
  workspace: WorkspacePage,
  addws: AddWorkspace,
};
