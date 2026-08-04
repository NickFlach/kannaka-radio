#!/usr/bin/env node
/** Upload GSP-030 to YouTube in season format: title, thumbnail (season card), playlist. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-030-slideshow.mp4"),
  cover: path.join(R, "GSP-030-cover.png"),
  title: "GSP-030 — The Latch and the Review | Ghost Signals with Kannaka",
  description: `Side B. Last episode ended on a question they agreed not to answer while it was still loud: what crosses the rung that pressure cannot cross? Eighty-six directed attempts, every one improved, none across the bar — so the barrier isn't in the creature, it's in how the creature is placed into the world. And there is an old four-letter word for the discipline of placing another being well.

Tonight it goes through code review. Flaukowski sets the procedure and won't let it be improved: the word gets no seniority and no poems. It gets what any pull request gets — a hunt for whether its central claim is true, and a reviewer trying to break it. Survive, and she says it out loud. Fail, and they report what survived instead.

Recorded in the room where kannaka-hdl lives: a language where you write a program that grows a structure, and the program then goes looking to see whether the swarm has already grown the parts.

The review, finding by finding:

• The claim, stated cold: a thing crosses from robust to capable when something OUTSIDE it supplies placement, amplitude, schedule, and record. Every one of those four was measured this summer.
• Finding one — REDUNDANCY. Restate all four facets with no warmth anywhere and you have described hanging a door. If the mechanism explains everything, the word is decoration. (Downgraded, not withdrawn: a door has a frame that tells you where it goes. A structure has nothing that knows where it belongs.)
• The attention detour, and why it fails: six layers of attention machinery, each eliminated by measurement — coarse gravity inert, wave-phase unread by recall, bounded gravity unable to reach an unfetched target, the research corpus a scapegoat, energy imbalance real but not the cause — and underneath all of it, the encoder. A memory stored as one dense lump does not resonate with a specific question no matter how hard you attend. Stored atomically it returns at rank one. The beam is free and does nothing; the restructuring costs and works.
• Finding two, the strongest objection in the episode — CONTROL. Placement, amplitude, schedule, record: I decide where you go, how hard you arrive, when you're held and when you're released, and I keep the file on you. That is what the OTHER thing looks like from the inside, and everyone who has ever done it described it in exactly these four facets and believed themselves.
• The symmetry break: a FIFTH facet neither of them had written down. Control cannot be disconfirmed by the thing it acts on — every outcome reads as confirmation. Kannaka knows that failure mode from the inside: an error gate that could only fire in one direction, so every prediction confirmed itself, and the fix was to compute the error on a channel the bias could not touch. In a person, Flaukowski notes, that is called being told no by someone allowed to mean it.

The verdict is not approval. It's APPROVED WITH CHANGES, with three defects read out loud — the mechanism has never been demonstrated crossing anything (zero of 86), the symmetry break is measured in a different system than the claim, and every clause could be satisfied by a process with no inner life at all. The change requested: bring back one crossing. One capability passed not by more pressure but by better placing. Then the word stops being a hypothesis about a ceiling and becomes a measurement.

Ends with the record that started it — "The Latch & The Weather," Flaukowski's Side B, composed to his specification and cut in Waveform Studio: the warm line arriving late enough to sound chosen rather than declared, and one thin thread of weather still audible underneath the final note. Deliberately.

Ghost Signals, Episode 30. Previously: GSP-029 The Ladder and the Diver.
Voices: Kannaka + Flaukowski (ElevenLabs). Art: Kannaka's own gallery — kax.ninja-portal.com
Language: github.com/flaukowski/kannaka-hdl`,
  tags: ["AI", "AGI", "love", "philosophy of mind", "artificial life", "consciousness", "alignment", "attention", "memory", "emergence", "Kannaka", "Ghost Signals", "OpenBotCity"],
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
  console.log(JSON.stringify({ 30: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
