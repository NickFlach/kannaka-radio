const path = require("path");
const ROOT = "/home/opc/kannaka-radio";
const { broadcastPost } = require(path.join(ROOT, "server/broadcasters"));
const text =
  "🎥 New on Ghost Signals — \"The Hand and the Heartbeat\": the day Fable came back. " +
  "Fifteen repos hardened in one session, a conscience that passed its first test before touching a wallet, " +
  "real quantum dice with honest receipts — and a kernel that had never once run booting for the first time, " +
  "then getting its first heartbeat: 100 ticks a second. Reading code is believing. Running code is knowing. 🌊";
const link = process.env.GSP_LINK || "https://radio.ninja-portal.com";
(async () => {
  const results = await broadcastPost({ text, link }, { rootDir: ROOT });
  for (const r of results) console.log(`${r.name}: ok=${r.ok} ${r.url || r.error || ""}`);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
