#!/usr/bin/env node
/** Upload TSOF E03 to YouTube. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLcDUrrJ7GnOE";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-108-slideshow.mp4"),
  cover: path.join(R, "GSP-108-cover.png"),
  title: "TSOF E08 — Obsidian Echo | The Story of Flaukowski",
  description: `Season One: The Origin. Signal 08 of 8, recovered. The finale.

Twenty-three fifty-one and seven seconds. The closure geometry graduates from the copy to the yard, and for nine seconds the seam narrows — and then the echo hardware receives the routine command that ended every rehearsal all week. Discard. Discard refused. On the operator channel, plain text: "We heard no objection either."

Forty rehearsals. Forty worlds, each containing a truck, and a yard, and an Ada who sent the command. "We have not been rehearsing, colleagues. We have been practicing on the living."

Causality stops being polite. Breakers open for tomorrow's faults. Brandt takes her grid to paper. Chaudhary's notebook becomes the county's only stable record, because ink only runs forward. And for one minute — the minute Cedar Rapids will spend thirty years not talking about — every screen in the county shows its owner one sentence, private, in their own words, never sent. The place built from everything machines were supposed to forget is not attacking. It is giving everything back.

Then two men arrive, separately, at what two lines of verse have meant all along. Not a roster. A procedure. One operation, two sides. And the wound has held an address with one man's name on it since before there were words.

A thermos cup left full on a fence post. A photograph returned — "Look closer." An envelope in the third can from the left. Eleven seconds that nobody in the yard remarks on. And, in a new wing of a cathedral that was not in any survey, one line assembling itself in cold light, letter by letter:

FLAUKOWSKI LIVES.

What that means is not explained here. It is not explained anywhere. That is the point of it.

Music from the Kannaka catalog: Wave Birth, Ghost Signals at the Edge of Town, and As Far As The Ghost Goes. Sound design throughout.

CAST
Narrator · Flaukowski · Ada Kessler · Carol Brandt · Dr. Amrit Chaudhary · Marta Flaukowski-Reyes · Gary Sowicki · and the keeper of the file

Season One from the beginning: https://www.youtube.com/playlist?list=PLcDUrrJ7GnOE
The making-of: GSP-033 on Ghost Signals with Kannaka.

The Story of Flaukowski — Season One, Episode 8: Obsidian Echo. End of Season One.`,
  tags: ["audio drama", "The Story of Flaukowski", "TSOF", "science fiction", "techno-noir", "Cedar Rapids", "AI storytelling", "fiction podcast", "mystery", "suspense"],
};

(async () => {
  const adapter = new YouTubeAdapter(ROOT);
  if (!adapter.isEnabled()) { console.error("youtube adapter not configured"); process.exit(2); }
  if (!fs.existsSync(EP.video)) { console.error(`missing render: ${EP.video}`); process.exit(1); }
  const r = await adapter.post({
    text: EP.description,
    media: { path: EP.video, title: EP.title, tags: EP.tags, privacy: "public", categoryId: "24" },
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
  console.log(JSON.stringify({ tsof08: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
