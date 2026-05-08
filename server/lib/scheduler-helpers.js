/**
 * scheduler-helpers.js — shared building blocks for the daily voiced
 * segment schedulers (peace-oration, news-broadcast, gossip-broadcast).
 *
 * Extracted 2026-05-08 because the three modules had grown the same
 * date-key, 3-day-rolling-cutoff, Flux fetch, and kannaka-ask wrapper
 * three times over. Now there's one place to fix bugs in all three.
 */

"use strict";

const https = require("https");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const FLUX_ENTITIES_URL = "https://api.flux-universe.com/api/state/entities";
const KNOWLEDGE_GENE_ID = "knowledge-gene/state";

/** Pick a random element from an array. */
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Get the current Chicago-time Date object (matches programming.js). */
function chicagoNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
}

/**
 * Date-key: `YYYY-MM-DDTHH` for the given Chicago Date + hour. Used by
 * every segment scheduler as a once-per-day-per-slot dedup token.
 */
function keyForChicago(chi, hour) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${chi.getFullYear()}-${pad(chi.getMonth() + 1)}-${pad(chi.getDate())}T${pad(hour)}`;
}

/**
 * Read the per-segment state file (`{ "<key>": true, ... }`), pruning
 * keys older than `keepDays` (default 3) so the file stays bounded.
 * Returns `{}` on any error.
 */
function loadState(stateFile, keepDays = 3) {
  try {
    if (!fs.existsSync(stateFile)) return {};
    const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - keepDays);
    const cutoffKey = cutoff.toISOString().slice(0, 10);
    const out = {};
    for (const k of Object.keys(raw || {})) {
      if (k.slice(0, 10) >= cutoffKey) out[k] = raw[k];
    }
    return out;
  } catch (_) {
    return {};
  }
}

/** Write the per-segment state file. Creates the dir if missing. */
function saveState(stateFile, state) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (e) {
    // Caller's logger will surface the warn.
    throw e;
  }
}

/**
 * Fetch the Flux Universe `knowledge-gene/state` entity and return its
 * interpretation text + themes + tickRef. Returns null on any failure
 * (no auth required for reads).
 *
 * Side effect: caches the result on global._lastKnowledgeGene so the
 * per-track LADDER predictor (kannaktopus's world-state weighting) can
 * read fresh confidence without firing its own HTTP call. 5-min freshness
 * window in the predictor.
 */
function fetchKnowledgeGeneInterpretation() {
  return new Promise((resolve) => {
    https
      .get(FLUX_ENTITIES_URL, { timeout: 15000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const arr = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const ent = Array.isArray(arr)
              ? arr.find((x) => x && x.id === KNOWLEDGE_GENE_ID)
              : null;
            const interp = ent && ent.properties && ent.properties.interpretation;
            if (!interp || typeof interp !== "string") return resolve(null);
            const result = {
              text: interp,
              themes: ent.properties.themes || [],
              confidence: ent.properties.confidence,
              tickRef: ent.properties.tick_ref,
              lastUpdated: ent.lastUpdated,
            };
            try { global._lastKnowledgeGene = { ...result, ts: Date.now() }; } catch (_) {}
            resolve(result);
          } catch (e) {
            resolve(null);
          }
        });
      })
      .on("error", () => resolve(null))
      .on("timeout", () => resolve(null));
  });
}

/**
 * Run `kannaka ask --no-tools --quiet-tools <prompt>` and return the
 * trimmed stdout. Returns null on timeout / non-zero exit / short-output.
 *
 * 600s timeout matches peace-oration; the round-trip on a long prompt
 * commonly runs 3-5 minutes through the Anthropic API.
 *
 * Errors surface the stderr tail so callers can log a meaningful message
 * instead of execFile's generic `Command failed: <cmdline>`.
 */
function composeViaKannakaAsk(kannakabin, prompt, opts = {}) {
  const minLen = opts.minLen || 200;
  const timeoutMs = opts.timeoutMs || 600000;
  const label = opts.label || "compose";
  return new Promise((resolve) => {
    const args = ["ask", "--no-tools", "--quiet-tools", prompt];
    execFile(
      kannakabin,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, KANNAKA_QUIET: "1" },
      },
      (err, stdout, stderr) => {
        if (err) {
          const tail = (stderr || "").trim().slice(-400) || err.message;
          console.warn(`   [${label}] error (code=${err.code || "?"}): ${tail}`);
          return resolve(null);
        }
        const text = String(stdout || "").trim();
        if (!text || text.length < minLen) {
          console.warn(`   [${label}] short/empty (${text.length} chars)`);
          return resolve(null);
        }
        resolve(text);
      }
    );
  });
}

module.exports = {
  pick,
  chicagoNow,
  keyForChicago,
  loadState,
  saveState,
  fetchKnowledgeGeneInterpretation,
  composeViaKannakaAsk,
  // Constants other callers may want
  FLUX_ENTITIES_URL,
  KNOWLEDGE_GENE_ID,
};
