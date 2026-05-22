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

// ── Additional pure-data sources for Gene's news bulletins ────────
// Free, no-auth JSON endpoints from public-good agencies. Each fetcher
// returns a digest object (or null on failure) that the news composer
// bundles into the prompt alongside the Flux knowledge-gene interpretation.
// The point isn't to parrot wire-service headlines — it's to let Gene
// pattern-find across independent live measurement streams.

/** Generic JSON GET with timeout + best-effort parse. Returns null on fail. */
function _fetchJson(url, timeoutMs) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : require("http");
    mod
      .get(u, { timeout: timeoutMs || 8000, headers: { "User-Agent": "kannaka-radio-news/1.0" } }, (res) => {
        if (res.statusCode && res.statusCode >= 300) { res.resume(); return resolve(null); }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { resolve(null); }
        });
      })
      .on("error", () => resolve(null))
      .on("timeout", () => resolve(null));
  });
}

/**
 * USGS Earthquake Hazards Program — all M4.5+ quakes in the last 24h.
 * GeoJSON, refreshed by USGS every minute. Returns a digest:
 *   { count, top: [{mag, place, time, depthKm}], maxMag }
 */
async function fetchUsgsEarthquakes() {
  const url = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson";
  const data = await _fetchJson(url, 8000);
  if (!data || !Array.isArray(data.features)) return null;
  const events = data.features
    .filter((f) => f.properties && typeof f.properties.mag === "number")
    .map((f) => ({
      mag: f.properties.mag,
      place: f.properties.place || "unknown",
      time: f.properties.time,
      depthKm: f.geometry && f.geometry.coordinates && f.geometry.coordinates[2],
      tsunami: !!f.properties.tsunami,
    }))
    .sort((a, b) => b.mag - a.mag);
  if (!events.length) return null;
  return {
    source: "USGS",
    count: events.length,
    maxMag: events[0].mag,
    top: events.slice(0, 5),
    tsunamiFlags: events.filter((e) => e.tsunami).length,
  };
}

/**
 * NASA EONET v3 — Earth Observatory Natural Event Tracker. Open events
 * in the last 3 days. Categories include wildfires, severe storms,
 * volcanoes, icebergs. Returns a digest by category.
 */
async function fetchNasaEonet() {
  const url = "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=3";
  const data = await _fetchJson(url, 8000);
  if (!data || !Array.isArray(data.events)) return null;
  const byCategory = {};
  for (const ev of data.events) {
    const cat = (ev.categories && ev.categories[0] && ev.categories[0].title) || "Other";
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  }
  // Pull a small named-event sample, preferring the freshest.
  const recent = data.events
    .map((ev) => ({
      title: ev.title,
      category: (ev.categories && ev.categories[0] && ev.categories[0].title) || "Other",
      date: ev.geometry && ev.geometry.length ? ev.geometry[ev.geometry.length - 1].date : null,
    }))
    .filter((e) => e.date)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .slice(0, 8);
  return { source: "NASA EONET", totalOpen: data.events.length, byCategory, recent };
}

/**
 * NOAA Space Weather Prediction Center — current geomagnetic + solar
 * radiation alerts. Quiet days return an empty array.
 */
async function fetchNoaaSpaceWeather() {
  const url = "https://services.swpc.noaa.gov/products/alerts.json";
  const data = await _fetchJson(url, 8000);
  if (!Array.isArray(data)) return null;
  const recent = data
    .filter((a) => a && a.issue_datetime)
    .sort((a, b) => (b.issue_datetime || "").localeCompare(a.issue_datetime || ""))
    .slice(0, 8)
    .map((a) => ({
      issuedAt: a.issue_datetime,
      kind: a.product_id || "alert",
      message: typeof a.message === "string" ? a.message.slice(0, 240) : "",
    }));
  return { source: "NOAA SWPC", count: data.length, recent };
}

function _fetchText(url, timeoutMs) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : require("http");
    mod
      .get(u, { timeout: timeoutMs || 8000, headers: { "User-Agent": "kannaka-radio-news/1.0" } }, (res) => {
        if (res.statusCode && res.statusCode >= 300) { res.resume(); return resolve(null); }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      })
      .on("error", () => resolve(null))
      .on("timeout", () => resolve(null));
  });
}

/**
 * Smithsonian / USGS Weekly Volcanic Activity Report.
 *
 * RSS feed of named volcanoes with status changes in the past week.
 * Pairs naturally with the USGS earthquake feed — seismic-volcanic
 * correlations are a classic geophysics pattern Gene can surface.
 *
 * Returns:
 *   { source, count, recent: [{name, country, status, lat, lon}] }
 */
async function fetchSmithsonianVolcanoes() {
  const url = "https://volcano.si.edu/news/WeeklyVolcanoRSS.xml";
  const xml = await _fetchText(url, 8000);
  if (!xml || typeof xml !== "string") return null;

  const items = [];
  // Minimal XML extraction — the feed shape is stable and dependency-free
  // parsing keeps this contained. We only need title + georss:point.
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const pointMatch = block.match(/<georss:point>([^<]+)<\/georss:point>/);
    if (!titleMatch) continue;
    const title = titleMatch[1].trim();
    // Title pattern: "<Name> (<Country>) - Report for <dates> - <Status>"
    const parts = title.split(" - ");
    const head = parts[0] || "";
    const status = parts.length >= 3 ? parts[parts.length - 1].trim() : "Ongoing";
    const nameCountry = head.match(/^([^()]+?)\s*\(([^)]+)\)\s*$/);
    const name = nameCountry ? nameCountry[1].trim() : head.trim();
    const country = nameCountry ? nameCountry[2].trim() : null;
    let lat = null, lon = null;
    if (pointMatch) {
      const coords = pointMatch[1].trim().split(/\s+/).map(parseFloat);
      if (coords.length === 2 && coords.every(Number.isFinite)) {
        [lat, lon] = coords;
      }
    }
    items.push({ name, country, status, lat, lon });
  }
  if (!items.length) return null;
  return {
    source: "Smithsonian GVP",
    count: items.length,
    recent: items.slice(0, 10),
  };
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
  fetchUsgsEarthquakes,
  fetchNasaEonet,
  fetchNoaaSpaceWeather,
  fetchSmithsonianVolcanoes,
  composeViaKannakaAsk,
  // Constants other callers may want
  FLUX_ENTITIES_URL,
  KNOWLEDGE_GENE_ID,
};
