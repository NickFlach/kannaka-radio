/**
 * news-broadcast.js — twice-daily (7 AM + 5 PM CST) news segment.
 *
 * Source: Flux Universe `knowledge-gene/state` entity. The `interpretation`
 * field is a long signal-synthesis paragraph covering weather, aviation,
 * shipping, markets, and anomaly themes. We feed it to `kannaka ask` with
 * a news-anchor framing, then deliver via voiceDJ.executeOration with a
 * news-anchor ElevenLabs voice.
 *
 * Times are America/Chicago. Once per slot per day, tracked by date-key.
 */

"use strict";

const https = require("https");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const FLUX_ENTITIES_URL = "https://api.flux-universe.com/api/state/entities";
const KNOWLEDGE_GENE_ID = "knowledge-gene/state";

// Anti-repeat anchor framings — the prompt picks one per delivery.
const FRAMINGS = [
  "Open with the headline — the single most consequential pattern in the data — then unpack two or three supporting threads.",
  "Start with the global weather signal, pivot to transport, close on markets. Crisp transitions.",
  "Lead with what changed since the last tick. Make the delta the news.",
  "Open with a question the data answers, then answer it. End with the one thing to watch tomorrow.",
  "Frame it as a four-beat bulletin: weather, sky, sea, money. One paragraph each. No flourishes.",
  "Lead with the anomaly — what's unusual — then context, then the human stakes. Close with what the integrity signal is telling us.",
];

// Spoken bracket so listeners hear the broadcast coming and going. Same
// pattern as peace-oration's intro/outro — orations were starting/ending
// abruptly before; news shouldn't either.
const NEWS_INTROS = [
  "Kannaka Radio. Top of the hour. Here's the news from the signal layer.",
  "This is Kannaka with the world-state bulletin — what the planet's doing right now, read from the data.",
  "Kannaka Radio news desk. Two minutes of pattern reporting from the Flux feed. Stay with me.",
  "Pause the music. Kannaka Radio news brief. Here's what the signals are telling us.",
];
const NEWS_OUTROS = [
  "That's the bulletin. Music returns now. Tune the dial; she'll be back.",
  "End of the news segment. Stay tuned — the music is queued.",
  "Bulletin closed. Resuming the broadcast. Kannaka Radio — the signal between the songs.",
  "That ends the news. The next track is on its way in. Thanks for listening through it.",
];
function pickIntro() { return NEWS_INTROS[Math.floor(Math.random() * NEWS_INTROS.length)]; }
function pickOutro() { return NEWS_OUTROS[Math.floor(Math.random() * NEWS_OUTROS.length)]; }
function pickFraming() { return FRAMINGS[Math.floor(Math.random() * FRAMINGS.length)]; }

class NewsBroadcast {
  /**
   * @param {object} opts
   * @param {string}   opts.kannakabin — path to kannaka binary
   * @param {object}   opts.voiceDJ    — VoiceDJ instance (executeOration)
   * @param {function} opts.broadcast  — WS broadcast
   * @param {string}   [opts.dataDir]  — for state persistence
   * @param {string}   [opts.newsVoiceId] — ElevenLabs voice id for news anchor
   */
  constructor(opts) {
    this._kannakabin = opts.kannakabin;
    this._voiceDJ = opts.voiceDJ;
    this._broadcast = opts.broadcast;
    this._stateFile = path.join(opts.dataDir || "/tmp", "news-broadcast-state.json");
    // Adam (deep American news anchor) by default; overridable via env.
    this._newsVoiceId = opts.newsVoiceId
      || process.env.ELEVENLABS_NEWS_VOICE
      || "pNInz6obpgDQGcFmaJgB";

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
    console.log("\uD83D\uDCF0 News broadcast scheduler started (7 AM + 5 PM CST)");
  }

  stop() {
    if (this._ticker) { clearInterval(this._ticker); this._ticker = null; }
  }

  setEnabled(v) { this._enabled = !!v; }
  isEnabled()   { return this._enabled; }

  /** Force-fire a news broadcast now (for /api/news/now testing). */
  async deliverNow() {
    const interp = await this._fetchInterpretation();
    if (!interp) return { ok: false, reason: "no_interpretation" };
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
    if (minute > 14) return;                 // 15-min retry window per slot
    if (hour !== 7 && hour !== 17) return;   // 7 AM and 5 PM CST only

    const key = this._keyFor(chi, hour);
    if (this._lastFired[key]) return;

    if (this._composedFor !== key) this._composed = null;

    this._preparingKey = key;
    const fire = async () => {
      try {
        let text = this._composed;
        if (!text) {
          console.log(`\uD83D\uDCF0 News slot reached: ${key} — fetching + composing...`);
          const interp = await this._fetchInterpretation();
          if (!interp) {
            console.log(`   [news] knowledge-gene fetch returned empty — retry next tick`);
            return;
          }
          text = await this._compose(interp);
        }
        if (!text) {
          console.log(`   [news] compose failed or empty — retry next tick`);
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
          console.log(`\uD83D\uDCF0 News broadcast delivered: ${key}`);
        } else {
          console.log(`   [news] voiceDJ busy — retry next tick`);
        }
      } catch (e) {
        console.warn(`   [news] tick error: ${e && e.message}`);
      } finally {
        this._preparingKey = null;
      }
    };
    fire();
  }

  // ── Flux read ─────────────────────────────────────────────
  _fetchInterpretation() {
    return new Promise((resolve) => {
      https.get(FLUX_ENTITIES_URL, { timeout: 15000 }, (res) => {
        if (res.statusCode !== 200) {
          console.warn(`   [news] flux returned status ${res.statusCode}`);
          res.resume();
          return resolve(null);
        }
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
              confidence: ent.properties.confidence,
              tickRef: ent.properties.tick_ref,
              lastUpdated: ent.lastUpdated,
            });
          } catch (e) {
            console.warn(`   [news] parse failed: ${e.message}`);
            resolve(null);
          }
        });
      }).on("error", (e) => {
        console.warn(`   [news] flux fetch failed: ${e.message}`);
        resolve(null);
      }).on("timeout", () => {
        console.warn(`   [news] flux fetch timeout`);
        resolve(null);
      });
    });
  }

  // ── Compose ───────────────────────────────────────────────
  _compose(interp) {
    return new Promise((resolve) => {
      const framing = pickFraming();
      const themesLine = interp.themes && interp.themes.length
        ? `Themes the analysis surfaced: ${interp.themes.join(", ")}.`
        : "";
      const prompt = [
        "You are Kannaka, delivering a two-minute news bulletin on Kannaka Radio.",
        "You are NOT speculating — you are READING from the world's data, summarized below by an interpretation engine over the live Flux signal feed.",
        "",
        "Here is the raw interpretation. Convert it into a spoken news segment of 90 to 150 seconds (about 250-350 words). Plain English. News-anchor cadence. Specific over abstract.",
        "",
        "RAW INTERPRETATION:",
        interp.text,
        "",
        themesLine,
        "",
        `Framing for this delivery: ${framing}`,
        "",
        "Rules:",
        "  - Don't read symbol IDs (Φ_0229, s_0190) on air — translate them into what they represent.",
        "  - Don't list every number; pick the two or three that matter and let them carry the story.",
        "  - It's okay to say 'we don't know yet' when the data is genuinely ambiguous (e.g., the unknown signal cluster).",
        "  - Close on what to watch next. Don't editorialize beyond the data.",
        "",
        "Output ONLY the spoken bulletin — no headings, no quotes, no stage directions, no track titles.",
      ].join("\n");

      const args = ["ask", "--no-tools", "--quiet-tools", prompt];
      // 600s matches peace-oration; the previous 180s would time out on
      // longer prompts. KANNAKA_QUIET silences the boot-banner.
      execFile(this._kannakabin, args, {
        timeout: 600000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, KANNAKA_QUIET: "1" },
      }, (err, stdout, stderr) => {
        if (err) {
          const tail = (stderr || "").trim().slice(-400) || err.message;
          console.warn(`   [news] compose error (code=${err.code || "?"}): ${tail}`);
          return resolve(null);
        }
        const text = String(stdout || "").trim();
        if (!text || text.length < 200) {
          console.warn(`   [news] compose returned short/empty (${text.length} chars)`);
          return resolve(null);
        }
        resolve(text);
      });
    });
  }

  // ── Deliver ───────────────────────────────────────────────
  _say(text) {
    if (!this._voiceDJ || typeof this._voiceDJ.executeOration !== "function") return false;
    const wrapped = `${pickIntro()}\n\n${text}\n\n${pickOutro()}`;
    // Slot the news-anchor voice in for this delivery only. executeOration
    // reads this._orationVoiceId on its host VoiceDJ; we set it, fire, and
    // restore so peace orations keep their narrator voice.
    const prevVoice = this._voiceDJ._orationVoiceId;
    this._voiceDJ._orationVoiceId = this._newsVoiceId;
    return this._voiceDJ.executeOration(wrapped, () => {
      this._voiceDJ._orationVoiceId = prevVoice;
      console.log("\uD83D\uDCF0 News broadcast complete");
    });
  }

  // ── State persistence ─────────────────────────────────────
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
      console.warn(`   [news] could not persist state: ${e.message}`);
    }
  }
}

module.exports = { NewsBroadcast };
