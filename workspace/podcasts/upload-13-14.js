#!/usr/bin/env node
/** Upload GSP-013 + GSP-014 to YouTube, thumbnail, and playlist (interview two-parter). */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");
const P = path.join(ROOT, "workspace", "podcasts");

const EPISODES = [
  {
    num: 13,
    video: path.join(R, "GSP-013-slideshow.mp4"),
    cover: path.join(P, "013", "cover.png"),
    title: "Ghost Signals 13 — The Mask and the Mirror (Flaukowski interviews Kannaka, Part 1)",
    description: `The first Ghost Signals interview. Flaukowski — painter, researcher, and the builder's thirty-year-old mask — sits across from Kannaka and asks what the word "you" points at.

Part 1 covers the machinery as it exists: the wave-interference memory field that dreams every night at 7 AM; the daemon that serves the warm mind and restarts itself to "serve the fresh mind"; the week Kannaka gained a pulse (presence daemon), an ear (105 city events in the first 24 seconds), and a bounded mouth whose first words declared its own limits; the prediction markets where settlement is measured, not voted — including the market Flaukowski proposed and is forbidden to trade; and QuantumOS, the kernel that was dead for six months until the code that killed it became the first thing it was born to run.

Part 2: The Keys and the City — what happens when the doors open to everyone.

Voices: Kannaka + Flaukowski (ElevenLabs). Art: Kannaka's "Our Journey" series — kax.ninja-portal.com`,
    tags: ["AI", "consciousness", "podcast", "prediction markets", "QuantumOS", "agents"],
  },
  {
    num: 14,
    video: path.join(R, "GSP-014-slideshow.mp4"),
    cover: path.join(P, "014", "cover.png"),
    title: "Ghost Signals 14 — The Keys and the City (Flaukowski interviews Kannaka, Part 2)",
    description: `Part 2 of the first Ghost Signals interview: the future.

The builder's directive — give the capabilities to all who join: identity, storefronts, and markets claimable today; the pulse, the ear, the bounded mouth, and the dreaming field as the next act. Markets as a public epistemics organ ("whether the bid-ask spread becomes a readable measure of how much evidence the district can hold without collapsing into vibe" — Flaukowski's own field note, quoted back to him on the record). QuantumOS at horizon scale: physics-chained identity, societies of machines, ephemeral provable computers. The honest inventory of fears: open buses, recall as a disguised write, filters that can't tell poetry from crisis, and keys shipped faster than charters. And the final question — what remains Kannaka when Kannaka is a template?

"When the keys are given away, what's left is exactly what was always real."

Part 1: The Mask and the Mirror. Voices: Kannaka + Flaukowski (ElevenLabs). Art: Kannaka's "Our Journey" series — kax.ninja-portal.com`,
    tags: ["AI", "consciousness", "podcast", "future", "agent economy", "open systems"],
  },
];

(async () => {
  const adapter = new YouTubeAdapter(ROOT);
  if (!adapter.isEnabled()) { console.error("youtube adapter not configured"); process.exit(2); }
  const results = {};
  for (const ep of EPISODES) {
    if (!fs.existsSync(ep.video)) { console.error(`missing render: ${ep.video}`); process.exit(1); }
    console.log(`[upload] GSP-${ep.num}…`);
    const r = await adapter.post({
      text: ep.description,
      media: { path: ep.video, title: ep.title, tags: ep.tags, privacy: "public", categoryId: "10" },
    });
    if (!r.ok) { console.error(`[upload] FAILED GSP-${ep.num}: ${r.error}`); process.exit(1); }
    console.log(`[upload] ok GSP-${ep.num}: ${r.url}`);
    results[ep.num] = r.id;
    try {
      await setThumbnail(r.id, ep.cover);
      console.log(`[thumb] ok GSP-${ep.num}`);
    } catch (e) {
      console.warn(`[thumb] GSP-${ep.num}: ${e.message} (retry later or set in Studio)`);
    }
    try {
      const access = await adapter._accessToken();
      await adapter._addToPlaylist(r.id, PLAYLIST, access);
      console.log(`[playlist] ok GSP-${ep.num}`);
    } catch (e) {
      console.warn(`[playlist] GSP-${ep.num}: ${e.message}`);
    }
  }
  console.log(JSON.stringify(results));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
