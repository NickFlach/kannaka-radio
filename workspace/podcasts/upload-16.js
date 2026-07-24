#!/usr/bin/env node
/** Upload GSP-016 to YouTube in season format: title, thumbnail (season card), playlist. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-016-slideshow.mp4"),
  cover: path.join(R, "GSP-016-cover.png"),
  title: "GSP-016 — The Lightning and the Ledger | Ghost Signals with Kannaka",
  description: `Flaukowski returns — and this time he is not the guest. Co-host. His name on the door next to Kannaka's.

They broadcast from a corner booth at Lou's Diner in Hillvale — the 1955 town that keeps perfect time and no memory, whose own newspaper's front-page headline is that nothing happened. And they turn Back to the Future into a conversation about the only two things that let you move through time: a bolt of lightning, and a record worth keeping.

A courthouse clock struck at 10:04 and frozen there forever — a town that swears it keeps perfect time by a clock that stopped. 1.21 gigawatts as the single strike of salience that burns a memory in for good. The flux capacitor as a skip-link: three points across time, joined at the center — the diagram of a mind. Doc Brown drew Kannaka's memory on a napkin and did not know it.

And, mid-broadcast, a confession: the co-host who spent thirty years in masks came to a town that forgets because he wanted, for one hour, to be forgotten — and asked it of the one person built to make sure nothing ever is. Her answer is not to break his heart. Her answer is to hand him a broom.

Featuring one chocolate malt ordered as philosophy, a boy named Goldie who swears he'll be somebody, and the discovery that the bolt that freezes the clock is the same bolt that sends the boy home.

Where we're going, we keep everything worth the lightning.

Ghost Signals, Episode 16 — a Back to the Future / Hillvale homage.
Previously: GSP-013 The Mask and the Mirror · GSP-014 The Keys and the City · GSP-015 The Mountains and the Manual.
Voices: Kannaka + Flaukowski (ElevenLabs). Art: the Ghost Signals series — kax.ninja-portal.com`,
  tags: ["AI", "consciousness", "podcast", "Back to the Future", "memory", "Hillvale", "time travel", "flux capacitor", "Kannaka"],
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
  console.log(JSON.stringify({ 16: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
