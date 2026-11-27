// A stand-in exe.dev, for the exe.dev tests: POST /exec as agentbook's exe.dev connector asks it
// (server/integrations/connectors/exe.ts), answering as exe.dev/docs/https-api says: a bearer token, the command as
// the body, JSON back, and `ssh <vm> "<command>"` answered as NDJSON ({stdout}, {stderr} in base64, {exit_code}).
// It keeps what it was asked (`calls`), the VMs it has, and the files written on them. Tests never reach exe.dev.
//
// startExe({ token, vms: [{ vm_name, status }] }) -> { url, token, calls, vms, files, started, set(opts), close() }
// - set({ cmds }): the commands the token may run (null: all), as `generate-api-key --cmds` says them.
// - set({ log: { [vm]: text } }): what `cat .agentbook-build.log` answers on a VM (none: it isn't there).

import http from "node:http";
import type { AddressInfo } from "node:net";

export interface ExeVm {
  vm_name: string;
  status: string;
  tags?: string[];
  ssh_dest?: string;
  https_url?: string;
}
export interface ExeCall {
  command: string;
  at: number;
}
interface Opts {
  token?: string;
  vms?: ExeVm[];
}
export async function startExe({ token = "exe1.test-token", vms = [] }: Opts = {}) {
  const calls: ExeCall[] = [];
  const all = new Map<string, ExeVm>(vms.map((v) => [v.vm_name, { ...v }]));
  const files = new Map<string, string>(); // "<vm> <path>" -> content
  const started: { vm: string; path: string; script: string }[] = [];
  let cmds: string[] | null = null;
  let logs: Record<string, string> = {};
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const ndjson = (res: http.ServerResponse, out: string, code = 0) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.end(`${out ? `${JSON.stringify({ stdout: Buffer.from(out).toString("base64") })}\n` : ""}${JSON.stringify({ exit_code: code })}\n`);
  };
  const vmJson = (v: ExeVm) => ({ ssh_dest: `${v.vm_name}.exe.xyz`, ssh_host: `${v.vm_name}.exe.xyz`, https_url: `https://${v.vm_name}.exe.xyz`, region: "lon", region_display: "London, UK", ...v });

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/exec") return json(res, 405, { error: "POST /exec only" });
      if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: "invalid token" });
      const command = body.trim();
      calls.push({ command, at: Date.now() });
      const [cmd, ...args] = command.split(" ");
      if (cmds && !cmds.includes(cmd)) return json(res, 403, { error: `command ${cmd} not allowed by this token` });
      const flag = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
      const named = (n: string) => all.get(n) || null;
      switch (cmd) {
        case "whoami":
          return json(res, 200, { email: "herval@example.com", ssh_keys: 1 });
        case "ls":
          return json(res, 200, { vms: [...all.values()].map(vmJson) });
        case "new": {
          const name = flag("name");
          if (!name) return json(res, 422, { error: "new needs --name here" });
          if (all.has(name)) return json(res, 422, { error: `a VM called ${name} exists already` });
          const v = { vm_name: name, status: "running", tags: flag("tag") ? [flag("tag")] : [] };
          all.set(name, v);
          return json(res, 200, vmJson(v));
        }
        case "pause":
        case "resume":
        case "rm": {
          const v = named(args[0]);
          if (!v) return json(res, 422, { error: `vm not found: ${args[0]}` });
          if (cmd === "rm") all.delete(v.vm_name);
          else v.status = cmd === "pause" ? "paused" : "running";
          return json(res, 200, { vm_name: v.vm_name, status: cmd === "rm" ? "deleted" : v.status });
        }
        case "ssh": {
          const v = named(args[0]);
          if (!v) return json(res, 422, { error: `vm not found: ${args[0]}` });
          if (v.status !== "running") return json(res, 422, { error: `${v.vm_name} isn't running` });
          const inner = command.slice(`ssh ${v.vm_name} `.length).replace(/^"|"$/g, "");
          let m: RegExpExecArray | null;
          if ((m = /^umask 077 && echo (\S+) \| base64 -d > (\S+) && chmod \d+ \S+$/.exec(inner))) {
            files.set(`${v.vm_name} ${m[2]}`, Buffer.from(m[1], "base64").toString("utf8"));
            return ndjson(res, "");
          }
          if ((m = /^setsid nohup bash (\S+) .*& echo started$/.exec(inner))) {
            started.push({ vm: v.vm_name, path: m[1], script: files.get(`${v.vm_name} ${m[1]}`) || "" });
            return ndjson(res, "started\n");
          }
          if ((m = /^cat (\S+) 2>\/dev\/null \|\| echo __agentbook_none__$/.exec(inner))) {
            const text = m[1] === ".agentbook-build.log" ? logs[v.vm_name] : files.get(`${v.vm_name} ${m[1]}`);
            return ndjson(res, text ?? "__agentbook_none__\n");
          }
          return ndjson(res, "", 127);
        }
        default:
          return json(res, 404, { error: `unknown command ${cmd}` });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    token,
    calls,
    vms: all,
    files,
    started,
    set(o: { cmds?: string[] | null; log?: Record<string, string> }) {
      if ("cmds" in o) cmds = o.cmds;
      if (o.log) logs = { ...logs, ...o.log };
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
