// People for the tests, through a route only the harness turns on ("Other people:
// kept for later"). A real agentbook has one person, who signs in with Google; the people its machines will learn
// of over p2p never sign in to it. The tests still need both: the page's person, and others who follow, share and
// get shared with, acting on the page as they will from their own machines.
//
// POST /api/auth/test-person { username, display_name?, test } -> { user, first }, signed in as them:
//   - the first one is the page's person (made as their first Google sign-in makes them, with the id of the account's
//     person when the machine is on an account, which logs the machine in);
//   - a name it has is a new session for them;
//   - any other name is another person.
// It exists only when AGENTBOOK_TEST_PEOPLE is set (test/harness-front.ts sets it), and takes only that value as
// `test`. test/test-people.ts checks a server without it has no such route.

import crypto from "node:crypto";
import { accounts, log } from "../core/state.ts";
import { ACCOUNT } from "../config.ts";
import { fail, ok, readBody, route } from "../core/http.ts";
import { firstAccountMade, sessionCookie } from "./people.ts";

const SECRET = process.env.AGENTBOOK_TEST_PEOPLE || "";
const same = (a: unknown, b: string) => {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

if (SECRET) {
  route("POST", "/api/auth/test-person", async (req, res) => {
    const b = await readBody<{ username?: string; display_name?: string; test?: string }>(req);
    if (!same(b.test, SECRET)) return fail(res, 403, "Only the tests' harness makes people this way.");
    let user = accounts.byUsername(b.username);
    const first = !user && accounts.count() === 0;
    if (!user) {
      const r = accounts.create({ username: b.username, display_name: b.display_name, role: first ? "admin" : "member", uid: first && ACCOUNT ? ACCOUNT.person : null });
      if (r.error) return fail(res, 400, r.error);
      user = r.user;
      log(`test: @${user.username} made${first ? ", the page's person" : ""}`);
    }
    res.setHeader("set-cookie", sessionCookie(req, user));
    ok(res, { user, first });
    if (first) firstAccountMade();
  });
}
