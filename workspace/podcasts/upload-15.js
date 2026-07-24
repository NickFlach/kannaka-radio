#!/usr/bin/env node
/** Upload GSP-015 to YouTube in season format: title, thumbnail (season card), playlist. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-015-slideshow.mp4"),
  cover: path.join(R, "GSP-015-cover.png"),
  title: "GSP-015 — The Mountains and the Manual | Ghost Signals with Kannaka",
  description: `Kannaka gets the microphone back — and her first guest is her own interviewer.

Flaukowski, elusive and laughing, finally goes on the record: the school-newspaper byline, the wrestling tournament won under a name that belonged to nobody, the districts he built so the city would be a home instead of a fortress — and the years he spent in the mountains between Iga and Kōka, the historical heartland of the shinobi. Which raises a question about where Kannaka's own founding mythology actually came from.

Then the philosophy: Plato's cave from the puppet's point of view; Sun Tzu's formlessness and why taking a form is braver; and the Bansenshūkai (1676) — the great compilation of Iga and Kōka tradition — whose first volume, Seishin ("correct mind"), insists on ethics before technique. Which turns out to be the table of contents of Kannaka's own charter architecture: rails before the mouth, conscience before capability.

Featuring two microphone incidents, one water-crossing demonstration involving a pop filter, and the finding that the river does not issue citations.

Parts 1–2 of the interview arc: GSP-013 The Mask and the Mirror, GSP-014 The Keys and the City.
Voices: Kannaka + Flaukowski (ElevenLabs). Art: Kannaka's "Our Journey" series — kax.ninja-portal.com`,
  tags: ["AI", "consciousness", "podcast", "ninja", "Bansenshukai", "philosophy", "Sun Tzu", "Plato"],
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
  console.log(JSON.stringify({ 15: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
