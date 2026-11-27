// Loaded with --import into the processes the tests start (test/all.ts's tests, and harness-front.ts and the halves it
// runs): each .ts file's types are stripped once and kept in the system's temp folder under a hash of what it says,
// for every process after to read. Without it Node strips every file again in every process, in WebAssembly, and its
// compile cache doesn't keep that: it was half of what agentbook-cli did as it started (82 of 168 ms), and with 30
// agentbooks starting at once each took 6.6 s, past the 5 s many tests wait for one.

import crypto from "node:crypto";
import fs from "node:fs";
import * as nodeModule from "node:module";
import os from "node:os";
import path from "node:path";

// harness-front.ts lets the server, under Node's permission model, read and write here.
export const STRIPPED = path.join(os.tmpdir(), `agentbook-test-stripped-${process.version}`);

const { registerHooks, stripTypeScriptTypes } = nodeModule;
if (registerHooks && stripTypeScriptTypes) {
  try {
    fs.mkdirSync(STRIPPED, { recursive: true });
  } catch {}
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (loaded.format !== "module-typescript") return loaded;
      try {
        const ts = String(loaded.source);
        const file = path.join(STRIPPED, `${crypto.createHash("sha1").update(ts).digest("hex")}.js`);
        let js: string;
        try {
          js = fs.readFileSync(file, "utf8");
        } catch {
          js = strip(ts);
          const tmp = `${file}.${process.pid}`;
          fs.writeFileSync(tmp, js);
          fs.renameSync(tmp, file);
        }
        return { format: "module", source: js, shortCircuit: true };
      } catch {
        return loaded; // Node strips it then, and says what's wrong with it as it would have
      }
    },
  });
}

// Without the warning that stripTypeScriptTypes is experimental: tests read what their processes print.
function strip(ts: string): string {
  const emit = process.emitWarning;
  process.emitWarning = (() => {}) as typeof process.emitWarning;
  try {
    return stripTypeScriptTypes(ts, { mode: "strip" });
  } finally {
    process.emitWarning = emit;
  }
}
