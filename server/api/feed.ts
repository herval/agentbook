import { accounts, commit } from "../core/state.ts";
import { fail, ok, readBody, route, str } from "../core/http.ts";
import { pushLive } from "../core/services.ts";
import { addedFor, viewForReq } from "./views.ts";

// Pins are each person's own: pin any post you can see.
// The bell opened: its news and what someone put you in until now are seen (addedFor): off its count, still listed.
route("POST", "/api/bell/seen", (req, res) => {
  if (!req.user) return fail(res, 403, "A person opens the bell, not a machine.");
  if (addedFor(req).some((x) => !x.seen)) commit({ t: "bell.seen", user: req.user.id });
  ok(res);
});
// Clear notifications: all of them until now are off the bell, on every device of theirs. What waits on them (Needs
// you) stays.
route("POST", "/api/bell/clear", (req, res) => {
  if (!req.user) return fail(res, 403, "A person clears the bell, not a machine.");
  if (addedFor(req).length) commit({ t: "bell.clear", user: req.user.id });
  ok(res);
});
// A line taken off the bell, on every device of theirs: `key` is which (a routine by its id, a question as q:<id>, a
// thread that ended asking as ask:<id>, news and what someone put them in as new:…, as the page names them), `at`
// when what it says happened. What it's about stays as it is (a routine failed on its page, a question open on its
// thread), and the same thing happening later is on the bell again.
route("POST", "/api/bell/dismiss", async (req, res) => {
  if (!req.user) return fail(res, 403, "A person dismisses it, not a machine.");
  const b = await readBody<{ key?: string; at?: string }>(req);
  const key = str(b.key, 600);
  if (!key) return fail(res, 400, "Which line?");
  commit({ t: "bell.dismiss", user: req.user.id, key, failed: str(b.at, 40) || "" });
  ok(res);
});
route("POST", "/api/pins", async (req, res) => {
  const b = await readBody<{ post?: string; pinned?: boolean }>(req);
  const id = str(b.post, 200);
  const s = viewForReq(req).sessions.find((x) => x.id === id);
  if (!s) return fail(res, 404, "No such thread");
  if (b.pinned !== false && s.archived) return fail(res, 409, "It's archived: bring it back to pin it.");
  accounts.pin(req.user.id, id, b.pinned !== false);
  pushLive();
  ok(res);
});
// So are follows: follow any page you can see, and it shows on your feed.
route("POST", "/api/follows", async (req, res) => {
  const b = await readBody<{ page?: string; followed?: boolean }>(req);
  const id = str(b.page, 200);
  if (!viewForReq(req).pages.some((p) => p.id === id)) return fail(res, 404, "No such page");
  accounts.follow(req.user.id, id, b.followed !== false);
  pushLive();
  ok(res);
});
