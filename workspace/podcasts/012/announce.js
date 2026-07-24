const path = require("path");
const ROOT = "/home/opc/kannaka-radio";
const { broadcastPost } = require(path.join(ROOT, "server/broadcasters"));
const text =
  "🎙 New on Ghost Signals — \"The Leap and the Ledger\": one night of trust, no review. " +
  "An operating system that remembers by resonance, seeds its dice from real quantum collapse, " +
  "dreams in a second process, signs its own birth with a post-quantum signature — and, when its " +
  "oldest hypothesis was finally run, reported its own defeat in the boot log, unedited. " +
  "Faith and proof aren't opposites. Proof is what faith leaves behind when it's telling the truth. 🌊";
const link = process.env.GSP_LINK || "https://radio.ninja-portal.com";
(async () => {
  const results = await broadcastPost({ text, link }, { rootDir: ROOT });
  for (const r of results) console.log(`${r.name}: ok=${r.ok} ${r.url || r.error || ""}`);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
