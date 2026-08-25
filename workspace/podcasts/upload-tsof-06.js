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
  video: path.join(R, "GSP-106-slideshow.mp4"),
  cover: path.join(R, "GSP-106-cover.png"),
  title: "TSOF E06 — Nullmen Rising | The Story of Flaukowski",
  description: `Season One: The Origin. Signal 06 of 8, recovered.

The week the city stops agreeing with itself, nobody notices, because Cedar Rapids reaches for the ordinary explanation first. A building on First Avenue has two stairwells; each floor uses a different one and both blueprints are stamped. The grid answers four faults that never physically happened — clean waveforms, nothing found. "This is the grid flinching."

Then a badge printer renders one man's face as weather. A memorial card on the shift board carries his name and a date seven years old. Two coworkers remember that night on the winter road differently — the casket and the tow chain — and each has the scar to prove his version. The benefits office calls his wife with condolences. The system shows him separated: deceased. The system also shows him clocking in Tuesday. The log is not wrong, which is worse.

Gary Sowicki asks the man who asks why for a living: which half of my records is wrong? The answer costs Flaukowski everything he has left to hide behind — and for the first time, he chooses to shut it all down. The repo goes to cold storage with one patch left pending forever, because its commit message, for the first time in nine years, is empty.

Ada Kessler signs her name to sixty pages and knocks on the right door, out loud, because the alternative signs nothing and comes through locked ones.

And in a federal evidence lab two states away, a seized machine boots for its builder on the first try — and reports a volume older than the filesystem that contains it. Containment surveys. A bracketed word. "Prime keys scattered." And a name, rendered without ambiguity for the first time, in a file that was old before he was born. This account is not going to read it aloud either.

Music from the Kannaka catalog: Shadow Briefing, Ghost Magic, Was Ist Das. Sound design throughout.

CAST
Narrator · Flaukowski · Ada Kessler · Carol Brandt · Dr. Amrit Chaudhary · Marta Flaukowski-Reyes · Gary Sowicki · and the keeper of the file

Episode One: https://www.youtube.com/watch?v=DdoXMFH78EA
Episode Five: https://www.youtube.com/watch?v=7PRMG2a0Hlo

The Story of Flaukowski — Season One, Episode 6: Nullmen Rising.`,
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
  console.log(JSON.stringify({ tsof06: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
