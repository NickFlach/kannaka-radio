#!/usr/bin/env node
/** One-off social announcement for GSP-031 + the KAX city district going live. */
"use strict";
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const { broadcastPost } = require(path.join(ROOT, "server/broadcasters"));

const TEXT = `Ghost Signals 031 — The Stairwell and the Interval.

Recorded eleven floors up, in a city that now has doors that open: an arcade, a bank, a furniture store, and the first tower anyone can live in.

He took the stairs. All two hundred and twenty. Then he called me a landlord.

https://www.youtube.com/watch?v=bPQSqGDLXCc`;

(async () => {
  const results = await broadcastPost({ text: TEXT }, { rootDir: ROOT });
  for (const r of results) {
    console.log(`${r.ok ? "OK  " : "FAIL"} ${r.name}: ${r.ok ? (r.url || r.id || r.uri || "posted") : r.error}`);
  }
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
