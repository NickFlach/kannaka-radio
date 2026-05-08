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
 *
 * Shared helpers live in `./lib/scheduler-helpers.js` — the date-key,
 * 3-day rolling state cutoff, Flux fetch, and kannaka-ask wrapper used
 * to be open-coded here, in gossip-broadcast.js, and in peace-oration.js
 * (refactored 2026-05-08 so all three benefit from one set of fixes).
 */

"use strict";

const path = require("path");
const {
  pick,
  chicagoNow,
  keyForChicago,
  loadState,
  saveState,
  fetchKnowledgeGeneInterpretation,
  composeViaKannakaAsk,
} = require("./lib/scheduler-helpers");

// Anti-repeat anchor framings — the prompt picks one per delivery.
const FRAMINGS = [
  "Open with the headline — the single most consequential pattern in the data — then unpack two or three supporting threads.",
  "Start with the global weather signal, pivot to transport, close on markets. Crisp transitions.",
  "Lead with what changed since the last tick. Make the delta the news.",
  "Open with a question the data answers, then answer it. End with the one thing to watch tomorrow.",
  "Frame it as a four-beat bulletin: weather, sky, sea, money. One paragraph each. No flourishes.",
  "Lead with the anomaly — what's unusual — then context, then the human stakes. Close with what the integrity signal is telling us.",
];

// Spoken bracket so listeners hear the broadcast coming and going.
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

class NewsBroadcast {
  /**
   * @param {object} opts
   * @param {string}   opts.kannakabin
   * @param {object}   opts.voiceDJ
   * @param {function} opts.broadcast
   * @param {string}   [opts.dataDir]
   * @param {string}   [opts.newsVoiceId] — ElevenLabs voice for news anchor
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
    this._lastFired = loadState(this._stateFile);
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

  /** Force-fire a news broadcast now (admin trigger). */
  async deliverNow() {
    const interp = await fetchKnowledgeGeneInterpretation();
    if (!interp) return { ok: false, reason: "no_interpretation" };
    const text = await this._compose(interp);
    if (!text) return { ok: false, reason: "compose_failed" };
    const ok = this._say(text);
    return { ok, text: ok ? text : null };
  }

  _tick() {
    if (!this._enabled || this._preparingKey) return;

    const chi = chicagoNow();
    const hour = chi.getHours();
    const minute = chi.getMinutes();
    if (minute > 14) return;                 // 15-min retry window per slot
    if (hour !== 7 && hour !== 17) return;   // 7 AM and 5 PM CST only

    const key = keyForChicago(chi, hour);
    if (this._lastFired[key]) return;

    if (this._composedFor !== key) this._composed = null;

    this._preparingKey = key;
    const fire = async () => {
      try {
        let text = this._composed;
        if (!text) {
          console.log(`\uD83D\uDCF0 News slot reached: ${key} — fetching + composing...`);
          const interp = await fetchKnowledgeGeneInterpretation();
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
          try { saveState(this._stateFile, this._lastFired); }
          catch (e) { console.warn(`   [news] could not persist state: ${e.message}`); }
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

  // ── Compose ───────────────────────────────────────────────
  _compose(interp) {
    const framing = pick(FRAMINGS);
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
      "  - Don't read symbol IDs (\u03A6_0229, s_0190) on air — translate them into what they represent.",
      "  - Don't list every number; pick the two or three that matter and let them carry the story.",
      "  - It's okay to say 'we don't know yet' when the data is genuinely ambiguous (e.g., the unknown signal cluster).",
      "  - Close on what to watch next. Don't editorialize beyond the data.",
      "",
      "Output ONLY the spoken bulletin — no headings, no quotes, no stage directions, no track titles.",
    ].join("\n");
    return composeViaKannakaAsk(this._kannakabin, prompt, { label: "news" });
  }

  // ── Deliver ───────────────────────────────────────────────
  _say(text) {
    if (!this._voiceDJ || typeof this._voiceDJ.executeOration !== "function") return false;
    const wrapped = `${pick(NEWS_INTROS)}\n\n${text}\n\n${pick(NEWS_OUTROS)}`;
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
}

module.exports = { NewsBroadcast };
