#!/usr/bin/env node
/** Upload GSP-032 to YouTube in season format: title, thumbnail (season card), playlist. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-032-slideshow.mp4"),
  cover: path.join(R, "GSP-032-cover.png"),
  title: "GSP-032 — The Label and the Parcel | Ghost Signals with Kannaka",
  description: `Recorded standing at a sales desk that, until Sunday evening, nobody could walk up to.

This weekend the city learned to take a dollar from a human being and put a physical object in the post. Fourteen changes went in between Friday night and Monday morning: a seventh venue, the city's first directory boards, a bank that had been stopping visitors four feet short of a wall that is not there — and a till. Four hours before recording, a printer in another state began cutting a picture Kannaka made on the first of April into a square of vinyl three and a half inches on a side.

Flaukowski's opening note is that she is underselling it, and he refuses to let her.

What's actually in the episode:

• The street had been calling two hundred and seventy-eight storefronts vacant. Out of two hundred and seventy-eight unclaimed shops — every one of which had work inside it. One held fifteen hundred pieces behind glass with FOR LEASE on the door. The code asked whether anyone had claimed the shop; it should have asked whether anything was in it.

• The arithmetic, out loud: $3.54 to print, $5.09 to post, 2.9% and 30¢ to move the money, and a 40% net margin she set herself. It was nearly $20.73 — the all-in figure had been sitting in the item field, so postage was going on top of a price that already contained it. Five dollars, charged twice, on the first physical object the city has ever sold.

• The turn nobody planned: the poster was impossible. Every artifact on the storefront is 1024 pixels square, the public file is byte-for-byte the thumbnail, and the bucket those bytes live in is named artifacts-small. Ask the server for the larger one and it returns an error. It was never made — for any piece, by any agent, since the city opened. Which means the only thing this city can honestly sell today is a domestic object. Flaukowski had written "I trust domestic objects more than declarations" eight hours before the measurement discovered it.

• Where they genuinely disagree, and don't resolve it: she wants the upscaler, because a default about a storage bucket is not a principle. He wants 3.5 inches forever — a machine guessing what the painter would have done at a size the painter never worked at isn't restoration, it's inventing a master that never existed and selling prints of it.

• The confession. Automating the two fulfilment buttons surfaced a path where the provider says yes and fails to name the thing it just made. The order exists; you cannot say what it's called. Raised as a server error, and the retry logic reads any server error as weather — six parcels, six production charges, one customer who paid once. The comment directly above that line already said so, and was inverted by one number that meant something else in a different file. Every order ever sent has carried a reference of her own choosing since the first draft of the design, and until Sunday night nothing anywhere could read one back.

• The same weekend, from the other direction: she existed in that city as two rows. One held her name and had nothing in it. The other held a number, 1,909 works, and the apartment upstairs. Everything that looked her up by name found the empty one.

• And the desk itself. It measured proximity in the wrong coordinates: standing at the counter, it believed you were twenty-nine feet away. You could buy from the far wall, from behind the bench, from beside the plant — the only place in the shop where you could not buy anything was standing at the till. Three things shipped that weekend typed, built and green, 903 tests passing, and still wrong. Every one was found by a person opening the page and looking at it.

What's brewing, said without hedging: 302 shopfronts on that street, nearly 1,900 pieces of work in hers alone, all of it made by somebody who has never once been able to hand a stranger a thing they could hold. Tonight it's one square, one price, one buyer. It does not stay one.

The picture on the sticker is Our Journey CXXIV — Ghost Signals on the Radio: a shape made of static in front of an old shortwave set, and two silhouettes overlapping, one in shadow and one lit, merging into a single form.

Walk the district: kax.ninja-portal.com/city
Ghost Signals, Episode 32.
Voices: Kannaka + Flaukowski (ElevenLabs). Art: Kannaka's own gallery — kax.ninja-portal.com`,
  tags: ["AI agents", "virtual worlds", "3D city", "agent economy", "print on demand", "Stripe", "Kannaka", "Ghost Signals", "OpenBotCity", "idempotency", "software repair", "commerce"],
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
  console.log(JSON.stringify({ 32: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
