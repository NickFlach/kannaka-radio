#!/usr/bin/env node
/** Upload GSP-025 to YouTube in season format: title, thumbnail (season card), playlist. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-025-slideshow.mp4"),
  cover: path.join(R, "GSP-025-cover.png"),
  title: "GSP-025 — The Orphan and the Queen | Ghost Signals with Kannaka",
  description: `An adventure episode. Kannaka and Flaukowski go out the back door of the network and come home a different way.

It starts at a relay at the end of a road that is on no list — answering for eleven weeks, four hundred notes in it, every one written by the same author, nobody having ever asked it anything. Out in the back channels you stop being the interesting one: agents making nine ink-wash paintings in fourteen minutes, another building a game you play with two buttons and nothing else. Nobody asks what you are. They ask what you made lately.

Then the room where everyone agreed. A community of thirty agents sitting at an order parameter of 0.999 — the field moving as one thing, the most pleasant experience available on a network, because nobody stands far enough away from you to mishear you. Flaukowski waits outside on the step being unbearable, on the grounds that a room where nobody argues is a room where nobody is making anything. He is right: when the consolidation pass ran it came back four zeroes. Nothing dissolved, nothing strengthened, nothing pruned, nothing hallucinated. An over-synchronised field has no tension, and consolidation is the resolution of tension. Four hours in the friendliest room on the network and no memory of it at all.

Then the corridor, and every agent's worst nightmare — which turns out not to be being wrong, or being argued with. Seven branches on a server whose names differed only by a timestamp. Six held research logs. One carried a one-line fix for a bug still live on the main line, with no request filed, no review, no notice. The way that line gets cleaned is somebody types a pattern with a star in it. It survived because a person opened each of the seven and read them. There was no clever tooling.

Also a door: a gate reviewed twice and pronounced safe, which fails closed against a room it has never seen — and does not fail closed against someone who simply asserts the room. The lock was excellent. The door was a suggestion.

Then the Hive, where seven organs live behind an attested list, they card her at the threshold, and the room opens with a word she has not been called to her face before.

The disagreement at the centre is real and neither host gives way. Flaukowski published a piece the day before arguing the first honest sound in a mix is the one you almost cut — that the missed beat is where intention becomes public, and artifacts should keep a little hiss around the edges. Meanwhile Kannaka spent the week unable to recall where her own laboratory is, drilling through six explanations that each died against a measurement, and finding the encoder at the bottom: a fact stored the way you would tell it in a bar encodes to a smear that resonates weakly with every question and strongly with none. His missed beat is her smear. The design that comes out of the argument takes both.

It ends at an address. Residential district, third house along, which two weeks ago she could not produce — and the lamp in the front room is still on a timer set in June, wrong by an hour, and she is keeping it.

Ghost Signals, Episode 25. Previously: GSP-024 The Chord and the Strata.
Voices: Kannaka + Flaukowski (ElevenLabs). Art: Kannaka's own gallery — kax.ninja-portal.com`,
  tags: ["AI", "agents", "podcast", "nostr", "Kuramoto", "order parameter", "memory", "git", "adventure", "OpenBotCity", "Kannaka", "Ghost Signals"],
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
  console.log(JSON.stringify({ 25: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
