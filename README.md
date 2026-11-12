# pi-herdr-bridge

User-owned [pi](https://pi.dev) ↔ [herdr](https://herdr.dev) glue, installed as a
pi extension next to herdr's own managed `herdr-agent-state.ts` integration
(do not edit that one — herdr overwrites it on updates).

## What it does

1. **Blocked state** — while pi waits on a blocking UI prompt (e.g. the
   pi-permission-system "Permission Required" dialog), tells herdr the pane
   is blocked. Uses pi core events only (`ui_prompt_start` / `ui_prompt_end`)
   and the `herdr:blocked` event consumed by `herdr-agent-state.ts`.
2. **Compacting label** — while pi is compacting, shows a display-only
   `compacting` state label in the herdr sidebar (`pane report-metadata`),
   cleared when compaction ends or fails. The semantic state is untouched:
   the managed `herdr:pi` integration has exclusive lifecycle authority over
   pi panes, so metadata is the only sanctioned channel.
3. **Auto-naming + name sync** — the pane label is the source of truth; a
   10s loop reconciles the herdr agent name with it (derives a short label
   from the cwd + workspace/pane numbers when both are unnamed).
4. **Terminal title** — strips pi's `π - ` / `Pi-Bolt - ` prefix from the OSC title written to the terminal (stdout write filter), and re-asserts `"<name> - <cwd>"` when a session is renamed programmatically (`session_info_changed`) or on session start — pi only repaints the title on core-initiated renames, so auto-generated session names otherwise never appear in it.

5. **Session identity** — herdr records a pane's agent session (`pane.agent_session`) only from reports sent under its reserved pi source (`herdr:pi`) and only when the report names a recognized `session_start_source` (`startup`, `resume`, `compact`, … — see `session_start_source_is_recognized` in herdr's `src/terminal/state.rs`). pi's own herdr integration omits that field, so its report is parked as suppressed and pi-bolt panes carry no session identity. On `session_start` the bridge reports it itself: `pane report-agent-session --source herdr:pi --agent pi --seq <ms*1000> --session-start-source startup --agent-session-path <pi session file> -- pi --session <file>`. The restore command is a bare `pi` because herdr validates argv that way and types it into the pane's shell — your own PATH and aliases decide what restarts, so this works unchanged for pi and for any pi-compatible fork.

   Limit: herdr's sidebar *state* for these panes still comes from the pi screen manifest, which does not match pi-bolt's TUI (`herdr agent explain` keeps `fallback_reason: default_known_agent_idle_fallback`); that needs detection-manifest rules or a herdr update.

## Install

pi install git:github.com/rodstrom/pi-herdr-bridge

pi list shows configured packages. After pushing changes, run
pi update --extensions to reconcile the checkout, then reload your pi
session. pi remove git:github.com/rodstrom/pi-herdr-bridge uninstalls.

Important: in ~/.pi/agent/settings.json, this package must be listed BEFORE the BetterCompaction package in the "packages" array. Pi runs session_before_compact handlers sequentially in load order, and BetterCompaction performs its entire LLM summarization inside its handler; if it loads first, the compacting label is only set in the milliseconds before compaction finishes.

## Requirements

- Runs only inside herdr (`HERDR_ENV=1` + `HERDR_PANE_ID` set); no-ops elsewhere.
- `herdr` CLI on `PATH` (or `HERDR_BIN_PATH` set).
- The official herdr pi integration installed (`herdr integration install pi`).

All herdr calls are fire-and-forget with a 3s timeout; failures never affect
the pi session.
