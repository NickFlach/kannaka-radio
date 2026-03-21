/**
 * utils.js — Shared helpers: escapeHtml, file helpers, path resolution, body parsing.
 */

const fs = require("fs");
const path = require("path");

const AUDIO_EXTS = new Set([".mp3", ".wav", ".flac", ".m4a", ".ogg"]);
const MIME = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac", ".ogg": "audio/ogg", ".m4a": "audio/mp4" };
const MAX_BODY = 1024 * 64; // 64KB

// ── File cache — readdirSync once per dir, not per track ───

let _cachedDir = null;
let _cachedFiles = [];

function refreshFileCache(musicDir) {
  try {
    if (!fs.existsSync(musicDir)) { fs.mkdirSync(musicDir, { recursive: true }); }
    _cachedFiles = fs.readdirSync(musicDir).filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()));
    _cachedDir = musicDir;
  } catch { _cachedFiles = []; _cachedDir = musicDir; }
}

function getFiles(musicDir) {
  if (_cachedDir !== musicDir) refreshFileCache(musicDir);
  return _cachedFiles;
}

function invalidateCache() { _cachedDir = null; }

// ── SPA — serve workspace/index.html ───────────────────────

let _spaCache = null;
let _spaWatcher = null;

function initSPA(spaPath) {
  // Watch for changes during development
  try {
    _spaWatcher = fs.watch(spaPath, () => { _spaCache = null; });
  } catch {}
}

function getSPA(spaPath) {
  if (!_spaCache) {
    try { _spaCache = fs.readFileSync(spaPath, "utf8"); }
    catch { return "<h1>workspace/index.html not found</h1>"; }
  }
  return _spaCache;
}

// ── Body parser ────────────────────────────────────────────

function readBody(req, res, callback) {
  let body = "";
  let size = 0;
  req.on("data", d => {
    size += d.length;
    if (size > MAX_BODY) { req.destroy(); res.writeHead(413); res.end("Payload too large"); return; }
    body += d;
  });
  req.on("end", () => callback(body));
}

// ── Fuzzy audio file matching ──────────────────────────────

function findAudioFile(trackName, musicDir) {
  const files = getFiles(musicDir);
  const lower = trackName.toLowerCase();

  // Pass 1: exact / prefix-stripped / substring
  for (const f of files) {
    const base = path.basename(f, path.extname(f));
    const cleaned = base.replace(/^\d+[\s.\-_]+/, "").trim().toLowerCase();
    const baseLower = base.toLowerCase();
    if (cleaned === lower || baseLower === lower) return f;
    if (baseLower.includes(lower)) return f;
  }

  // Pass 2: fuzzy word overlap (>=70%)
  const words = lower.split(/\s+/);
  for (const f of files) {
    const base = path.basename(f, path.extname(f)).toLowerCase();
    const matches = words.filter(w => base.includes(w));
    if (matches.length >= words.length * 0.7) return f;
  }

  return null;
}

module.exports = {
  AUDIO_EXTS,
  MIME,
  MAX_BODY,
  getFiles,
  invalidateCache,
  refreshFileCache,
  initSPA,
  getSPA,
  readBody,
  findAudioFile,
};
