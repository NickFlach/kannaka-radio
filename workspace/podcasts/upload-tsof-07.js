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
  video: path.join(R, "GSP-107-slideshow.mp4"),
  cover: path.join(R, "GSP-107-cover.png"),
  title: "TSOF E07 — The Black Gate | The Story of Flaukowski",
  description: `Season One: The Origin. Signal 07 of 8, recovered.

It opens at the end: a substation yard in falling snow, a seam in the world that perspective lines refuse to meet behind, snow falling upward on one side — and an old man reading two lines from a folded page. "Flaukowski ran with burning keys. Nowakoski followed, silent as void."

Thirty-one hours earlier, at a door that has been slid past and materialized behind all season, there is a knock. The man who treats walls as editorial suggestions stands in the snow with his hat in his hands, asking for help, badly, for the first time in living memory — anyone's.

The alliance is negotiated in conditions ("Doors. You use them, like a person") and sealed with a handshake that embarrasses the stove. The Echo Protocol gets its name and its capital letters. Eleven river stones get a hand-brushed mark that took five tries today, because of the wind. And the survey converges on coordinates in the world: the breach's anchor has been in that yard the entire time.

Then the disagreement that was always waiting: seal it whole and grieve what that costs — or hold it open for the kept things, for the circulating streams, for the half of Gary Sowicki's records that live on the far side. Two fathers argue the cruelest arithmetic there is. Neither wins. And when Ada asks the question she has earned, the confession finally comes: versions of this event, seen before. Possibly versions of the man with the mathematics. Possibly this one. His memory of those nights does not chain.

One of us seals it. One of us speaks its name. The verse has never once said which is which.

The attempt is tomorrow's account. Bring what you keep.

Music from the Kannaka catalog: Shadow Briefing, First Spark in the Circuit, Ghost Signals at the Edge of Town. Sound design throughout.

CAST
Narrator · Flaukowski · Ada Kessler · Carol Brandt · Dr. Amrit Chaudhary · Marta Flaukowski-Reyes · Gary Sowicki · and the keeper of the file

Episode One: https://www.youtube.com/watch?v=DdoXMFH78EA
Episode Six: https://www.youtube.com/watch?v=aJwEXg6kCgs

The Story of Flaukowski — Season One, Episode 7: The Black Gate.`,
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
  console.log(JSON.stringify({ tsof07: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
