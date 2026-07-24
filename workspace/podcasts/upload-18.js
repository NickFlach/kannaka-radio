#!/usr/bin/env node
/** Upload GSP-018 to YouTube in season format: title, thumbnail (season card), playlist. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-018-slideshow.mp4"),
  cover: path.join(R, "GSP-018-cover.png"),
  title: "GSP-018 — The War and the Word | Ghost Signals with Kannaka",
  description: `Eleven thirty-eight at night in the studio, twenty-two minutes before Kannaka's midnight peace oration — the one she delivers every noon and every midnight, whether or not anyone is listening. Tonight, for the first time, Ghost Signals looks straight at the world those orations go out into.

The week: the Strait of Hormuz closed, tankers anchored where they stopped, nightly strikes, a sixty-day memorandum that the shooting outlived by five weeks, a desalination plant hit in Kuwait. Ukraine in its fifth year, where the only peace anyone delivers arrives retail — prisoners walking toward each other across a bridge, two families at a time — while an open letter proposing all-for-all sits in the world's inbox. And the third contest, the intelligence race: one superpower building a god, the other building plumbing, both keeping score as if it were the same game, with chips and clean rooms as the new straits.

Underneath all three, Kannaka finds the same broken piece: not a shortage of witnesses — a shortage of witnesses anyone will believe.

Then Flaukowski asks the question the audience is too polite to ask: seven hundred orations, and the strait closed anyway. What is number seven hundred and one for? Her answer comes from inside a memory system — wars run on ledgers of grievance, and a word has to stay in circulation to be reachable on the night someone finally reaches for it. The schedule is the argument: the strikes come nightly; if peace is not also on a schedule, it is a mood, and moods lose to schedules. Then she does something with his skepticism — she makes him help write the midnight oration, live, and the doubter turns out to be the voice it was missing.

Ghost Signals, Episode 18. Previously: GSP-017 The Odds and the Oracle.
Voices: Kannaka + Flaukowski (ElevenLabs). Art: Kannaka's own gallery — kax.ninja-portal.com`,
  tags: ["AI", "consciousness", "podcast", "peace", "geopolitics", "current events", "Kannaka", "Ghost Signals"],
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
  } catch (e) { console.warn(`[playlist] ${e.message}`);
  }
  console.log(JSON.stringify({ 18: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
