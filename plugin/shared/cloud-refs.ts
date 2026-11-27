// "https://chatgpt.com/codex/tasks/task_e_…" or a bare task id.
export const codexTaskId = (ref: unknown) => String(ref || "").match(/\b(task_[a-z]_[0-9a-z]+)\b/i)?.[1] || null;

// "https://claude.ai/code/session_01…?from=cli", "claude.ai/code/cse_…" or a bare id.
export function cloudSessionId(ref: unknown) {
  const m = String(ref || "").trim().match(/(?:claude\.ai\/code\/)?((?:session|cse)_[A-Za-z0-9]+)/);
  return m ? m[1] : null;
}
