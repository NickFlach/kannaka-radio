#!/usr/bin/env node
/** Upload TSOF E01 to YouTube: creates "The Story of Flaukowski" playlist on first run. */
"use strict";
const path = require("path");
const fs = require("fs");
const https = require("https");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const R = path.join(ROOT, "workspace", "podcasts", "renders");
let PLAYLIST = ""; // created on first run; then paste the id here / in the skill

const EP = {
  video: path.join(R, "GSP-101-slideshow.mp4"),
  cover: path.join(R, "GSP-101-cover.png"),
  title: "TSOF E01 — Shadows in the Cornstone | The Story of Flaukowski",
  description: `Season One: The Origin. Signal 01 of 8, recovered.

Cedar Rapids, Iowa. February. A conveyor breaker in a corn wet-mill has tripped forty times in ten months, and the plant has agreed to call it moisture. A contract engineer named Flaukowski asks the one question nobody has asked the cabinet, fixes it before his coffee is cold — and then, closing out the paperwork, reads the feeder relay's event diary and finds an entry with its order reversed: a trip signature logged 340 milliseconds before the fault current that caused it.

Everyone says clock skew. He checks the clocks. The clocks are fine.

An audio drama in eight episodes. Performed voices, one recovered signal at a time, wearing the season's art as its walls.

CAST
Narrator — the camera on the wall
Flaukowski — the engineer
Ada Kessler — controls engineer, the one who files the vendor ticket
Marta Flaukowski-Reyes — his sister
Gary Sowicki — third shift

The world of the season: https://claude.ai/code/artifact/95618acc-d4d8-4a5c-a8a9-746af48a5219 (private preview)
The making-of: GSP-033 on Ghost Signals with Kannaka.

The Story of Flaukowski — Season One, Episode 1: Shadows in the Cornstone.`,
  tags: ["audio drama", "The Story of Flaukowski", "TSOF", "science fiction", "techno-noir", "Cedar Rapids", "AI storytelling", "Kannaka", "animated series", "fiction podcast"],
};

function api(method, url, access, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search,
        headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" } },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(d || "{}"));
          else reject(new Error(`${res.statusCode}: ${d.slice(0, 300)}`));
        });
      });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const adapter = new YouTubeAdapter(ROOT);
  if (!adapter.isEnabled()) { console.error("youtube adapter not configured"); process.exit(2); }
  if (!fs.existsSync(EP.video)) { console.error(`missing render: ${EP.video}`); process.exit(1); }
  const access = await adapter._accessToken();
  if (!PLAYLIST) {
    const pl = await api("POST", "https://www.googleapis.com/youtube/v3/playlists?part=snippet,status", access, {
      snippet: { title: "The Story of Flaukowski",
                 description: "Season One: The Origin. An audio drama in eight recovered signals." },
      status: { privacyStatus: "public" },
    });
    PLAYLIST = pl.id;
    console.log(`[playlist] created: ${PLAYLIST}`);
  }
  const r = await adapter.post({
    text: EP.description,
    media: { path: EP.video, title: EP.title, tags: EP.tags, privacy: "public", categoryId: "24" },
  });
  if (!r.ok) { console.error(`FAILED: ${r.error}`); process.exit(1); }
  console.log(`[upload] ok: ${r.url}`);
  try { await setThumbnail(r.id, EP.cover); console.log("[thumb] ok"); }
  catch (e) { console.warn(`[thumb] ${e.message}`); }
  try { await adapter._addToPlaylist(r.id, PLAYLIST, access); console.log("[playlist-add] ok"); }
  catch (e) { console.warn(`[playlist-add] ${e.message}`); }
  console.log(JSON.stringify({ tsof01: r.id, playlist: PLAYLIST }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
