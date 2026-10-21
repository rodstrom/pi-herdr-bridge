// herdr-bridge.ts
//
// General pi <-> herdr glue. Lives beside herdr's own herdr-agent-state.ts
// (herdr-managed - do NOT edit that file); this file is user-owned.
//
// 1. Blocked state: while pi waits on a blocking user-facing UI prompt
//    (e.g. the pi-permission-system "Permission Required" dialog), tell
//    herdr the pane is blocked. Uses pi core events only
//    (ui_prompt_start / ui_prompt_end), so it keeps working across
//    permission-extension updates. herdr-agent-state.ts consumes the
//    "herdr:blocked" event with a counter: active:true increments,
//    active:false decrements (floored at 0).
//
// 2. Compacting state: while pi is compacting, show a display-only
//    "compacting" state label in herdr (via pane report-metadata), cleared
//    when compaction ends or fails. The semantic state is NOT touched: the
//    managed herdr:pi integration has exclusive lifecycle authority over pi
//    panes and the server silently ignores report-agent calls from other
//    sources, so metadata is the only sanctioned channel (per herdr docs:
//    "User hooks that run next to a Herdr-managed integration should use
//    metadata instead of report-agent").
//
// 3. Auto-naming + name sync: the pane label is the source of truth.
//    A sync loop (every 10s) reconciles agent name with pane label:
//      - both unnamed  -> derive a short label from the cwd: a 3-letter
//        budget over the directory's words (first word takes the remainder,
//        later words 1 letter each) plus the workspace+pane numbers
//        concatenated (unique server-wide): .dotfiles w1:p1 -> dot11,
//        plejd-app w2:p2 -> pla22, w1:pA -> dot1a; set on both
//      - label changed -> agent name follows (within one tick)
//      - label cleared -> agent name is cleared
// @ts-nocheck

import { spawn } from "node:child_process";

const HERDR_BIN = process.env.HERDR_BIN_PATH || "herdr";
const PANE_ID = process.env.HERDR_PANE_ID;

function herdrEnabled() {
  return process.env.HERDR_ENV === "1" && !!PANE_ID;
}

// Fire-and-forget CLI call; never throws, never blocks the session.
function run(args) {
  return new Promise((resolve) => {
    try {
      const p = spawn(HERDR_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("close", (code) => resolve({ code: code ?? -1, out }));
      p.on("error", () => resolve({ code: -1, out: "" }));
      setTimeout(() => {
        try {
          p.kill();
        } catch {
          // already gone
        }
      }, 3000).unref?.();
    } catch {
      resolve({ code: -1, out: "" });
    }
  });
}

// 3-letter budget over the cwd basename's words.
function baseFromCwd(cwd) {
  const name = (cwd || "").split(/[\\/]/).filter(Boolean).pop() || "";
  const words = name.split(/[^a-zA-Z0-9]+/).filter(Boolean).slice(0, 3);
  if (words.length === 0) return "";
  const firstLen = Math.max(1, 3 - (words.length - 1));
  let base = words[0].slice(0, firstLen).toLowerCase();
  for (let i = 1; i < words.length; i++) {
    base += (words[i][0] || "").toLowerCase();
  }
  return base;
}

const NAME_SYNC_INTERVAL_MS = 10_000;
let nameSyncStarted = false;

// 2. Compacting state
const BRIDGE_SOURCE = "user:pi-bridge";
let compactingReported = false;

function compactSetLabel() {
  // Keyed on both idle and working: manual /compact runs while the semantic
  // state is idle; mid-run auto-compact runs while it is working.
  void run([
    "pane",
    "report-metadata",
    PANE_ID,
    "--source",
    BRIDGE_SOURCE,
    "--state-label",
    "idle=compacting",
    "--state-label",
    "working=compacting",
  ]);
}

function doCompactClear() {
  if (!compactingReported) return;
  compactingReported = false;
  void run([
    "pane",
    "report-metadata",
    PANE_ID,
    "--source",
    BRIDGE_SOURCE,
    "--clear-state-labels",
  ]);
}

function compactEnd(_event: unknown, _ctx: any) {
  if (!compactingReported) return;
  doCompactClear();
}

async function nameSyncTick() {
  if (!herdrEnabled()) return;
  const [paneOut, agentOut] = await Promise.all([
    run(["pane", "list"]),
    run(["agent", "list"]),
  ]);
  let panes = [];
  let agents = [];
  try {
    panes = JSON.parse(paneOut.out)?.result?.panes || [];
  } catch {
    // ignore
  }
  try {
    agents = JSON.parse(agentOut.out)?.result?.agents || [];
  } catch {
    // ignore
  }
  const me = panes.find((p) => p.pane_id === PANE_ID);
  if (!me) return; // not registered in herdr yet; next tick will catch it
  const agent = agents.find((a) => a.pane_id === PANE_ID);
  if (!agent) return;

  const label = me.label || "";
  if (!label) {
    if (!agent.name) {
      // Both unnamed: derive and set both.
      const idm = PANE_ID.match(/w([0-9a-z]+):p([0-9a-z]+)$/i);
      const base = baseFromCwd(process.cwd());
      if (!idm || !base) return;
      const name = base + (idm[1] + idm[2]).toLowerCase(); // e.g. dot11, pla22
      await run(["pane", "rename", PANE_ID, name]);
      await run(["agent", "rename", PANE_ID, name]);
    } else {
      // Label was cleared: clear the agent name to match.
      await run(["agent", "rename", PANE_ID, "--clear"]);
    }
    return;
  }

  // Label is the source of truth: sync the agent name to it.
  if (agent.name !== label) {
    await run(["agent", "rename", PANE_ID, label]);
  }
}

function startNameSync() {
  if (nameSyncStarted || !herdrEnabled()) return;
  nameSyncStarted = true;
  const loop = async () => {
    try {
      await nameSyncTick();
    } catch {
      // best-effort
    }
    setTimeout(loop, NAME_SYNC_INTERVAL_MS).unref?.();
  };
  void loop();
}

export default function (pi) {
  // 1. Blocked state
  pi.on("ui_prompt_start", (event) => {
    const title =
      typeof event?.title === "string" && event.title.length > 0
        ? event.title.split("\n")[0].trim()
        : undefined;
    try {
      pi.events.emit("herdr:blocked", {
        active: true,
        label: title ? `waiting: ${title}` : "waiting for user input",
      });
    } catch {
      // never let reporting interfere with the prompt itself
    }
  });

  pi.on("ui_prompt_end", () => {
    try {
      pi.events.emit("herdr:blocked", { active: false });
    } catch {
      // ignore
    }
  });

  // 2. Compacting state
  pi.on("session_before_compact", (_event, _ctx) => {
    // Display-only label: the semantic state is untouched, so the managed
    // integration keeps lifecycle authority no matter when compaction runs
    // (manual /compact or mid-run auto-compact).
    if (!herdrEnabled()) return;
    compactingReported = true;
    compactSetLabel();
  });
  pi.on("session_compact", compactEnd);
  pi.on("session_compact_failed", compactEnd);

  // 3. Auto-naming + sync (TUI only; fire-and-forget loop)
  pi.on("session_start", (_event, ctx) => {
    if (ctx?.mode !== "tui") return;
    // Self-heal: clear any stale "compacting" label left by a previous
    // process that died mid-compaction. The label is server-side state and
    // outlives the process; source-scoped, so it only clears our labels.
    void run([
      "pane",
      "report-metadata",
      PANE_ID,
      "--source",
      BRIDGE_SOURCE,
      "--clear-state-labels",
    ]);
    startNameSync();
  });
}
