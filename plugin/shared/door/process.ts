// Starting your door is agentbook-cli's to do, never the page's: nothing under server/ runs anything
// (test/server-isolation.ts). The agentbook-cli that loads the page (plugin/cli/webui.ts) hands it
// plugin/door/spawn.ts's spawnDoor through here; a page running without one (agentbook-server on its own) has no door.

export interface DoorProcess {
  pid: number | undefined;
  // Resolves once it exited, with its code.
  exited: Promise<number | null>;
  stop(): Promise<void>;
}
// `iroh`: how it meets other doors, as the machine's own endpoint does (plugin/shared/iroh.ts's irohHow).
export interface DoorStart {
  dir: string;
  account: string;
  relay: string;
  iroh: { mode: "local"; dir: string } | { mode: "relay"; relay: string };
  log: (line: string) => void;
  extra?: string[];
  probe?: string;
}
export type SpawnDoor = (o: DoorStart) => DoorProcess | null;

const KEY = Symbol.for("agentbook.door.spawn");
const slot = globalThis as { [KEY]?: SpawnDoor };
export const setDoorSpawner = (fn: SpawnDoor): void => {
  slot[KEY] = fn;
};
export const doorSpawner = (): SpawnDoor | null => slot[KEY] ?? null;
