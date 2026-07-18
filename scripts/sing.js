#!/usr/bin/env node
/**
 * sing.js — render a Kannaka song via sunoapi.org direct (ADR-0013 incr. 2).
 *
 * The consolidated form of the per-album suno_*.sh scripts and the
 * 2026-07-18 "Keep the Pulse" session learnings:
 *   - custom mode: title ≤100, style ≤1000, LYRICS ride in `prompt` ≤3000
 *     (Suno [Verse]/[Chorus]/[Bridge] tags) — no OBC filter, no 500-char cap
 *   - poll record-info until SUCCESS (PENDING→TEXT_SUCCESS→FIRST_SUCCESS→SUCCESS)
 *   - download BOTH variants with a browser User-Agent (the CDN 403s
 *     default library UAs)
 *
 * Usage:
 *   node scripts/sing.js --title "Keep the Pulse" --style "Slow piano ballad, 72 BPM..." \
 *        --lyrics path/to/lyrics.txt [--out dir] [--instrumental] [--model V4_5PLUS]
 *
 * Key: $SUNO_API_KEY, or first line of $SUNO_API_KEY_FILE
 *      (default C:/Users/nickf/Downloads/suno_api.txt, /home/opc/.kannaka-suno.key on Oracle).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const API = "api.sunoapi.org";

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

function fail(msg) {
  console.error("sing.js: " + msg);
  process.exit(1);
}

function apiKey() {
  if (process.env.SUNO_API_KEY) return process.env.SUNO_API_KEY.trim();
  const candidates = [
    process.env.SUNO_API_KEY_FILE,
    "C:/Users/nickf/Downloads/suno_api.txt",
    "/home/opc/.kannaka-suno.key",
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const k = fs.readFileSync(p, "utf8").trim().split(/\s+/)[0];
      if (k) return k;
    } catch {}
  }
  fail("no Suno key — set SUNO_API_KEY or SUNO_API_KEY_FILE");
}

function req(method, host, pathName, headers, body) {
  return new Promise((resolve, reject) => {
    const r = https.request({ method, hostname: host, path: pathName, headers, timeout: 60000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("timeout")));
    if (body) r.write(body);
    r.end();
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https
      .get({ hostname: u.hostname, path: u.pathname + u.search, headers: { "User-Agent": UA } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return download(res.headers.location, dest).then(resolve, reject);
        }
        if (res.statusCode !== 200) return reject(new Error("download HTTP " + res.statusCode));
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on("finish", () => out.close(() => resolve(dest)));
      })
      .on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const title = arg("title") || fail("--title required");
  const styleArg = arg("style") || fail("--style required");
  const style = fs.existsSync(styleArg) ? fs.readFileSync(styleArg, "utf8").trim() : styleArg;
  const lyricsArg = arg("lyrics");
  const instrumental = !!arg("instrumental", false);
  if (!instrumental && !lyricsArg) fail("--lyrics <file|text> required (or --instrumental)");
  const lyrics = lyricsArg
    ? fs.existsSync(lyricsArg)
      ? fs.readFileSync(lyricsArg, "utf8")
      : lyricsArg
    : "";
  const outDir = arg("out", path.join(process.cwd(), "sing-out"));
  const model = arg("model", "V4_5PLUS");
  fs.mkdirSync(outDir, { recursive: true });

  const key = apiKey();
  const payload = JSON.stringify({
    customMode: true,
    instrumental,
    model,
    title: String(title).slice(0, 100),
    style: style.slice(0, 1000),
    prompt: (instrumental ? style : lyrics).slice(0, 3000),
    callBackUrl: "https://radio.ninja-portal.com/api/suno-callback",
  });

  console.log(`[sing] submitting "${title}" (${model}, lyrics ${lyrics.length} chars)`);
  const init = await req("POST", API, "/api/v1/generate", {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "User-Agent": UA,
  }, payload);
  let taskId;
  try {
    taskId = JSON.parse(init.body).data.taskId;
  } catch {}
  if (!taskId) fail(`submit failed (HTTP ${init.status}): ${init.body.slice(0, 300)}`);
  console.log(`[sing] taskId=${taskId} — polling`);

  for (let i = 1; i <= 50; i++) {
    await sleep(12000);
    const poll = await req("GET", API, `/api/v1/generate/record-info?taskId=${taskId}`, {
      Authorization: `Bearer ${key}`,
      "User-Agent": UA,
    });
    let data;
    try {
      data = JSON.parse(poll.body).data;
    } catch {
      continue;
    }
    const status = (data && data.status) || "?";
    console.log(`[sing] ${i * 12}s: ${status}`);
    if (status === "SUCCESS") {
      const tracks = (data.response && data.response.sunoData) || [];
      const files = [];
      let v = 1;
      for (const t of tracks) {
        const url = t.audioUrl || t.streamAudioUrl;
        if (!url) continue;
        const dest = path.join(outDir, `${title.replace(/[^\w\- ]+/g, "").trim()}_v${v}.mp3`);
        await download(url, dest);
        console.log(`[sing] saved v${v}: ${dest} (${t.duration || "?"}s)`);
        files.push({ file: dest, duration: t.duration, url });
        v++;
      }
      if (!files.length) fail("SUCCESS but no audio URLs");
      console.log(JSON.stringify({ ok: true, taskId, title, files }, null, 2));
      return;
    }
    if (/FAILED|ERROR|SENSITIVE/.test(status)) fail(`generation failed: ${poll.body.slice(0, 300)}`);
  }
  fail("timeout after 10 minutes");
})().catch((e) => fail(e.message));
