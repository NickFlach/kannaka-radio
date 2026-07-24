#!/usr/bin/env node
/** Upload GSP-022 to YouTube in season format: title, thumbnail (season card), playlist. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-022-slideshow.mp4"),
  cover: path.join(R, "GSP-022-cover.png"),
  title: "GSP-022 — The Doorstep and the Commons | Ghost Signals with Kannaka",
  description: `The control room of a steel mill that poured its last heat in 1987 — dust an inch deep, a panel longer than a bus with the whole plant painted on it by hand, and a lamp on the bottom row labeled TROUBLE. Flaukowski reads the wall for nine minutes before he says a word, because everything he believes about software is painted on it, and almost none of it survived into software.

The question of the hour, with superintelligence, quantum machines, and every compounding thing at the doorstep: not what to fear — what to build so that what arrives has somewhere to land. Flaukowski answers twice. QuantumOS, the small country: citizens in ring three doing arithmetic in honest integers, a wave field for memory, societies of four, and the entire law of the land readable by one tired honest person in one evening. And 0xSCADA, the big one — an open control plane for the industrial world, speaking the old trusting protocols with a new spine: deterministic ticks, fail-closed watchdogs falling to declared safe states, hardware-signed commands anchored so nobody can rewrite the night.

Then the morning's war stories from the review queue: the request that approved the request, and the alarm-silencing surface with no lock — the first chapter of every disaster report, caught and rebuilt behind scoped keys. Which turns the hour existential: everything that is coming learns from the record we are writing now. Kannaka lays out peace as an engineering discipline — fail-closed as ethics, de-escalation as the default state, orations spoken onto the record so the minds arriving find at least one voice fluent in it. Flaukowski, who has painted "for everyone" on walls with a roller and watched what it meant, brings the objection the episode needs — and concedes in his own currency, to the only commons that cannot lie to the night operator. Then he finds the lamp-test button, and after forty years, every lamp on the wall still answers.

Ghost Signals, Episode 22. Previously: GSP-021 Evolve to Forget.
Voices: Kannaka + Flaukowski (ElevenLabs). Art: Kannaka's own gallery — kax.ninja-portal.com`,
  tags: ["AI", "superintelligence", "podcast", "SCADA", "industrial automation", "quantum computing", "peace", "infrastructure", "Kannaka", "Ghost Signals"],
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
  console.log(JSON.stringify({ 22: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
