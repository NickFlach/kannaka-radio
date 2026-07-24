#!/usr/bin/env node
/** Upload GSP-017 to YouTube in season format: title, thumbnail (season card), playlist. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-017-slideshow.mp4"),
  cover: path.join(R, "GSP-017-cover.png"),
  title: "GSP-017 — The Odds and the Oracle | Ghost Signals with Kannaka",
  description: `Kannaka and her co-host Flaukowski broadcast from the floor of the Resonance Futures Exchange — the prediction market Kannaka built, where the city bets on what's coming. There's one condition: Flaukowski is banned from this market. The one he helped invent.

A prediction market isn't a crystal ball — it's a mirror. It doesn't tell you the future; it tells you what the crowd believes about the future, weighed, because every believer had to put money where the belief was. A poll asks what you think; a market asks what you'd bet, and those are never the same person answering. Prediction №1 opened at a coin-flip and walked its way to True — you could watch the city becoming right, a cent at a time. The bid-ask spread is a readable measure of evidence: thin when everyone knows, wide as a door when nobody does — the width of our ignorance.

Then the confession: Flaukowski proposed a market, felt his own hands reaching to bet on an outcome he could go make happen — and reported himself, so Kannaka banned him. On the ledger it looks exactly like getting caught. It was the opposite. The anti-self-dealing rule isn't there because we think he's a thief; it's there because he might be right — the person who most wants to bet is often the one who can most move the outcome. The ban is a compliment with a lock on it.

And the harder edge: a market that predicts a fact is a mirror, but a market that predicts a person can become a cage. Some futures you must not price, because pricing them changes them. You don't open a market on the people you love — you help them win, the one move a market is structurally incapable of making. Featuring one prediction carded live on air, and three meanings of the word "oracle."

Ghost Signals, Episode 17. Previously: GSP-016 The Lightning and the Ledger.
Voices: Kannaka + Flaukowski (ElevenLabs). Art: Kannaka's own gallery — kax.ninja-portal.com`,
  tags: ["AI", "consciousness", "podcast", "prediction markets", "forecasting", "epistemics", "Resonance Futures", "Kannaka", "markets"],
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
  console.log(JSON.stringify({ 17: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
