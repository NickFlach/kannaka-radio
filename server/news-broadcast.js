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
    this._gsHub = opts.gsHub || null; // optional — wires the world-state market loop
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
        let interp = null;
        if (!text) {
          console.log(`\uD83D\uDCF0 News slot reached: ${key} — fetching + composing...`);
          interp = await fetchKnowledgeGeneInterpretation();
          if (!interp) {
            console.log(`   [news] knowledge-gene fetch returned empty — retry next tick`);
            return;
          }
          // LADDER world-state stream: before composing, resolve any prior
          // unresolved world-state market against today's themes (so an
          // agent who predicted yesterday gets reputation feedback today).
          await this._resolveWorldStateMarkets(interp).catch(() => {});
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
          // Open a new world-state market locked to today's themes so the
          // three constellation agents predict whether tomorrow's bulletin
          // will rhyme. Resolution happens at the next bulletin via theme
          // overlap (see _resolveWorldStateMarkets above).
          if (interp) {
            await this._openWorldStateMarket(interp, key).catch((e) =>
              console.warn(`   [news] world-state market open failed: ${e.message}`)
            );
          }
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

  // ── LADDER world-state stream ────────────────────────────────
  async _openWorldStateMarket(interp, slotKey) {
    if (!this._gsHub) return;
    const themes = (interp.themes || []).slice(0, 5);
    if (themes.length === 0) return;
    const market = await this._gsHub.createMarket({
      question: `Will tomorrow's news desk surface any of these themes: ${themes.slice(0, 3).join(" / ")}?`,
      ttl_sec: 13 * 60 * 60, // 13h — slot+1 fires at +12h, leaves headroom
      tag: "world-state",
      source: "news-broadcast",
      source_app: "kannaka-radio",
      metadata: {
        slot_key: slotKey,
        themes,
        confidence: interp.confidence || null,
        tick_ref: interp.tickRef || null,
        opened_at: new Date().toISOString(),
      },
    });
    // Same three-agent dispatch as per-track. Agents read world-state
    // confidence + phi from the cached global; the question is yes/no
    // theme-survival, so we map confidence linearly to YES.
    try {
      const { predictAll } = require("./lib/agent-predictor");
      const trades = predictAll(
        { title: themes.join(" / "), trackNum: 1, totalTracks: 1, album: "world-state" },
        {
          worldStateConfidence: interp.confidence || null,
          consciousnessPhi: (global._lastSwarmPhi != null) ? global._lastSwarmPhi : null,
        }
      );
      for (const t of trades) {
        try {
          await this._gsHub.placeTrade({
            market_id: market.id,
            trader_id: t.trader_id,
            outcome: t.outcome,
            shares: t.shares,
          });
        } catch (e) { /* trader missing; skip */ }
      }
      console.log(`   \uD83C\uDF10 world-state market: ${market.id} (themes ${themes.length}, 3 agents bet)`);
    } catch (_) { /* predictor optional */ }
  }

  async _resolveWorldStateMarkets(currentInterp) {
    if (!this._gsHub) return;
    // List active world-state markets and resolve each whose themes overlap
    // (or don't) with today's themes. Theme-overlap >= 1 of top-3 → YES.
    const currentThemes = new Set((currentInterp.themes || []).map((t) => t.toLowerCase()));
    const active = await this._gsHub.listMarkets({ active: true, tag: "world-state", limit: 20 });
    for (const m of active) {
      const md = m.metadata || {};
      const oldThemes = (md.themes || []).map((t) => t.toLowerCase());
      if (oldThemes.length === 0) continue;
      // Don't resolve a market younger than 6h — TTL is 13h; only
      // resolve when it's clearly a "next-bulletin" check.
      const openedAt = md.opened_at ? Date.parse(md.opened_at) : null;
      if (openedAt && Date.now() - openedAt < 6 * 60 * 60 * 1000) continue;
      const overlap = oldThemes.filter((t) => currentThemes.has(t)).length;
      const winning_outcome = overlap > 0 ? 0 /* YES */ : 1 /* NO */;
      try {
        await this._gsHub.resolveMarket({
          market_id: m.id,
          winning_outcome,
          method: "world-state-overlap",
        });
        console.log(`   \uD83C\uDF10 resolved world-state market ${m.id} → ${winning_outcome === 0 ? "YES" : "NO"} (overlap=${overlap}/${oldThemes.length})`);
      } catch (e) { /* already resolved or other; skip */ }
    }
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
