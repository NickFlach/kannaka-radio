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
    _cachedFiles = [];
    // Walk top-level files + one level of subdirectories (album folders)
    for (const entry of fs.readdirSync(musicDir, { withFileTypes: true })) {
      if (entry.isFile() && AUDIO_EXTS.has(path.extname(entry.name).toLowerCase())) {
        _cachedFiles.push(entry.name);
      } else if (entry.isDirectory()) {
        try {
          for (const sub of fs.readdirSync(path.join(musicDir, entry.name))) {
            if (AUDIO_EXTS.has(path.extname(sub).toLowerCase())) {
              _cachedFiles.push(path.join(entry.name, sub));
            }
          }
        } catch {}
      }
    }
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
  // Collect raw Buffer chunks and decode ONCE at the end. Per-chunk `body += d`
  // decodes each chunk to UTF-8 independently, which corrupts a multibyte char
  // split across a chunk boundary (deterministic at Node's 16KB highWaterMark)
  // — fatal for the Stripe webhook, whose HMAC is over the exact bytes: a
  // corrupted re-encode fails verification and silently drops the paid signal.
  const chunks = [];
  let size = 0;
  let rejected = false;
  req.on("data", d => {
    if (rejected) return;
    size += d.length;
    if (size > MAX_BODY) {
      rejected = true;
      req.destroy();
      res.writeHead(413);
      res.end("Payload too large");
      return;
    }
    chunks.push(d);
  });
  req.on("end", () => { if (!rejected) callback(Buffer.concat(chunks).toString("utf8")); });
}

// ── Fuzzy audio file matching ──────────────────────────────

function findAudioFile(trackName, musicDir) {
  const files = getFiles(musicDir);
  const lower = trackName.toLowerCase();

  // Pass 1: exact basename match (or with leading track-number stripped).
  // Must be a separate pass from substring — interleaving them let a title
  // like "Hard Fork" grab "Hard Fork x Was Ist Das_ (Mashup).mp3" when the
  // mashup happened to be listed first by readdir.
  for (const f of files) {
    const base = path.basename(f, path.extname(f));
    const cleaned = base.replace(/^\d+[\s.\-_]+/, "").trim().toLowerCase();
    const baseLower = base.toLowerCase();
    if (cleaned === lower || baseLower === lower) return f;
  }

  // Pass 2: substring match (basename includes the title).
  for (const f of files) {
    const base = path.basename(f, path.extname(f));
    const baseLower = base.toLowerCase();
    if (baseLower.includes(lower)) return f;
  }

  // Pass 3: fuzzy word overlap (>=70%)
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
