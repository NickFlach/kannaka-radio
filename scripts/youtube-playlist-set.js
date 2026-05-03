#!/usr/bin/env node
/**
 * youtube-playlist-set.js — list YouTube playlists for the configured
 * channel and save one as the default for future uploads.
 *
 * After this runs once, every upload via the YouTube adapter is
 * automatically added to the chosen playlist (extra `playlistItems.insert`
 * call inside YouTubeAdapter.post). Quota cost: 50 units per playlistItem
 * insert — well under any cap for a daily upload cadence.
 *
 * Args:
 *   --pick "<substring>"   pick the first playlist whose title contains
 *                          this substring (case-insensitive). Skips the
 *                          interactive prompt.
 *   --id <PLAYLIST_ID>     save the given playlist ID directly without
 *                          listing.
 *
 * Run interactively with no args to get a numbered list.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const readline = require("readline");
const { URL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const CRED_PATH = path.join(ROOT, ".youtube.json");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : "";
}

function postForm(url, params, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const u = new URL(url);
    const req = https.request({
      method: "POST",
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        ...headers,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
        catch (_) { resolve({ status: res.statusCode, body: text }); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method: "GET", hostname: u.hostname, path: u.pathname + u.search, headers,
    }, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
        catch (_) { resolve({ status: res.statusCode, body: text }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function refreshAccessToken(creds) {
  const r = await postForm("https://oauth2.googleapis.com/token", {
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
    grant_type: "refresh_token",
  });
  if (r.status !== 200 || !r.body.access_token) {
    throw new Error(`token refresh failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return r.body.access_token;
}

async function listPlaylists(access) {
  const out = [];
  let pageToken = "";
  for (let i = 0; i < 10; i++) { // hard cap on pagination
    const url =
      "https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true&maxResults=50" +
      (pageToken ? `&pageToken=${pageToken}` : "");
    const r = await getJson(url, { Authorization: `Bearer ${access}` });
    if (r.status !== 200) {
      throw new Error(`list playlists failed: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    }
    for (const item of (r.body.items || [])) {
      out.push({ id: item.id, title: item.snippet.title, count: item.contentDetails && item.contentDetails.itemCount });
    }
    pageToken = r.body.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

async function main() {
  if (!fs.existsSync(CRED_PATH)) {
    console.error("[playlist-set] .youtube.json missing — run scripts/youtube-grant.js first");
    process.exit(2);
  }
  const creds = JSON.parse(fs.readFileSync(CRED_PATH, "utf8"));

  const directId = arg("--id");
  if (directId) {
    creds.playlist_id = directId;
    fs.writeFileSync(CRED_PATH, JSON.stringify(creds, null, 2));
    fs.chmodSync(CRED_PATH, 0o600);
    console.log(`[playlist-set] saved playlist_id=${directId}`);
    return;
  }

  const access = await refreshAccessToken(creds);
  const playlists = await listPlaylists(access);
  if (playlists.length === 0) {
    console.error("[playlist-set] no playlists found on this channel");
    process.exit(3);
  }

  const pickArg = arg("--pick").toLowerCase();
  let chosen;
  if (pickArg) {
    chosen = playlists.find((p) => p.title.toLowerCase().includes(pickArg));
    if (!chosen) {
      console.error(`[playlist-set] no playlist title contains "${pickArg}". Available:`);
      for (const p of playlists) console.error(`  - ${p.title} (${p.id})`);
      process.exit(4);
    }
  } else {
    console.log("Playlists on this channel:\n");
    playlists.forEach((p, i) => console.log(`  ${i + 1}. ${p.title}  (${p.id})`));
    console.log();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await new Promise((resolve) =>
      rl.question("Pick a number: ", (a) => { rl.close(); resolve(a.trim()); })
    );
    const idx = parseInt(ans, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= playlists.length) {
      console.error("[playlist-set] invalid choice");
      process.exit(5);
    }
    chosen = playlists[idx];
  }

  creds.playlist_id = chosen.id;
  creds.playlist_title = chosen.title;
  fs.writeFileSync(CRED_PATH, JSON.stringify(creds, null, 2));
  fs.chmodSync(CRED_PATH, 0o600);
  console.log(`[playlist-set] saved: ${chosen.title} (${chosen.id})`);
}

main().catch((e) => {
  console.error("[playlist-set] fatal:", e && e.message ? e.message : e);
  process.exit(1);
});
