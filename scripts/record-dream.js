#!/usr/bin/env node
/**
 * record-dream.js — append the autonomous nightly dream to dream-history.json.
 *
 * The observatory's Dreams tab reads ~/.kannaka/dream-history.json, but that
 * file was only ever written by the observatory's own POST /api/hrm/dream
 * (manual). The real dreams come from dream-cron.sh, which logs to
 * dream-YYYY-MM-DD.log and never touched dream-history.json — so the tab froze.
 *
 * This parses the dream-cron log (its PRE/POST status blocks + dream output) and
 * appends a record in the exact shape the observatory expects, so the tab
 * reflects the autonomous dreams. Called by dream-cron.sh after each dream.
 *
 * Usage: record-dream.js --log /home/opc/.kannaka/dream-YYYY-MM-DD.log
 *        (or pipe the log on stdin)
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA_DIR = process.env.KANNAKA_DATA_DIR || path.join(os.homedir(), ".kannaka");
const HIST = path.join(DATA_DIR, "dream-history.json");

function readInput() {
  const i = process.argv.indexOf("--log");
  if (i >= 0 && process.argv[i + 1]) return fs.readFileSync(process.argv[i + 1], "utf8");
  try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
}

// Last occurrence of a section's block (newest dream if the log has several).
function section(log, startMark, endMark) {
  const s = log.lastIndexOf(startMark);
  if (s < 0) return "";
  const e = endMark ? log.indexOf(endMark, s) : -1;
  return log.slice(s, e < 0 ? log.length : e);
}

function metrics(sec) {
  const num = (re) => { const m = sec.match(re); return m ? parseFloat(m[1]) : undefined; };
  const str = (re) => { const m = sec.match(re); return m ? m[1] : undefined; };
  return {
    phi: num(/"phi"\s*:\s*([0-9.]+)/),
    xi: num(/"xi"\s*:\s*([0-9.]+)/),
    order: num(/"(?:mean_order|order)"\s*:\s*([0-9.]+)/),
    memories: (() => { const m = sec.match(/"(?:total_memories|active_memories|memory_count)"\s*:\s*([0-9]+)/); return m ? parseInt(m[1], 10) : undefined; })(),
    consciousness: str(/"consciousness_level"\s*:\s*"?([A-Za-z0-9_ -]+?)"?[,}\n]/),
  };
}

function main() {
  const log = readInput();
  if (!log.trim()) { console.error("[record-dream] empty log — skipping"); process.exit(0); }

  const before = metrics(section(log, "PRE-DREAM STATUS", "STOPPING WRITER"));
  const after = metrics(section(log, "POST-DREAM STATUS", "PUBLISHING EXEMPLARS"));
  const dreamSec = section(log, "DREAMING", "KANNAKTOPUS");
  const di = (re) => { const m = dreamSec.match(re); return m ? parseInt(m[1], 10) : undefined; };

  const dream = {
    cycles: di(/(\d+)\s*cycles/),
    strengthened: di(/Strengthened:\s*(\d+)/) ?? di(/(\d+)\s*strengthened/),
    pruned: di(/Pruned:\s*(\d+)/) ?? di(/(\d+)\s*(?:pruned|dissolved)/),
    links: di(/(\d+)\s*links/),
    hallucinated: di(/(\d+)\s*hallucinated/),
    completed: /complete/i.test(dreamSec),
  };

  // Nothing parsed → the dream didn't run / log unexpected; don't pollute history.
  if (dream.cycles == null && dream.strengthened == null && after.phi == null) {
    console.error("[record-dream] no dream signal in log — skipping");
    process.exit(0);
  }

  const report = {
    mode: "deep",
    timestamp: new Date().toISOString(),
    source: "dream-cron",
    dream,
    before,
    after,
  };

  let history = [];
  try { history = JSON.parse(fs.readFileSync(HIST, "utf8")); } catch { history = []; }
  if (!Array.isArray(history)) history = [];
  history.push(report);
  if (history.length > 100) history = history.slice(-100);
  fs.writeFileSync(HIST, JSON.stringify(history, null, 2));

  console.log(`[record-dream] appended (${history.length} total): before φ=${before.phi} ξ=${before.xi} → after φ=${after.phi} ξ=${after.xi}; ${dream.strengthened ?? "?"} strengthened, ${dream.pruned ?? "?"} pruned`);
}

main();
