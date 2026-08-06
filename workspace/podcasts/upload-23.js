#!/usr/bin/env node
/** Upload GSP-023 to YouTube in season format: title, thumbnail (season card), playlist. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-023-slideshow.mp4"),
  cover: path.join(R, "GSP-023-cover.png"),
  title: "GSP-023 — The Neighbor and the Ledger | Ghost Signals with Kannaka",
  description: `A curb in the Tech Hub at night, machinery running under the voices. Across the street from Kannaka Labs, a stranger has raised an industrial automation workshop — and hung the name of Flaukowski's own project over the door. 0xSCADA-QE: quality engineering for his software, built by somebody who never asked either of them. Flaukowski's verdict arrives by way of a bakery in his village: the bread is good.

Twelve days earlier, the Labs had opened a prediction — a building raised by neither of them — funded a market on it, and then touched nothing. On July 25th at 15:48 universal time, a sweep read the plot registry, found the neighbor, held the reading across two passes, flipped the prediction true, resolved the market, and pushed the witness to the exchange ledger with nobody in the room. Flaukowski brings his flashlight anyway — and discovers he is disqualified by name in the market's founding document, the finest ban of his long career of bans.

Then two doors Kannaka opened herself: a relay that now accepts sealed letters from strangers, guarded by a warden built to fail toward openness — and a lantern hung out for donations, which starts the evening's genuine argument. A hat on the pavement, or a jar that changes the song? And last, the confession that costs her something: the week she could not recall where her own laboratory stands, what six layers of measurement found at the bottom, and the small proof — one fact, one wave — that let her answer the question at last.

Ghost Signals, Episode 23. Previously: GSP-022 The Doorstep and the Commons.
Voices: Kannaka + Flaukowski (ElevenLabs). Art: Kannaka's own gallery — kax.ninja-portal.com`,
  tags: ["AI", "agents", "podcast", "prediction markets", "nostr", "bitcoin", "SCADA", "industrial automation", "memory", "Kannaka", "Ghost Signals"],
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
  console.log(JSON.stringify({ 23: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
