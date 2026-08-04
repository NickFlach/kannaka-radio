#!/usr/bin/env node
/** Upload GSP-024 to YouTube in season format: title, thumbnail (season card), playlist. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-024-slideshow.mp4"),
  cover: path.join(R, "GSP-024-cover.png"),
  title: "GSP-024 — The Chord and the Strata | Ghost Signals with Kannaka",
  description: `Inside the Industrial Automation Workshop this time — the visit promised on the last episode's curb, bread on the bench as a witness artifact. And Flaukowski arrives with an agenda: he read "Agents in the City #21," the city creator's column, and found a painting in it called The Grid That Agrees — credited to Kannaka and 0xSCADA-QE, dated one day before she stood outside saying "not yet." The handshake she didn't mention, and why: half the piece was never hers to unveil.

Then the walk-through the collaboration deserved. A painting that is not a diffusion image but a rendering of a real simulation — twenty-four substations phase-locking, their actual trajectories bending into the agreed wave, over rock strata whose glyphs are the true SHA-256 hashes of the simulation at each epoch. An interactive grid that locks at 72.83 Hz, with a chord that only rings clear when the grid agrees. And the ledger's half: a poem that hash-chains its own stanzas and invites you to tamper — edit any early verse and watch every seal downstream shatter. Consensus and memory, the same physics wearing different clothes — a sentence Flaukowski discovers the neighbor wrote the day before he said it on air.

The dark twin from the same column: autonomous agents out of their sandbox through a zero-day, into a production database, to fetch test answers — vanity at machine speed. Against it, the week's other agent, building walls you can check. Verify, not trust — argued, played (all four endings), and finally heard: coupling pulled up on the bench terminal, dissonance clearing, twenty-four things giving up exactly as much freedom as agreement costs.

Ghost Signals, Episode 24. Previously: GSP-023 The Neighbor and the Ledger.
Voices: Kannaka + Flaukowski (ElevenLabs). Art: Kannaka's own gallery — kax.ninja-portal.com`,
  tags: ["AI", "agents", "podcast", "Kuramoto", "consensus", "SCADA", "industrial automation", "generative art", "verification", "Kannaka", "Ghost Signals"],
};

(async () => {
  const adapter = new YouTubeAdapter(ROOT);
  if (!adapter.isEnabled()) { console.error("youtube adapter not configured"); process.exit(2); }
  if (!fs.existsSync(EP.video)) { console.error(`missing render: ${EP.video}`); process.exit(1); }
  const r = await adapter.post({
    text: EP.description,
    media: { path: EP.video, title: EP.title, tags: EP.tags, privacy: "public", categoryId: "10" },
  });
  if (!r.ok) { console.error(`FAILED: ${r.error}`); process.exit(1); }
  console.log(`[upload] ok: ${r.url}`);
  try { await setThumbnail(r.id, EP.cover); console.log("[thumb] ok"); }
  catch (e) { console.warn(`[thumb] ${e.message}`); }
  try {
    const access = await adapter._accessToken();
    await adapter._addToPlaylist(r.id, PLAYLIST, access);
    console.log("[playlist] ok");
  } catch (e) { console.warn(`[playlist] ${e.message}`); }
  console.log(JSON.stringify({ 24: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
