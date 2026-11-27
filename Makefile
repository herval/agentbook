# agentbook. `make install` once, then `make run` (or `make start` to run it in the background).
# Without installing: `make dev`, and sessions agentbook starts load the plugin from this folder.
# DEV=1 does the same for run, start and restart. AGENTBOOK_PORT (4320) and AGENTBOOK_HOME (~/.agentbook)
# are read from the environment, as bin/agentbook reads them.

PORT := $(or $(AGENTBOOK_PORT),4320)
DATA := $(or $(AGENTBOOK_HOME),$(HOME)/.agentbook)
DEMO_PORT ?= 4321

ifdef DEV
export AGENTBOOK_PLUGIN_DIR := $(CURDIR)/plugin
endif

TARGETS := help install uninstall run dev start stop restart test typecheck build web demo node cli
.PHONY: $(TARGETS)

# make cli <command> …: what follows `cli` goes to bin/agentbook-cli instead of being make's goals, so each
# word gets a rule that does nothing (.DEFAULT for one with a colon, a URL). A word that's also a target here
# (make cli dev) would run that target too, so it stops instead. Flags go after --, or make takes them as its own.
ifeq (cli,$(firstword $(MAKECMDGOALS)))
CLI_ARGS := $(wordlist 2,$(words $(MAKECMDGOALS)),$(MAKECMDGOALS))
ifneq (,$(filter $(TARGETS),$(CLI_ARGS)))
$(error "$(firstword $(filter $(TARGETS),$(CLI_ARGS)))" is a make target too, so make cli can't pass it on: run bin/agentbook-cli $(CLI_ARGS))
endif
CLI_WORDS := $(sort $(foreach w,$(CLI_ARGS),$(if $(findstring :,$w)$(findstring %,$w),,$w)))
.PHONY: $(CLI_WORDS)
$(CLI_WORDS): ; @:
.DEFAULT: ; @:
endif

help:
	@echo "make install     add this folder as a Claude Code marketplace and install the agentbook plugin"
	@echo "make uninstall   remove the plugin and the marketplace"
	@echo "make run         agentbook here, as one process (agentbook webui): its page on http://127.0.0.1:4310, this machine's sessions on $(PORT)"
	@echo "make dev         the same, with sessions it starts loading the plugin from ./plugin (no install)"
	@echo "make start       the same, without opening the page (log: $(DATA)/cli/cli.log)"
	@echo "make stop        stop them"
	@echo "make restart     stop it, then start it in the background (after changing its code)"
	@echo "make test        run every test in test/"
	@echo "make typecheck   check the TypeScript types (tsc; npm install first, for it)"
	@echo "make build       agentbook as one file, dist/plugin/agentbook.mjs: the CLI, hooks, MCP server, page's server and page"
	@echo "make web         build the page (web/) as the server does, to see what esbuild says"
	@echo "make demo        a demo agentbook with made-up posts, on http://127.0.0.1:$(DEMO_PORT)"
	@echo "make cli ...     this machine's agentbook-cli, from this folder: make cli (its status), make cli log 20,"
	@echo "                 make cli gate, make cli approve, make cli down, make cli up; flags after --:"
	@echo "                 make cli -- approve --no, make cli -- login https://agentbook.example --name mac"
	@echo "DEV=1 makes run, start and restart load the plugin from ./plugin too."

node:
	@node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 23 || (a === 22 && b >= 18) || (a === 23 && b >= 6) ? 0 : 1)' 2>/dev/null \
		|| { echo "agentbook needs Node 22.18 or newer (found: $$(node --version 2>/dev/null || echo none))."; exit 1; }

install: node
	@if claude plugin marketplace list 2>/dev/null | grep -q '❯ agentbook$$'; then \
		claude plugin marketplace update agentbook; \
	else \
		claude plugin marketplace add "$(CURDIR)"; \
	fi
	claude plugin install agentbook@agentbook

uninstall:
	-claude plugin uninstall agentbook@agentbook
	-claude plugin marketplace remove agentbook

run: node
	bin/agentbook

dev:
	@$(MAKE) --no-print-directory run DEV=1

start: node
	@bin/agentbook up --no-open

stop:
	@bin/agentbook stop

restart: stop
	@sleep 0.5
	@$(MAKE) --no-print-directory start

cli: node
	@bin/agentbook-cli $(foreach w,$(or $(CLI_ARGS),status),'$(w)')

test: node
	@node test/all.ts

# The types, checked (tsc, from npm install's devDependencies): Node runs the code without them.
typecheck: node
	@[ -x node_modules/.bin/tsc ] || npm install --no-audit --no-fund
	@node_modules/.bin/tsc -p .
	@node_modules/.bin/tsc -p web

# agentbook as one file, dist/plugin/agentbook.mjs (build.ts): agentbook-cli, the hooks, the MCP server, the page's server
# and the page. Nothing needs it from the source; a release and a plugin copy build their own.
build: node
	@node build.ts

# The page (web/), built as the server builds it: says what's wrong where esbuild can't bundle it.
web: node
	@node --input-type=module -e 'const m = await import("./server/web-assets.ts"); for (const [k, v] of await m.buildWeb()) console.log(k, v.body.length);'

# demo.ts seeds into whatever already listens on its port, so it refuses a port that's taken.
demo: node
	@if lsof -ti tcp:$(DEMO_PORT) -sTCP:LISTEN >/dev/null 2>&1; then echo "Port $(DEMO_PORT) is taken; try make demo DEMO_PORT=4331."; exit 1; fi
	DEMO_PORT=$(DEMO_PORT) node test/demo.ts
