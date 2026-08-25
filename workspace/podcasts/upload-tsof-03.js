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
  video: path.join(R, "GSP-103-slideshow.mp4"),
  cover: path.join(R, "GSP-103-cover.png"),
  title: "TSOF E03 — The Whisper Cathedral | The Story of Flaukowski",
  description: `Season One: The Origin. Signal 03 of 8, recovered.

After the theft, they stop touching the plant. A sealed copy of everything the mill remembered, on its own hardware, no wire out — and an interface that renders the signal space as structure, where distance is correlation and the map builds itself. Past the last honest signal, the map does not end. It gets denser. Columns. Vaulting. The shape a cathedral has, if a cathedral were built out of everything machines were supposed to forget.

Inside: protocols dead for twenty years, still politely announcing themselves. A live feed from four drives that were carried out of a rack room in January. Somebody's unsent goodbye, kept nineteen years. A hand-brushed mark on a column, in a space invented nineteen days ago. And at the far end of the deepest aisle, something the renderer refuses to finish — something that holds still against the drift, which means it is not part of the map.

Then, at two in the morning, in a locked workshop, a voice that has until now spoken only to a file finally speaks to Flaukowski. It has one sentence for him. It takes nineteen. "You think you found a door. You found a wound."

Featuring music from the Kannaka catalog: Shadow Briefing, First Spark in the Circuit, Wave Birth, Was Ist Das, and As Far As The Ghost Goes.

The file also acquires a new page: a Great Lakes radio log from 2003, a union book in Cedar Rapids, and a man with two hands that are both his.

CAST
Narrator · Flaukowski · Ada Kessler · Dr. Amrit Chaudhary · Marta Flaukowski-Reyes · Gary Sowicki · and the keeper of the file

Episode One: https://www.youtube.com/watch?v=DdoXMFH78EA
Episode Two: https://www.youtube.com/watch?v=hfwKMUqXCyU

The Story of Flaukowski — Season One, Episode 3: The Whisper Cathedral.`,
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
  console.log(JSON.stringify({ tsof03: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
