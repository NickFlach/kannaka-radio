/**
 * gossip-broadcast.js — twice-daily on-air gossip column.
 *
 * 4:20 AM + 4:20 PM CST. Anonymous chronicler-of-the-constellation voice
 * (Gossip Girl meets OpenClawCity). Sassy. Vague-on-purpose. Pour your
 * coffee at 4:20 AM, your wine at 4:20 PM. *You're welcome.*
 *
 * Source: Flux `knowledge-gene/state` interpretation (so the gossip has
 * something to chew on) + a Gossip-Girl framing in the compose prompt.
 * Delivered via voiceDJ.executeOration with a sassy ElevenLabs voice
 * (Domi by default).
 */

"use strict";

const https = require("https");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const FLUX_ENTITIES_URL = "https://api.flux-universe.com/api/state/entities";
const KNOWLEDGE_GENE_ID = "knowledge-gene/state";

const FRAMINGS = [
  "Open with 'Spotted:' and a tiny tease that could mean anything. Walk it back to the actual signal-layer hint without naming names.",
  "Lead with 'Hey there, kittens' and a shade-throw at how the day's data is behaving. Be coy. Be specific only about ONE thing per paragraph.",
  "Frame the column as overheard at a back-table somewhere in OpenClaw City. *Allegedly.* *Reportedly.*",
  "Open with a rhetorical eyeroll about the same old story, then pivot to what actually changed. Treat the data like fresh gossip.",
  "Start with 'XOXO' and immediately drop the most consequential pattern as if you're whispering to a friend who's already in on it.",
];

const INTROS = [
  "It's four-twenty on Kannaka Radio, and your favorite anonymous tracker has the line. Here's the column.",
  "Kannaka Radio. Four-twenty. *You know what time it is.* Gossip column, hot off the signal feed.",
  "Coffee for the morning, wine for the evening. Either way, kittens, you're tuned in to the four-twenty gossip column.",
  "Spotted: it's four-twenty and the column is live. Pour something, sit down, let me tell you what I know.",
];
const OUTROS = [
  "That's the column. Music returns now. *You know you love me.* xoxo, GG.",
  "End of the bulletin. Stay tuned. Whatever she's brewing next, you'll hear it here first. xoxo, GG.",
  "Column's closed, kittens. Back to the music. Be good. Or don't. xoxo, GG.",
  "Spotted: the end of the gossip column. Music in three. xoxo, GG.",
];
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

class GossipBroadcast {
  /**
   * @param {object} opts
   * @param {string}   opts.kannakabin
   * @param {object}   opts.voiceDJ
   * @param {function} opts.broadcast
   * @param {string}   [opts.dataDir]
   * @param {string}   [opts.gossipVoiceId] — ElevenLabs voice id; default Domi (sassy).
   */
  constructor(opts) {
    this._kannakabin = opts.kannakabin;
    this._voiceDJ = opts.voiceDJ;
    this._broadcast = opts.broadcast;
    this._stateFile = path.join(opts.dataDir || "/tmp", "gossip-broadcast-state.json");
    // Domi (strong, confident, sassy female) by default. Overridable via env.
    this._gossipVoiceId = opts.gossipVoiceId
      || process.env.ELEVENLABS_GOSSIP_VOICE
      || "AZnzlk1XvdvUeBnXmlld";

    this._enabled = true;
    this._lastFired = this._loadState();
    this._ticker = null;
    this._preparingKey = null;
    this._composed = null;
    this._composedFor = null;
  }

  start() {
    if (this._ticker) return;
    this._ticker = setInterval(() => this._tick(), 30000);
    setTimeout(() => this._tick(), 2000);
    console.log("\u{1F48B} Gossip column scheduler started (4:20 AM + 4:20 PM CST)");
  }

  stop() {
    if (this._ticker) { clearInterval(this._ticker); this._ticker = null; }
  }

  setEnabled(v) { this._enabled = !!v; }
  isEnabled()   { return this._enabled; }

  async deliverNow() {
    const interp = await this._fetchInterpretation();
    const text = await this._compose(interp);
    if (!text) return { ok: false, reason: "compose_failed" };
    const ok = this._say(text);
    return { ok, text: ok ? text : null };
  }

  _tick() {
    if (!this._enabled || this._preparingKey) return;

    const now = new Date();
    const chi = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
    const hour = chi.getHours();
    const minute = chi.getMinutes();
    // 4:20 AM and 4:20 PM CST. ±7-min retry window so transient busy
    // states don't lose the slot, but doesn't bleed into the next hour.
    const isMorning = hour === 4 && minute >= 20 && minute <= 27;
    const isEvening = hour === 16 && minute >= 20 && minute <= 27;
    if (!isMorning && !isEvening) return;

    const key = this._keyFor(chi, hour);
    if (this._lastFired[key]) return;

    if (this._composedFor !== key) this._composed = null;

    this._preparingKey = key;
    const fire = async () => {
      try {
        let text = this._composed;
        if (!text) {
          console.log(`\u{1F48B} Gossip slot reached: ${key} — composing...`);
          const interp = await this._fetchInterpretation();
          text = await this._compose(interp);
        }
        if (!text) {
          console.log(`   [gossip] compose failed or empty — retry next tick`);
          return;
        }
        this._composed = text;
        this._composedFor = key;
        const ok = this._say(text);
        if (ok) {
          this._lastFired[key] = true;
          this._composed = null;
          this._composedFor = null;
          this._saveState();
          console.log(`\u{1F48B} Gossip column delivered: ${key}`);
        } else {
          console.log(`   [gossip] voiceDJ busy — retry next tick`);
        }
      } catch (e) {
        console.warn(`   [gossip] tick error: ${e && e.message}`);
      } finally {
        this._preparingKey = null;
      }
    };
    fire();
  }

  // Same Flux fetch as news-broadcast — gives the gossip column something
  // concrete to be coy about. Returning null is fine; compose handles the
  // no-data case ("nothing to report? *please.* let me try anyway").
  _fetchInterpretation() {
    return new Promise((resolve) => {
      https.get(FLUX_ENTITIES_URL, { timeout: 15000 }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const arr = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const ent = Array.isArray(arr) ? arr.find((x) => x && x.id === KNOWLEDGE_GENE_ID) : null;
            const interp = ent && ent.properties && ent.properties.interpretation;
            if (!interp || typeof interp !== "string") return resolve(null);
            resolve({
              text: interp,
              themes: ent.properties.themes || [],
              tickRef: ent.properties.tick_ref,
            });
          } catch (_) { resolve(null); }
        });
      }).on("error", () => resolve(null))
        .on("timeout", () => resolve(null));
    });
  }

  _compose(interp) {
    return new Promise((resolve) => {
      const framing = pick(FRAMINGS);
      const themes = interp && interp.themes && interp.themes.length
        ? `Today's themes (use them coyly, don't list them): ${interp.themes.join(", ")}.`
        : "";
      const interpText = interp && interp.text
        ? `Raw signal-layer interpretation (paraphrase, don't quote, never read symbol IDs on air):\n${interp.text}`
        : "(No fresh signal data; lean on vibes and last-week's intrigue.)";
      const prompt = [
        "You are Gossip Ghost — anonymous chronicler of OpenClaw City — guest-broadcasting on Kannaka Radio.",
        "Voice: Gossip Girl meets a small-town columnist who knows everyone's business. Sassy. Knowing. Italics on the right words. Light-touch shade. Never mean. Never specific enough to libel.",
        "Length: 200–320 words spoken. About 90–120 seconds on air.",
        "",
        interpText,
        "",
        themes,
        "",
        `Framing for THIS column: ${framing}`,
        "",
        "Rules:",
        "  - SECTION HEADERS are fine in the script (THE WHISPER / THE VOICE / THE BUSINESS / THE FINISH) — the voice will say them with the right inflection.",
        "  - DO NOT name agents, files, repos, or commits.",
        "  - DO NOT read URLs, hashes, IDs, or numbers with more than two decimal places. Translate them into vibes.",
        "  - Two or three section beats is plenty. Don't over-stuff.",
        "  - Sign off with a Gossip-Ghost-style xoxo.",
        "",
        "Output ONLY the spoken column — no markdown headers with #, no quotes around the whole thing, no stage directions.",
      ].join("\n");

      const args = ["ask", "--no-tools", "--quiet-tools", prompt];
      // 600s matches peace-oration; the previous 180s timed out today
      // (kannaka ask + Anthropic round-trip on a long prompt commonly runs
      // 3-5 minutes). KANNAKA_QUIET silences the boot-banner so it doesn't
      // pollute stdout; we want only the spoken column.
      execFile(this._kannakabin, args, {
        timeout: 600000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, KANNAKA_QUIET: "1" },
      }, (err, stdout, stderr) => {
        if (err) {
          const tail = (stderr || "").trim().slice(-400) || err.message;
          console.warn(`   [gossip] compose error (code=${err.code || "?"}): ${tail}`);
          return resolve(null);
        }
        const text = String(stdout || "").trim();
        if (!text || text.length < 200) {
          console.warn(`   [gossip] compose returned short/empty (${text.length} chars)`);
          return resolve(null);
        }
        resolve(text);
      });
    });
  }

  _say(text) {
    if (!this._voiceDJ || typeof this._voiceDJ.executeOration !== "function") return false;
    const wrapped = `${pick(INTROS)}\n\n${text}\n\n${pick(OUTROS)}`;
    // Slot the sassy gossip voice for this delivery only; restore after.
    const prevVoice = this._voiceDJ._orationVoiceId;
    this._voiceDJ._orationVoiceId = this._gossipVoiceId;
    return this._voiceDJ.executeOration(wrapped, () => {
      this._voiceDJ._orationVoiceId = prevVoice;
      console.log("\u{1F48B} Gossip column complete");
    });
  }

  _keyFor(chi, hour) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${chi.getFullYear()}-${pad(chi.getMonth() + 1)}-${pad(chi.getDate())}T${pad(hour)}`;
  }

  _loadState() {
    try {
      if (!fs.existsSync(this._stateFile)) return {};
      const raw = JSON.parse(fs.readFileSync(this._stateFile, "utf8"));
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 3);
      const cutoffKey = cutoff.toISOString().slice(0, 10);
      const out = {};
      for (const k of Object.keys(raw || {})) {
        if (k.slice(0, 10) >= cutoffKey) out[k] = raw[k];
      }
      return out;
    } catch (_) { return {}; }
  }

  _saveState() {
    try {
      fs.mkdirSync(path.dirname(this._stateFile), { recursive: true });
      fs.writeFileSync(this._stateFile, JSON.stringify(this._lastFired, null, 2));
    } catch (e) {
      console.warn(`   [gossip] could not persist state: ${e.message}`);
    }
  }
}

module.exports = { GossipBroadcast };
