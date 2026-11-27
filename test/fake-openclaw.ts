#!/usr/bin/env node
// A stand-in for the `openclaw` command in tests: `openclaw gateway call <method> --params <json> --json`
// answers from FAKE_OPENCLAW_DIR (see fake-openclaw-state.ts), printing JSON, or an error and exit 1.

import { answer } from "./fake-openclaw-state.ts";

const args = process.argv.slice(2);
const out = (v: unknown) => process.stdout.write(JSON.stringify(v) + "\n");
if (args[0] !== "gateway" || args[1] !== "call") {
  out({ ok: false, error: { message: `fake openclaw: ${args.join(" ")}` } });
  process.exit(1);
}
try {
  out(answer(process.env.FAKE_OPENCLAW_DIR, args[2], JSON.parse(args[args.indexOf("--params") + 1] || "{}")));
} catch (e) {
  out({ ok: false, error: { message: e.message } });
  process.exit(1);
}
