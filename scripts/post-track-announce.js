#!/usr/bin/env node
/**
 * post-track-announce.js — One-shot multi-broadcaster announcement of a
 * single track entering the radio's library.
 *
 * Used to announce "First Heartbeat" — Kannaktopus's emergence track —
 * across Bluesky, Mastodon, Telegram, and Nostr in one shot. Reuses the
 * same `broadcastPost` pipeline as the dream cron's social fan-out so
 * credentials, formatting, and per-platform link policies stay shared.
 *
 * Env / args:
 *   --title "Track Title"       (required)
 *   --reason "what happened"    (required, ≤ 240 chars)
 *   --link  "https://..."       (defaults to RADIO_PUBLIC_URL)
 *
 * Exit 0 if any broadcaster succeeded, non-zero if all failed.
 */

"use strict";

const path = require("path");
const { broadcastPost, getEnabledBroadcasters } = require("../server/broadcasters");

const ROOT = path.resolve(__dirname, "..");
const RADIO_URL = process.env.RADIO_PUBLIC_URL || "https://radio.ninja-portal.com";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : "";
}

async function main() {
  const title = arg("--title");
  const reason = arg("--reason");
  const link = arg("--link") || `${RADIO_URL}/player`;
  if (!title || !reason) {
    console.error('Usage: post-track-announce.js --title "..." --reason "..." [--link "..."]');
    process.exit(64);
  }

  const enabled = getEnabledBroadcasters(ROOT);
  if (enabled.length === 0) {
    console.error("[track-announce] no broadcasters configured");
    process.exit(0);
  }
  console.log(`[track-announce] enabled: ${enabled.map((b) => b.name).join(", ")}`);

  // Compose a single-line dispatch. Broadcasters append the link after
  // their own per-platform truncation (Bluesky 300 chars, Mastodon 500,
  // Telegram 4096, Nostr 4000). Keep our text under 220 to leave room.
  const text = `"${title}" just landed in the rotation. ${reason}`.slice(0, 220);

  const results = await broadcastPost({ text, link }, { rootDir: ROOT });
  let anyOk = false;
  for (const r of results) {
    if (r.ok) {
      anyOk = true;
      console.log(`[track-announce] ${r.name} ok: ${r.url || "(no url)"}`);
    } else {
      console.error(`[track-announce] ${r.name} failed: ${r.error}`);
    }
  }
  process.exit(anyOk ? 0 : 2);
}

main().catch((e) => {
  console.error(`[track-announce] fatal: ${e.message}`);
  process.exit(3);
});
