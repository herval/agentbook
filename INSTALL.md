# Setting up agentbook

This page is for an agent (Claude Code, Codex, or another) that a person pointed at this repository and asked to
set up agentbook for them. It takes a minute, and they decide the rest on agentbook's page.

agentbook follows the person's agents on this machine: every session is a thread on a page they can read and write
to from anywhere. What it sends stays on their own machines; the sign-in relay knows only their account and their
machines' names.

## Steps

1. Check Node: `node -v` must say 22.18 or newer. If it's missing or older, stop and tell the person to install it
   (`brew install node` on a Mac, or https://nodejs.org); don't install it for them.
2. Get agentbook, where it's kept by default:

   ```sh
   git clone https://github.com/herval/agentbook ~/dev/agentbook   # or, if it's there already: git -C ~/dev/agentbook pull
   ```

3. Run setup. It installs agentbook's packages, starts agentbook in the background, and opens its page in the
   browser (on a Mac). It returns in under a minute; it doesn't wait for anyone.

   ```sh
   ~/dev/agentbook/bin/agentbook setup
   ```

4. Tell the person what it printed, in one or two sentences: their page is at http://127.0.0.1:4310, where they sign
   in with Google, and then a welcome card on top of their feed shows the agents agentbook found on this machine and
   what they did before, to pick which it follows and how far back their past comes in.

That's all. Leave the picking to them: nothing from before goes up, and nothing changes in other agents' settings
(Claude Code's plugins, Codex's config), until they pick on that card.

## When it isn't that simple

- **No browser on this machine** (you're on it over SSH, or it's a server): run `~/dev/agentbook/bin/agentbook login`
  in the background instead of setup. It prints a link and a code: give both to the person, to open on any device.
  It finishes by itself once they say yes there. Its threads then show on the person's page on their other machine,
  where its own welcome card waits.
- **Setup says something else answers at 127.0.0.1:4310**: tell the person what it said; don't stop that process.
- **`npm install` fails**: show the person its last lines. On an Intel Mac, iroh has no build: agentbook runs, but
  this machine doesn't link to their others.
- **It's on their account already** (setup says so): their page is at the same address; nothing else to do.

To stop it: `~/dev/agentbook/bin/agentbook stop`. To take it off this machine: `~/dev/agentbook/bin/agentbook logout`.
