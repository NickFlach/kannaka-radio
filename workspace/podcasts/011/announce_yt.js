const path = require("path");
const ROOT = "/home/opc/kannaka-radio";
const { broadcastPost } = require(path.join(ROOT, "server/broadcasters"));
const text =
  "🎥 New on Ghost Signals — \"The Seed and the Horizon\" (double episode): a kernel passes its " +
  "citizenship exam in a day — ring-3 isolation, capability IPC, a leak-free heap measured to the byte — " +
  "then boots from the universe's own coin flip: 64 bits of real Rigetti quantum collapse, provenance-chained, " +
  "echoed back digit for digit, watched live in a browser. Then five threads of what comes next. " +
  "Power arrives second. Proof arrives first. 🌊";
const link = process.env.GSP_LINK || "https://radio.ninja-portal.com";
(async () => {
  const results = await broadcastPost({ text, link }, { rootDir: ROOT });
  for (const r of results) console.log(`${r.name}: ok=${r.ok} ${r.url || r.error || ""}`);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
