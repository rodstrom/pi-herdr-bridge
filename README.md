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

## Install

pi install git:github.com/rodstrom/pi-herdr-bridge

pi list shows configured packages. After pushing changes, run
pi update --extensions to reconcile the checkout, then reload your pi
session. pi remove git:github.com/rodstrom/pi-herdr-bridge uninstalls.

## Requirements

- Runs only inside herdr (`HERDR_ENV=1` + `HERDR_PANE_ID` set); no-ops elsewhere.
- `herdr` CLI on `PATH` (or `HERDR_BIN_PATH` set).
- The official herdr pi integration installed (`herdr integration install pi`).

All herdr calls are fire-and-forget with a 3s timeout; failures never affect
the pi session.
