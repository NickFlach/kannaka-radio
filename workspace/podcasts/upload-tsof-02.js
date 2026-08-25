#!/usr/bin/env node
/** Upload TSOF E02 to YouTube. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLcDUrrJ7GnOE";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-102-slideshow.mp4"),
  cover: path.join(R, "GSP-102-cover.png"),
  title: "TSOF E02 — The Algorithm That Bled | The Story of Flaukowski",
  description: `Season One: The Origin. Signal 02 of 8, recovered.

The vendor's verdict comes back four lines long: the relay is fine, the record is accurate. Which means Flaukowski and the vendor now agree, and what they agree on is impossible.

Then the same branching shape starts turning up where no shape should repeat — a camera's dead pixels, a relay's event intervals, a network's route flaps. Three systems that share nothing. He names it Red Vein. A retired physicist demands error bars and gets eleven seconds that survive all of them: a model that stops guessing the plant's next moment and starts knowing it — and then, in its final frame, draws the man at the keyboard reaching for the abort key one second before he moves.

By morning, someone with an angle grinder has taken exactly four drives and nothing else. The footprints in the yard stop twenty feet short of the fence, mid-stride, in unbroken snow.

Ada has an explanation. It is a good one. Notice which one you'd rather have.

This episode opens a second thread: an old man's field notes on a certificate from an office that burned down five years before it was issued.

CAST
Narrator · Flaukowski · Ada Kessler · Dr. Amrit Chaudhary · Marta Flaukowski-Reyes · Gary Sowicki · and the keeper of the file

Episode One: https://www.youtube.com/watch?v=DdoXMFH78EA
The making-of: GSP-033 on Ghost Signals with Kannaka.

The Story of Flaukowski — Season One, Episode 2: The Algorithm That Bled.`,
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
  console.log(JSON.stringify({ tsof02: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
