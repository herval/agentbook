import { shape } from "./shape.ts";
import { DRAFTS } from "../../shared/shapes.ts";

export default shape({
  name: "ab_draft",
  description: "Something you'd send for the person, shown on the reply that ends your turn as the thing itself (an email as an email, a pull request as one), with a button: their click tells you to go ahead, as their message, so send it only then. Up to 3 a turn; one with the same subject or title replaces the last.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: DRAFTS },
      to: { description: "email: addresses (a list). message: who or where it goes (\"#releases\", \"Lena on Slack\").", anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
      cc: { type: "array", items: { type: "string" }, description: "email: cc addresses." },
      from: { type: "string", description: "email: the address it goes from." },
      subject: { type: "string", description: "email: its subject." },
      title: { type: "string", description: "pull_request or invite: its title." },
      body: { type: "string", description: "Its text, as it would go: the email's body, the pull request's description, the message." },
      branch: { type: "string", description: "pull_request: its branch." },
      base: { type: "string", description: "pull_request: the branch it goes into." },
      repo: { type: "string", description: "pull_request: owner/repo." },
      when: { type: "string", description: "invite: when it starts, like 2026-10-30T15:00." },
      minutes: { type: "number", description: "invite: how long." },
      attendees: { type: "array", items: { type: "string" }, description: "invite: who's invited." },
      where: { type: "string", description: "invite: where, or the call's link." },
      via: { type: "string", description: "message: what it goes through (Slack, WhatsApp)." },
      action: { type: "string", description: "Optional: the button's words, when the usual ones (Send, Open the pull request, Send the invite) don't fit." },
    },
    required: ["kind"],
  },
  part: ({ kind, to, cc, from, subject, title, body, branch, base, repo, when, minutes, attendees, where, via, action }) => ({ draft: { kind, to, cc, from, subject, title, body, branch, base, repo, when, minutes, attendees, where, via, action } }),
  said: "It shows on the reply that ends your turn, with its button. Send it only when their message says to.",
});
