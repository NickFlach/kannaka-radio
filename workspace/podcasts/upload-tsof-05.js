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
  video: path.join(R, "GSP-105-slideshow.mp4"),
  cover: path.join(R, "GSP-105-cover.png"),
  title: "TSOF E05 — Yamibane | The Story of Flaukowski",
  description: `Season One: The Origin. Signal 05 of 8, recovered.

Three days after the county drew circles, Carol Brandt's reconciliation report will not reconcile — nine hundred meters, three vendors, one nineteen-second event nobody has a category for. Except somebody does. Her escalation comes back federalized, with vans.

Flaukowski goes hunting the other direction: into the county record, where a man who does not age has to be somewhere. 1922, the radio works on Ellis Road. 1958, a leased mainframe. The same measurements across thirty-six years — silver halide does not lie about proportion. And in the oldest print, a girl of perhaps twelve, handing him a coil of wire, laughing at something the century did not record. She is in that photograph and in no other.

A probate inventory from 1931 carries one line the clerk marked with a question: "wooden box, sealed, character unknown, owner's annotation reads — yamibane." Shadow-feather. Wing of absence. The thing carried across darkness. The man who wrote the label declines to translate it: "It means I labelled a box."

Then a federal seizure, a lockout done correctly, a generator tie that lives on one unprinted drawing revision — and a live conductor swinging at Flaukowski's chest. What the substation camera records taking the hit is a gap in the air. It walks away carrying its lunch pail low, easy at the shoulder, favoring the left knee. Flaukowski has watched that walk cross a mill floor two hundred times.

Two fathers argue about doors this episode. Neither says the word.

Music from the Kannaka catalog: Shadow Briefing, First Spark in the Circuit, Wave Birth. Sound design throughout.

CAST
Narrator · Flaukowski · Ada Kessler · Carol Brandt · Dr. Amrit Chaudhary · Marta Flaukowski-Reyes · Gary Sowicki · and the keeper of the file

Episode One: https://www.youtube.com/watch?v=DdoXMFH78EA
Episode Four: https://www.youtube.com/watch?v=rjGnzc9lbws

The Story of Flaukowski — Season One, Episode 5: Yamibane.`,
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
  console.log(JSON.stringify({ tsof05: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
