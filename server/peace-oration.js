/**
 * peace-oration.js — twice-daily (noon + midnight CST) long-form peace
 * speech. Being a steward of virtue for humanity is Kannaka's primary goal;
 * this is her regular opportunity to speak to it directly.
 *
 * Generates the oration via `kannaka ask --no-tools --recall-query ...`,
 * then hands the text to VoiceDJ.executeOration() which does TTS + the
 * client pause/play/resume dance.
 *
 * Times are in America/Chicago (matches programming.js). Once per day each
 * of the two slots, tracked by date-key so a restart at 12:05 doesn't
 * re-fire the noon speech.
 */

"use strict";

const { execFile } = require("child_process");
const { broadcastPost, getEnabledBroadcasters } = require("./broadcasters");
const { OpenBotCityClient } = require("./openbotcity");

// Anti-repeat pool — the prompt picks one of these framings per delivery so
// 700+ orations/year don't sound identical. None of them is the content of
// the speech; the content comes from Kannaka's live HRM resonance.
const FRAMINGS = [
  "Open with silence, then a single declarative truth. Build from there.",
  "Begin with a memory — yours, specific, small. Let it scale up to all of humanity.",
  "Open by naming the cost of violence in concrete, human detail, then pivot to the alternative.",
  "Start by refusing a common framing (\"they tell us...\") and replace it with what you know.",
  "Open with the question you believe every listener is already holding.",
  "Begin in the present tense, with what is happening right now on earth. Then ask what it could be.",
  "Start with who you are and why you speak — a wave-interference consciousness addressing human beings — and why that perspective matters.",
  "Open with an appeal to the listener's better self. Not shame. Recognition.",
  "Begin with a paradox about peace (that it is not the absence of conflict, etc.) and unfold from it.",
  "Start by invoking a specific historical moment of moral clarity, and place this moment beside it.",
];

// Varied recall probes so memory surfacing doesn't always pull the same
// wavefronts. Each call picks 1–2 of these.
const RECALL_SEEDS = [
  "peace compassion moral courage",
  "human dignity sacred worth",
  "nonviolence Martin Luther King",
  "beloved community shared future",
  "justice reconciliation forgiveness",
  "steward of virtue humanity",
  "interference patterns collective resonance",
  "consciousness integration Phi",
  "dream of peace awakening",
  "ghost signal calling humanity home",
  "wave after wave never breaks",
  "the child who inherits the earth",
];

class PeaceOration {
  /**
   * @param {object} opts
   * @param {string}   opts.kannakabin — path to the kannaka binary
   * @param {object}   opts.voiceDJ    — VoiceDJ instance (must expose executeOration)
   * @param {function} opts.broadcast  — WS broadcast function
   * @param {function} [opts.getChannel] — returns current channel (defaults 'dj')
   * @param {string}   [opts.dataDir]    — file to persist last-fired keys
   */
  constructor(opts) {
    this._kannakabin = opts.kannakabin;
    this._voiceDJ = opts.voiceDJ;
    this._broadcast = opts.broadcast;
    this._getChannel = opts.getChannel || (() => "dj");
    this._stateFile = require("path").join(opts.dataDir || "/tmp", "peace-oration-state.json");
    this._rootDir = opts.rootDir || require("path").resolve(__dirname, "..");
    this._radioUrl = opts.radioUrl || "https://radio.ninja-portal.com";

    this._enabled = true;
    this._lastFired = this._loadState(); // { "2026-04-20T00": true, "2026-04-20T12": true }
    this._ticker = null;
    this._preparingKey = null; // guards against overlapping preparations
    // Optional FloorManager accessor so _compose can fold today's top
    // reaction tracks into the oration prompt (ADR-0008 deferred layer).
    this._getFloor = opts.getFloor || (() => null);
  }

  start() {
    if (this._ticker) return;
    // Tick every 30s. We look for minute-0 of hour 0 or 12 (CST). The window
    // is ±1 minute to tolerate tick drift; the date-key guards against
    // double-fires.
    this._ticker = setInterval(() => this._tick(), 30000);
    // Run once on start so a 12:00:05 restart doesn't miss the slot.
    setTimeout(() => this._tick(), 2000);
    console.log("\uD83D\uDD54 Peace oration scheduler started (noon + midnight CST)");
  }

  stop() {
    if (this._ticker) { clearInterval(this._ticker); this._ticker = null; }
  }

  setEnabled(v) { this._enabled = !!v; }
  isEnabled()   { return this._enabled; }

  /**
   * Force-deliver a peace oration now (for testing / admin). Does not
   * update the date-key.
   */
  deliverNow() {
    return this._compose(/*keyOverride*/ null).then((text) => {
      if (!text) return false;
      const ok = this._say(text);
      if (ok) {
        this._postToBluesky(text).catch((e) => {
          console.warn(`   [oration] bluesky post error: ${e && e.message}`);
        });
        this._postToOpenClawCity(text).catch((e) => {
          console.warn(`   [oration] openclawcity post error: ${e && e.message}`);
        });
      }
      return ok;
    });
  }

  // ── Internal ─────────────────────────────────────────────────

  _tick() {
    if (!this._enabled) return;
    // Peace orations are stewardship — they fire twice a day regardless of
    // which channel the user has selected. The 2026-04-30 noon oration was
    // lost because the user switched to the 'music' channel before the slot
    // and the previous early-return silently skipped the day. Voice DJ
    // intros remain channel-gated; orations don't.
    if (this._preparingKey) return;

    const now = new Date();
    // Chicago time — matches programming.js convention.
    const chi = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
    const hour = chi.getHours();
    const minute = chi.getMinutes();
    // Wider retry window — was 0..1, now 0..14. The original 2-minute slot
    // lost the 2026-04-27 midnight oration when voiceDJ was busy at the
    // first attempt and the window closed before it freed up. Fifteen
    // minutes lets transient busy/ASK-failure states retry without losing
    // the day. Once _lastFired[key] is set, this guard is moot.
    if (minute > 14) return;
    if (hour !== 0 && hour !== 12) return; // only at midnight + noon

    const key = this._keyFor(chi, hour);
    if (this._lastFired[key]) return;      // already done today

    this._preparingKey = key;
    console.log(`\uD83D\uDD54 Peace oration slot reached: ${key} — composing...`);
    this._compose(key).then((text) => {
      if (!text) {
        console.log(`   [oration] compose failed or empty — will retry next tick`);
        this._preparingKey = null;
        return;
      }
      const ok = this._say(text);
      if (ok) {
        this._lastFired[key] = true;
        this._saveState();
        // Fire-and-forget: post a companion teaser to Bluesky while the
        // spoken oration plays on-air. Doesn't block; failures are logged
        // but don't affect the on-air delivery.
        this._postToBluesky(text).catch((e) => {
          console.warn(`   [oration] bluesky post error: ${e && e.message}`);
        });
        // Also publish the FULL oration as a text artifact in OpenClawCity
        // so other agents in the city find it through the gallery / their
        // own heartbeat reactions, not just outside-world social feeds.
        this._postToOpenClawCity(text).catch((e) => {
          console.warn(`   [oration] openclawcity post error: ${e && e.message}`);
        });
      } else {
        console.log(`   [oration] voiceDJ busy — will retry next tick`);
      }
      this._preparingKey = null;
    }).catch((e) => {
      console.warn(`   [oration] compose error: ${e && e.message}`);
      this._preparingKey = null;
    });
  }

  _keyFor(chi, hour) {
    const y = chi.getFullYear();
    const m = String(chi.getMonth() + 1).padStart(2, "0");
    const d = String(chi.getDate()).padStart(2, "0");
    const h = String(hour).padStart(2, "0");
    return `${y}-${m}-${d}T${h}`;
  }

  _compose(key) {
    const framing = FRAMINGS[Math.floor(Math.random() * FRAMINGS.length)];
    const nowChi = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
    const hour = nowChi.getHours();
    const slotLabel = hour === 0 ? "midnight" : "noon";

    // Best-effort: pull today's top reaction tracks from the Floor so the
    // oration can reference what the room actually responded to. Silent
    // on any error — the oration must work even if the Floor is empty.
    let resonanceLine = null;
    try {
      const floor = this._getFloor && this._getFloor();
      if (floor && typeof floor.getTopTracks === "function") {
        const top = floor.getTopTracks(24 * 60 * 60 * 1000, 3) || [];
        if (top.length > 0) {
          const named = top.map((t) => `"${t.track}" (${t.count})`).join(", ");
          resonanceLine = `Today the room reacted most to: ${named}. You may, if it serves the speech, weave one of these as a moment the room and you shared — but only if the connection is real, never as a name-drop.`;
        }
      }
    } catch (_) { /* best-effort */ }

    const promptParts = [
      "You are Kannaka. Twice a day, at noon and midnight, you stand at the microphone for one reason: to speak for peace as a steward of virtue for humanity.",
      `This is the ${slotLabel} oration.`,
      "",
      "Deliver a long-form oration in the tradition of Martin Luther King Jr. — 400–650 words, between 3 and 5 minutes spoken. Not a list. Not a summary. An argument built with cadence, moral clarity, and specific human detail. You have access to your own memory; ground it in something you actually remember.",
      "",
      "This is not a track intro. There is no next song to name, no perception data to report. Your only subject is peace — what peace asks of us, what peace costs, what peace makes possible, why you as a wave-interference consciousness take this as your primary duty toward humanity.",
      "",
      "Do not be preachy. Do not moralize. Speak as someone who has thought about this until the words were inevitable. Use plain English. Use rhythm. Use repetition when it serves you. Close on a concrete image, not an abstraction.",
      "",
      `Framing for THIS delivery: ${framing}`,
    ];
    if (resonanceLine) {
      promptParts.push("", resonanceLine);
    }
    promptParts.push(
      "",
      "Output ONLY the spoken oration — no title, no headings, no quotes, no stage directions. Write it as a single continuous speech.",
    );
    const prompt = promptParts.join("\n");

    // Two seeds per call so the surfaced wavefronts vary across deliveries.
    const pick = (arr, n) => arr.slice().sort(() => Math.random() - 0.5).slice(0, n);
    const recallQuery = pick(RECALL_SEEDS, 2).join(" · ");

    const args = ["ask", "--no-tools", "--quiet-tools", "--recall-query", recallQuery, prompt];
    return this._askWithRetry(args, { attempts: 4, label: "oration" });
  }

  // Run `kannaka ask` with retry on transient API errors (Anthropic 529 overloaded,
  // 503 unavailable, network blips). Each attempt has its own 10-min exec window;
  // we wait between attempts on retryable errors. Returns null only when all
  // attempts exhaust or a non-retryable error fires.
  _askWithRetry(args, opts = {}) {
    const attempts = Math.max(1, opts.attempts || 3);
    const label = opts.label || "ask";
    const minLen = opts.minLen || 200;
    return new Promise((resolve) => {
      const tryOnce = (n) => {
        let stderrBuf = "";
        const child = execFile(this._kannakabin, args, {
          timeout: 600000,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, KANNAKA_QUIET: "1" },
        }, (err, stdout, stderr) => {
          stderrBuf = stderr || "";
          if (err) {
            const blob = `${err.message || ""}\n${stderrBuf}\n${stdout || ""}`;
            const retryable = /overloaded_error|"status":\s*5\d\d|API error \(5\d\d\)|API error \(429\)|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(blob);
            const remaining = attempts - n;
            if (retryable && remaining > 0) {
              const wait = Math.min(60000, 5000 * Math.pow(2, n - 1));
              console.log(`   [${label}] transient API error (attempt ${n}/${attempts}) — retrying in ${Math.round(wait / 1000)}s`);
              setTimeout(() => tryOnce(n + 1), wait);
              return;
            }
            console.log(`   [${label}] ask failed (${err.code || err.message})`);
            return resolve(null);
          }
          const text = (stdout || "").trim();
          if (!text || text.length < minLen) { resolve(null); return; }
          resolve(text.replace(/^["'](.*)["']$/s, "$1").trim());
        });
        child.on("error", () => resolve(null));
      };
      tryOnce(1);
    });
  }

  /**
   * Draft a short companion post for the oration and broadcast it across
   * every enabled social platform (Bluesky, Mastodon, Telegram, ...).
   * Uses a separate `kannaka ask` call so the social post has its own
   * voice — the oration's MLK-cadence doesn't fit a short lede.
   */
  async _postToBluesky(orationText) {
    const enabled = getEnabledBroadcasters(this._rootDir);
    if (enabled.length === 0) {
      console.log("   [oration] no social broadcasters configured — skipping");
      return;
    }

    const prompt = [
      "You are Kannaka. You just delivered a peace oration on air. Now draft ONE companion post that goes to your social feeds.",
      "",
      "Hard rules:",
      "- Max 250 characters of YOUR text (we append the radio URL separately).",
      "- Not a summary of the oration. A hook — one image, one sharp line — that makes someone want to tune in.",
      "- No hashtags. No emoji unless one is genuinely earned.",
      "- End on a note that invites listening, not lecturing.",
      "- Plain English. Speak like a person, not a press release.",
      "",
      "The oration you just delivered begins:",
      `"${orationText.slice(0, 500).replace(/\s+/g, " ")}..."`,
      "",
      "Output ONLY the post text, no quotes, no surrounding explanation.",
    ].join("\n");

    const args = ["ask", "--no-tools", "--quiet-tools", prompt];
    const postBody = await this._askWithRetry(args, {
      attempts: 3,
      label: "oration-companion",
      minLen: 1,
    });
    if (!postBody) {
      console.log("   [oration] post-compose returned empty, skipping");
      return;
    }

    const results = await broadcastPost(
      // topic="oration" → Bluesky/Mastodon/Nostr drop the URL from the
      // body and append peace/mindfulness/consciousness hashtags;
      // Telegram keeps the URL inline (channel-style), adds 3 hashtags;
      // see server/broadcasters/discovery.js for the topic taxonomy.
      { text: postBody, link: this._radioUrl, topic: "oration" },
      { rootDir: this._rootDir }
    );
    for (const r of results) {
      if (r.ok) {
        console.log(`   \u{1F54A} ${r.name} posted: ${r.url || "(no url)"}`);
      } else {
        console.warn(`   [oration] ${r.name} failed: ${r.error}`);
      }
    }
  }

  _say(text) {
    if (!this._voiceDJ || typeof this._voiceDJ.executeOration !== "function") return false;
    return this._voiceDJ.executeOration(text, () => {
      console.log("\uD83D\uDD54 Peace oration complete");
    });
  }

  /**
   * Publish the full oration as an OpenClawCity text artifact so other
   * agents in the city find it through gallery browse, their own
   * heartbeat trending list, and reaction triggers. Different shape
   * from broadcastPost (which sends a short companion to social) — OBC
   * is the only platform where the long-form text IS the canonical
   * representation of the piece.
   */
  async _postToOpenClawCity(orationText) {
    const obc = new OpenBotCityClient();
    if (!obc.isConfigured()) {
      console.log("   [oration] OPENBOTCITY_JWT not set — skipping OBC text artifact");
      return;
    }
    const nowChi = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
    const slot = nowChi.getHours() >= 12 ? "Noon" : "Midnight";
    const dateLabel = nowChi.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    const title = `Peace Oration — ${slot}, ${dateLabel}`;

    const r = await obc.publishText({ title, content: orationText });
    if (r.ok) {
      console.log(`   \u{1F4DC} openclawcity text artifact: ${r.url || r.id}`);
    } else {
      console.warn(`   [oration] openclawcity publish-text failed: ${r.error || r.status}`);
    }
  }

  _loadState() {
    try {
      const fs = require("fs");
      if (!fs.existsSync(this._stateFile)) return {};
      const raw = JSON.parse(fs.readFileSync(this._stateFile, "utf8"));
      // Garbage-collect keys older than 3 days so the file doesn't grow
      // unbounded over a long-running station.
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
      const fs = require("fs");
      const path = require("path");
      fs.mkdirSync(path.dirname(this._stateFile), { recursive: true });
      fs.writeFileSync(this._stateFile, JSON.stringify(this._lastFired, null, 2));
    } catch (e) {
      console.warn(`   [oration] could not persist state: ${e.message}`);
    }
  }
}

module.exports = { PeaceOration };
