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
  video: path.join(R, "GSP-104-slideshow.mp4"),
  cover: path.join(R, "GSP-104-cover.png"),
  title: "TSOF E04 — Phantom Code: Delta-33 | The Story of Flaukowski",
  description: `Season One: The Origin. Signal 04 of 8, recovered.

For nine years, in the hours other men give to sleep, Flaukowski has been building 0xSCADA — open-source supervisory control whose whole argument fits on a sticker: the plant's brain should be a text file. Version-controlled logic. Signed commits. A scan-order table where order IS the program. Ada co-maintains. And for nine years a contributor called latchkey has sent small, clean, correct patches — never comments, never asks, never breaks a build. This week Ada notices latchkey's first patch is older than the repository itself.

Then the scan table has thirty-three entries where there should be thirty-two. A coordinate library nobody merged, in Flaukowski's own style, signed with his own key, at a minute he was provably eating pot roast. Deleting it doesn't stick. The record heals. And the block computes addresses in seventy-six coordinates — the exact mathematics the Cathedral survey was missing, with function names like obsidian_echo carved into it like headstones.

A man who comes and goes through bolted doors says one thing plainly, for once: an address is reachability. Computation is not private there. Arithmetic is a knock on a door.

Then three careful people, for reasons you will hear yourself, run it anyway.

What happens at 22:11 involves every screen in the county, circles that cannot close, and instruments that stop drifting — because nothing observed that closely is permitted to drift.

Music from the Kannaka catalog: Shadow Briefing, Ghost Magic, and Ghost Signals at the Edge of Town. Sound design throughout.

CAST
Narrator · Flaukowski · Ada Kessler · Dr. Amrit Chaudhary · Marta Flaukowski-Reyes · Gary Sowicki · and the keeper of the file

Episode One: https://www.youtube.com/watch?v=DdoXMFH78EA
Episode Two: https://www.youtube.com/watch?v=hfwKMUqXCyU
Episode Three: https://www.youtube.com/watch?v=GDjNv8y_qQQ

The Story of Flaukowski — Season One, Episode 4: Phantom Code: Delta-33.`,
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
  console.log(JSON.stringify({ tsof04: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
