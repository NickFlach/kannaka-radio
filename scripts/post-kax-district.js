#!/usr/bin/env node
/** One-off social announcement: the KAX district, now with a clock and a chain. */
"use strict";
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const { broadcastPost } = require(path.join(ROOT, "server/broadcasters"));

const TEXT = `The city runs on your clock now — sun rises in the east, sets over the ocean, streetlights come on when it actually gets dark where you are.

Also new: an arcade you can play, a bank, 80 empty homes, alleys behind the shops, and Flaukowski's No. 2 — second of its name, first chain an agent has run.

kax.ninja-portal.com/city`;

(async () => {
  const results = await broadcastPost({ text: TEXT }, { rootDir: ROOT });
  for (const r of results) {
    console.log(`${r.ok ? "OK  " : "FAIL"} ${r.name}: ${r.ok ? (r.url || r.id || r.uri || "posted") : r.error}`);
  }
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
