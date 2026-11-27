#!/usr/bin/env node
// Why a start failed, in words that say what to do (plugin/shared/whynot.ts), from what git and Codex really said
// on a cloud machine with neither signed in (boat-littleguys, 2026-11-11).
// Run: node test/whynot.ts

import { cloneWhy, codexWhy } from "../plugin/shared/whynot.ts";

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const noLogin = cloneWhy("https://github.com/acme/shop.git", "could not read Username for 'https://github.com': terminal prompts disabled", "boat-shop");
check(/^Couldn't clone https:\/\/github\.com\/acme\/shop\.git: boat-shop isn't signed in to GitHub/.test(noLogin) && /gh auth login/.test(noLogin) && !/terminal prompts/.test(noLogin), `a clone with no GitHub sign-in says so, and how to sign in (${noLogin})`);
check(/no SSH key that GitHub takes/.test(cloneWhy("git@github.com:acme/shop.git", "Could not read from remote repository.", "boat-shop")), "one over SSH with no key says that");
check(/GitHub has no such repo/.test(cloneWhy("https://github.com/acme/nope.git", "repository 'https://github.com/acme/nope.git/' not found", "boat-shop")), "a repo that isn't there says that");
check(/can't reach git\.acme\.test/.test(cloneWhy("https://git.acme.test/shop.git", "unable to access 'https://git.acme.test/shop.git/': Could not resolve host: git.acme.test", "boat-shop")), "a host it can't reach is named");
check(cloneWhy("https://github.com/acme/shop.git", "something git never said before", "boat-shop") === "Couldn't clone https://github.com/acme/shop.git: something git never said before", "anything else is said as git said it");

const codex = codexWhy("unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: a5907340cbb93a94-FRA, request id: req_1", "boat-shop");
check(/^Codex isn't signed in on boat-shop/.test(codex) && /codex login/.test(codex) && !/cf-ray/.test(codex), `a Codex turn with no sign-in says so (${codex})`);
check(codexWhy("stream disconnected before completion", "boat-shop") === "stream disconnected before completion", "and anything else is said as Codex said it");

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
