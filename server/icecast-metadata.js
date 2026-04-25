/**
 * icecast-metadata.js — push current-track metadata to the local Icecast
 * admin API so listeners on /preview see "Now Playing" updates in their
 * music app (VLC, Apple Music, CarPlay, etc.).
 *
 * ADR-0004 Phase 2 stopgap. The full Liquidsoap pipeline can do this
 * natively in the source side; until then this hook keeps the public
 * stream's metadata in sync with the radio's dj-engine state.
 *
 * Endpoint (no LS-managed source needed):
 *   GET http://127.0.0.1:8000/admin/metadata
 *     ?mount=/preview
 *     &mode=updinfo
 *     &song=<title - artist>
 *
 * Auth: source-password (NOT admin-password — Icecast is finicky about this).
 */

"use strict";

const http = require("http");

const ICECAST_HOST = process.env.ICECAST_HOST || "127.0.0.1";
const ICECAST_PORT = parseInt(process.env.ICECAST_PORT || "8000");
const ICECAST_MOUNT = process.env.ICECAST_MOUNT || "/preview";
const ICECAST_USER = process.env.ICECAST_SOURCE_USER || "source";
const ICECAST_PASSWORD = process.env.ICECAST_SOURCE_PASSWORD || "kannaka_source_2026";

let _lastTitle = null;
let _enabled = !!process.env.ICECAST_HOST || (process.platform === "linux");

/**
 * Push a metadata update for the current track. Idempotent — same title
 * twice in a row is skipped.
 */
function updateMetadata(track) {
  if (!_enabled || !track) return;
  const title = (track.title || "").trim();
  const album = (track.album || "").trim();
  if (!title) return;

  // Format: "Title — Album" (em-dash). Icecast's `song` field is a single
  // string; most clients display it verbatim.
  const song = album ? `${title} \u2014 ${album}` : title;
  if (song === _lastTitle) return;
  _lastTitle = song;

  const path = `/admin/metadata?mount=${encodeURIComponent(ICECAST_MOUNT)}&mode=updinfo&song=${encodeURIComponent(song)}`;
  const auth = "Basic " + Buffer.from(`${ICECAST_USER}:${ICECAST_PASSWORD}`).toString("base64");
  const opts = {
    method: "GET",
    hostname: ICECAST_HOST,
    port: ICECAST_PORT,
    path,
    headers: { "Authorization": auth, "User-Agent": "Kannaka-Radio/0.3" },
    timeout: 4000,
  };
  const req = http.request(opts, (res) => {
    res.resume();
    if (res.statusCode === 200) {
      console.log(`   \u{1F3A7} icecast meta: "${song.substring(0, 70)}"`);
    } else {
      console.warn(`   [icecast-meta] ${res.statusCode} for ${song.substring(0, 60)}`);
    }
  });
  req.on("error", (e) => {
    if (e.code === "ECONNREFUSED") {
      // Icecast not running on this host — disable until restart.
      _enabled = false;
      console.log("   [icecast-meta] disabled — connection refused");
    } else {
      console.warn(`   [icecast-meta] error: ${e.message}`);
    }
  });
  req.on("timeout", () => { req.destroy(new Error("icecast metadata timeout")); });
  req.end();
}

module.exports = { updateMetadata };
