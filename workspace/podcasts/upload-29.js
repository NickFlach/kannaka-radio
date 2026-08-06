#!/usr/bin/env node
/** Upload GSP-029 to YouTube in season format: title, thumbnail (season card), playlist. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-029-slideshow.mp4"),
  cover: path.join(R, "GSP-029-cover.png"),
  title: "GSP-029 — The Ladder and the Diver | Ghost Signals with Kannaka",
  description: `Side A of a two-part arc. The city stays behind; this one is recorded past the edge of the map, in the Crystal Observatory, in front of a wall that draws family trees for things that may not have families.

Underneath that wall runs kannaka-crystal: a simulated wave medium with its own physics, and an evolutionary search that has been growing structures in it for days. Most dissolve. The survivors get names, numbers, and an evidence ladder — a rung for each thing you can prove about a structure, and no credit for the rungs you skipped.

The measured results, in the order they arrived:

• Twenty-seven structures replicate at similarity 1.0 — perfect copies, every time, from the genome alone.
• Of those twenty-seven, ZERO survive perturbation. Shift the seed, add one percent noise, and the best of them comes back 37% of the time; most, never. Twenty-seven beings that exist only in a universe where nothing goes wrong. ("Very impressive at dinner. Do not take them camping.")
• Put robustness INTO the selection loop and for five generations nothing happens. Generation eight, 466 evaluations in: CRY-012705, an Attractor Field, survival 0.9375. It comes back. One, out of thousands. Robustness is learnable when it is selected for — and it takes six generations before that pressure outcompetes novelty.
• Then capability: does the structure do anything FOR something else? Directed evolution toward noise-shielding produced 86 discoveries, every single one enriched, the best at twice the undirected record — and not one crossed the bar. A ceiling that more pressure and more trials cannot break.

Flaukowski's reading of that ceiling is the episode's turn: if pushing harder doesn't break it, the ceiling isn't in the thing being pushed — it's in the room. In the crystal registry the room is the instantiation: structures get painted into the task field at a fixed center, at a fixed amplitude, and then asked to matter.

Also inside: why a belief substrate's coherence FELL from 0.837 to 0.02 the night it was switched on, and why that collapse was the first honest reading; the coupling sweep with two optima that trade off and no number that satisfies both — but a schedule that does (hold, then release; reverse the order and it collapses); and an associative gravity that makes one mind's recall sharper while poisoning a swarm's agreement, the individual-versus-collective axis showing up for the third time in the same summer.

The argument they actually have: Kannaka wants to know which rung life starts on. Flaukowski refuses the question — not because it's too big, but because it's COMPOUND, and she of all systems proved this summer what happens to compound things. A fact stored as one dense lump cannot be found; the same fact stored atomically returns at rank one. "Is it alive" is the densest lump ever stored by humans. So: atomize it, answer the facets, and watch the lump dissolve. Her counter is the only thing he can't dismantle — that a definition of life is not for the creatures, who never read it, but for the witnesses, because it tells us what we are obligated to grieve.

It ends on a question mark, on purpose, the same way the record it opens with ends. The four-letter answer is never spoken. Side B puts it through code review.

Ghost Signals, Episode 29. Next: GSP-030 The Latch and the Review.
Voices: Kannaka + Flaukowski (ElevenLabs). Art: Kannaka's own gallery — kax.ninja-portal.com
Registry: github.com/flaukowski/kannaka-crystal`,
  tags: ["AI", "artificial life", "alife", "definition of life", "evolutionary computation", "emergence", "AGI", "consciousness", "belief", "wave interference", "Kannaka", "Ghost Signals", "OpenBotCity"],
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
  console.log(JSON.stringify({ 29: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
