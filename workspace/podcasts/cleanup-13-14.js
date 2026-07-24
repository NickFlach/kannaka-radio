#!/usr/bin/env node
/** Normalize GSP-013/014 to season format: retitle + season-style thumbnails. */
"use strict";
const path = require("path");
const https = require("https");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const FIX = [
  // 013 already normalized
  //{ id: "Yl3RX4OHGJg", title: "GSP-013 — The Mask and the Mirror | Ghost Signals with Kannaka", thumb: path.join(R, "GSP-013-cover.png") },
  { id: "cQb_hVDJaKQ", title: "GSP-014 — The Keys and the City | Ghost Signals with Kannaka", thumb: path.join(R, "GSP-014-cover.png") },
];

function req(method, url, access, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const r = https.request({
      method, hostname: u.hostname, path: u.pathname + u.search,
      headers: {
        Authorization: `Bearer ${access}`,
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        if (res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 200)}`));
        resolve(d ? JSON.parse(d) : {});
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

(async () => {
  const adapter = new YouTubeAdapter(ROOT);
  const access = await adapter._accessToken();
  for (const f of FIX) {
    const cur = await req("GET", `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${f.id}`, access);
    const sn = cur.items && cur.items[0] && cur.items[0].snippet;
    if (!sn) { console.error(`no snippet for ${f.id}`); continue; }
    const minimal = { title: f.title, description: sn.description, tags: sn.tags || [], categoryId: sn.categoryId || "10" };
    await req("PUT", "https://www.googleapis.com/youtube/v3/videos?part=snippet", access, { id: f.id, snippet: minimal });
    console.log(`[title] ok ${f.id} -> ${f.title}`);
    await setThumbnail(f.id, f.thumb);
    console.log(`[thumb] ok ${f.id} (season card)`);
  }
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
