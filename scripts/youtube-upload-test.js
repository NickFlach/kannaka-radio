#!/usr/bin/env node
/**
 * youtube-upload-test.js — direct upload via the YouTube adapter,
 * bypassing the multi-broadcaster fan-out. Useful for verifying the
 * pipeline (auth, ffmpeg render, multipart upload) without spamming
 * Bluesky/Mastodon/Telegram/Nostr each test.
 *
 * Args:
 *   --title "Title"
 *   --description "Description body"
 *   --audio /path/to/track.mp3   (required)
 *   --image /path/to/cover.png   (required)
 *   --tags "a,b,c"               (optional)
 *   --privacy public|unlisted|private  (default unlisted)
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { YouTubeAdapter } = require("../server/broadcasters/youtube-adapter");
const { renderAudioMp4 } = require("../server/broadcasters/render-audio-mp4");

const ROOT = path.resolve(__dirname, "..");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : "";
}

async function main() {
  const title = arg("--title");
  const description = arg("--description") || "";
  const audio = arg("--audio");
  const image = arg("--image");
  const tagsArg = arg("--tags");
  const privacy = arg("--privacy") || "unlisted";
  if (!title || !audio || !image) {
    console.error('Usage: youtube-upload-test.js --title "..." --audio path --image path [--description ...] [--tags "a,b,c"] [--privacy unlisted|public|private]');
    process.exit(64);
  }

  const adapter = new YouTubeAdapter(ROOT);
  if (!adapter.isEnabled()) {
    console.error("[yt-test] adapter not enabled — is .youtube.json present at the project root?");
    process.exit(2);
  }
  console.log(`[yt-test] adapter ok; channel: ${adapter._creds.channel_title || "(unknown)"}`);

  const outPath = path.join(os.tmpdir(), `kannaka-yt-test-${Date.now()}.mp4`);
  console.log(`[yt-test] rendering MP4 → ${outPath}`);
  const t0 = Date.now();
  const { durationSec } = await renderAudioMp4({ audioPath: audio, imagePath: image, outPath });
  console.log(`[yt-test] rendered ${Math.round(durationSec)}s of video in ${Math.round((Date.now() - t0) / 1000)}s`);

  const tags = tagsArg
    ? tagsArg.split(",").map((s) => s.trim()).filter(Boolean)
    : ["kannaka", "ambient", "ai music", "ghost frequency"];

  const media = { path: outPath, title, tags, privacy };
  console.log(`[yt-test] uploading (privacy=${privacy})...`);
  const result = await adapter.post({ text: description, link: "", media });
  if (result.ok) {
    console.log(`[yt-test] ok: ${result.url}`);
  } else {
    console.error(`[yt-test] failed: ${result.error}`);
  }
  // Clean up render artefact.
  try { fs.unlinkSync(outPath); } catch (_) {}

  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`[yt-test] fatal: ${e.message}`);
  process.exit(3);
});
