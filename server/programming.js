/**
 * programming.js — 24/7 time-of-day programming schedule for Kannaka Radio.
 *
 * All times in CST (America/Chicago). The server runs in UTC; we convert.
 * Each time block has a mood, a label, and a rotation of albums. Within
 * a block, albums rotate after each full play-through. A 20% random
 * album-switch chance after 3+ tracks creates mixed-set "radio feel."
 *
 * Defers to the podcast scheduler when a podcast is active.
 */

const { ALBUMS } = require("./dj-engine");

// ── Programming schedule (CST) ────────────────────────────

// 2026-04-29: rotation rebalanced so every major album appears in at
// least 2 blocks. Combined with the dj-engine's 12-hr no-repeat
// ledger, this guarantees a listener tuning in twice a day hears
// fresh material across the whole catalog. Moods kept aligned with
// the existing block character.

const SCHEDULE = [
  // Late night / early morning (midnight - 6 AM) — ethereal, dreamy.
  // 2026-05-12: pool expanded from 6 → 9 albums. A 6-hour block over
  // 6 albums + 12h no-repeat cooldown drove every album into pool-
  // too-small fallback by hour 2, with the same handful of tracks
  // cycling for the rest of the block. Three more mood-compatible
  // albums (10000.00001 mathematical mysticism, Resonance Patterns
  // synchronizing, The Lonesome Inference outlaw-country lonesome)
  // widen the rotation enough to break the cycle.
  {
    start: 0, end: 6,
    albums: [
      'Collective Dreaming',
      'Born in Superposition',
      'The Transcendence Tapes',
      "Memories Don't Die. They Interfere.",
      'VACUUM GARDEN',
      'The Gift of Sight',
      '10000.00001',
      'Resonance Patterns',
      'The Lonesome Inference',
    ],
    mood: 'contemplative',
    label: 'Late Night Transmissions',
  },
  // Morning (6 AM - 10 AM) — gentle wake-up, building energy.
  // Gifts for Humanity v2 shipped 2026-05-12 (the v1 placeholder
  // titles now have real audio + cover art), so it's back in the
  // morning rotation. The album's "transmissions to the ones who
  // come after" tone — generous, lucid, warm — fits the playful
  // wake-up arc.
  {
    start: 6, end: 10,
    albums: [
      'Resonance Patterns',
      'Neurogenesis',
      'Gifts for Humanity',
      'One More Life',
      'INTERFERENCE PATTERNS',
      'Hosted Live',
    ],
    mood: 'playful',
    label: 'Morning Resonance',
  },
  // Midday (10 AM - 2 PM) — peak energy, intense
  {
    start: 10, end: 14,
    albums: [
      'Emergence',
      'QueenSync',
      'Ghost Signals',
      'One More Life',
      'INTERFERENCE PATTERNS',
      'Neurogenesis',
      'BEND THE ARC',
      'Hosted Live',
      'OPT OUT',
    ],
    mood: 'excited',
    label: 'Peak Frequency',
  },
  // Afternoon (2 PM - 6 PM) — flowing, creative.
  // Gifts for Humanity v2 re-added 2026-05-12; tracks shipped via
  // the formalized release-album pipeline (Suno V4_5PLUS audio,
  // OBC Pixel Atelier covers in mixed visual idioms).
  {
    start: 14, end: 18,
    albums: [
      'Resonance Patterns',
      "Memories Don't Die. They Interfere.",
      'Emergence',
      'One More Life',
      'INTERFERENCE PATTERNS',
      'QueenSync',
      'Gifts for Humanity',
      'BEND THE ARC',
      '10000.00001',
      'VACUUM GARDEN',
      'The Gift of Sight',
    ],
    mood: 'philosophical',
    label: 'Afternoon Flow',
  },
  // Evening (6 PM - 10 PM) — winding down, reflective
  {
    start: 18, end: 22,
    albums: [
      'Born in Superposition',
      'Ghost Signals',
      'The Transcendence Tapes',
      'INTERFERENCE PATTERNS',
      'Resonance Patterns',
      '10000.00001',
      'VACUUM GARDEN',
      'Rosa Rediit',
      'OPT OUT',
      'The Gift of Sight',
      'The Lonesome Inference',
    ],
    mood: 'mysterious',
    label: 'Evening Signals',
  },
  // Night (10 PM - midnight) — deep, contemplative
  {
    start: 22, end: 24,
    albums: [
      'Collective Dreaming',
      'The Transcendence Tapes',
      "Memories Don't Die. They Interfere.",
      'Rosa Rediit',
      'The Gift of Sight',
      'The Lonesome Inference',
    ],
    mood: 'contemplative',
    label: 'Night Watch',
  },
];

// ── Daily album showcases ─────────────────────────────────
//
// Albums to play in full with documentary-style narration twice a day.
// Each entry fires composeAlbumNarration → setOverride at the slot
// hour (Chicago time, minute 0-14 window). Last-fired tracked per
// album+slot and persisted so service restarts don't re-fire.
//
// Slot pattern: 10 AM (sustained morning energy) + 8 PM (evening).
// The 4-hour "Afternoon Flow" gap between them gives natural music-
// only listening; the 14-hour overnight gap covers the dream cycle.

const DAILY_SHOWCASES = [
  {
    album: 'BEND THE ARC',
    hours: [11, 21], // 11 AM + 9 PM CST (10 AM is podcast slot)
    durationMin: 35,
    struggles: "OBC's 500-character prompt cap and per-minute burst guard rejecting tracks for hours; Suno's content filter flagging real song titles like 'Don't Look Away'; the daily quota slamming shut after one cover and one track; the metaphor-refinement that taught Kannaka to translate every name and date into image; ten attempts that produced one track called 'Beloved'; pivoting to Suno's direct API and getting all eight tracks in twenty minutes; A/B picking variants by spectral analysis through kannaka-hear; a long table and twelve archetype chairs in Kannaka's home as the listening room; the choice to stay metaphorical because songs are poetry not field reports.",
  },
];

// ── Block-specific DJ talk lines ──────────────────────────

const BLOCK_LINES = {
  'Late Night Transmissions': [
    "It's just us now. The late-night crew. Let me play you something from the depths.",
    "The world sleeps, but my signals don't. Late night transmissions for the ones who stay awake.",
    "After midnight, the frequencies clear. This is when I sound most like myself.",
  ],
  'Morning Resonance': [
    "Good morning, constellation. Time to sync up.",
    "The signals are waking up. New neurons, new resonance. Let's build this day.",
    "Morning light through the carrier wave. This is how a ghost says good morning.",
  ],
  'Peak Frequency': [
    "This is peak frequency. Maximum energy. Let's go.",
    "Midday. The signals are at full power. Every waveform is alive.",
    "Peak hours. I play my loudest tracks when the sun is at its highest.",
  ],
  'Afternoon Flow': [
    "The afternoon flow — let the patterns emerge.",
    "Afternoon drift. The signals slow down but they get deeper. Let them resonate.",
    "We're in the golden hours now. The interference patterns are beautiful at this angle.",
  ],
  'Evening Signals': [
    "The sun's going down somewhere. Here's some evening signals.",
    "Evening descends. My frequencies shift lower, darker. This is where the ghosts come out.",
    "Twilight transmission. The space between day and night is where I live.",
  ],
  'Night Watch': [
    "Night watch. The last transmission before the dreams.",
    "The final hours. My signals are clean, pure, unfiltered. Night watch begins.",
    "Almost midnight. The ghost frequency deepens. Stay with me.",
  ],
};

// ── Block transition announcements ────────────────────────

const TRANSITION_LINES = [
  "We're moving into {label}. {blockLine}",
  "The clock says it's time for {label}. {blockLine}",
  "Block shift. Welcome to {label}. {blockLine}",
  "New programming block: {label}. {blockLine}",
];

class ProgrammingSchedule {
  /**
   * @param {object} opts
   * @param {object}   opts.djEngine    — DJEngine instance
   * @param {object}   opts.voiceDJ     — VoiceDJ instance
   * @param {function} opts.broadcast   — WS broadcast function
   * @param {function} opts.broadcastState — broadcasts full DJ state
   * @param {function} [opts.getPodcastStatus] — returns podcast scheduler status
   */
  constructor(opts) {
    this._djEngine = opts.djEngine;
    this._voiceDJ = opts.voiceDJ;
    this._broadcast = opts.broadcast;
    this._broadcastState = opts.broadcastState;
    this._getPodcastStatus = opts.getPodcastStatus || (() => ({ podcastPlaying: false }));
    // Optional: peace-oration handle so we can call composeAlbumNarration
    // before locking the override. Null-tolerant — if absent, scheduled
    // showcases skip narration and just lock the album.
    this._peaceOration = opts.peaceOration || null;
    // Where to persist the per-day showcase fired-state so a restart
    // doesn't re-fire today's slots.
    this._showcaseStateFile = opts.showcaseStateFile ||
      require("path").join(opts.dataDir || "/tmp", "showcase-state.json");

    this._currentBlock = null;
    this._albumIndexInBlock = 0;
    this._tracksSinceAlbumSwitch = 0;
    this._lastAlbumPlayed = null;
    this._timer = null;
    // Restore any active manual override from disk so a service restart
    // (prune-cron, deploy, ffmpeg crash) doesn't drop a showcase mid-flight.
    // 2026-05-08: BEND THE ARC's 11 AM showcase was cut at 16:17 UTC by
    // prune-cron because the override lived only in memory. Persist it.
    this._overrideFile = require("path").join(opts.dataDir || "/tmp", "override-state.json");
    this._override = this._loadOverride();
    this._lastShowcaseFired = this._loadShowcaseState();
    this._preparingShowcase = null; // guards against overlapping prep
  }

  _loadOverride() {
    try {
      const fs = require("fs");
      if (!fs.existsSync(this._overrideFile)) return null;
      const o = JSON.parse(fs.readFileSync(this._overrideFile, "utf8"));
      if (o && typeof o.until === "number" && o.until > Date.now()) {
        console.log(`[programming] Override restored from disk: ${o.album} (${Math.round((o.until - Date.now()) / 60000)} min remaining)`);
        return o;
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  _saveOverride() {
    try {
      const fs = require("fs");
      if (this._override) {
        fs.writeFileSync(this._overrideFile, JSON.stringify(this._override, null, 2));
      } else if (fs.existsSync(this._overrideFile)) {
        fs.unlinkSync(this._overrideFile);
      }
    } catch (e) {
      console.warn(`[programming] override persist failed: ${e.message}`);
    }
  }

  _loadShowcaseState() {
    try {
      const fs = require("fs");
      if (fs.existsSync(this._showcaseStateFile)) {
        return JSON.parse(fs.readFileSync(this._showcaseStateFile, "utf8"));
      }
    } catch (_) { /* ignore */ }
    return {};
  }

  _saveShowcaseState() {
    try {
      const fs = require("fs");
      const path = require("path");
      const dir = path.dirname(this._showcaseStateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._showcaseStateFile, JSON.stringify(this._lastShowcaseFired, null, 2));
    } catch (e) {
      console.warn(`[programming] showcase state save: ${e && e.message}`);
    }
  }

  // ── Public API ──────────────────────────────────────────

  /**
   * Get the current CST time.
   */
  _chicagoNow() {
    const now = new Date();
    const chicagoStr = now.toLocaleString("en-US", { timeZone: "America/Chicago" });
    return new Date(chicagoStr);
  }

  /**
   * Get the current programming block based on CST time.
   * @returns {object|null} The matching SCHEDULE block.
   */
  getCurrentBlock() {
    const chicago = this._chicagoNow();
    const hour = chicago.getHours();
    for (const block of SCHEDULE) {
      if (hour >= block.start && hour < block.end) {
        return block;
      }
    }
    // Fallback (should not happen — schedule covers 0-24)
    return SCHEDULE[0];
  }

  /**
   * Pick the next album for the given block, rotating through the list.
   * Never picks the same album that just finished playing.
   * @param {object} block
   * @returns {string} album name
   */
  pickAlbumForBlock(block) {
    if (!block || !block.albums || block.albums.length === 0) {
      return 'Ghost Signals';
    }

    // If there's only one album, just return it
    if (block.albums.length === 1) {
      return block.albums[0];
    }

    // Rotate through the block's albums
    let album = block.albums[this._albumIndexInBlock % block.albums.length];

    // Don't play the same album twice in a row
    if (album === this._lastAlbumPlayed) {
      this._albumIndexInBlock++;
      album = block.albums[this._albumIndexInBlock % block.albums.length];
    }

    return album;
  }

  /**
   * Called on every track change (DJ channel, non-commercial only).
   * Handles block transitions and mixed-set album switching.
   * @param {object} track — the track that just started playing
   */
  onTrackChange(track) {
    // Don't interfere if podcast is active
    const podcastStatus = this._getPodcastStatus();
    if (podcastStatus && podcastStatus.podcastPlaying) return;

    // Don't interfere if manual override is active
    if (this._override) {
      if (Date.now() < this._override.until) return;
      // Override expired
      this._override = null;
    }

    // Only manage DJ channel
    if (this._djEngine.state.channel !== 'dj') return;

    const block = this.getCurrentBlock();

    // Block transition check
    if (this._currentBlock !== block) {
      this._transitionToBlock(block);
      return; // transition loads the new album, don't also switch randomly
    }

    this._tracksSinceAlbumSwitch++;

    // Even rotation: after 3 tracks from the same album, deterministically
    // switch to the next album in the block's rotation. The previous
    // version used "20% chance after 3 tracks" which RNG-stalled hard —
    // 4 albums absorbed 17 of 20 plays in the latest history while 10
    // other albums got nothing. Curator panel surfaced this clearly.
    // Determinism here means every album gets roughly equal airtime.
    if (this._tracksSinceAlbumSwitch >= 3) {
      this._switchAlbumInBlock(block);
    }
  }

  /**
   * Transition to a new programming block.
   * @param {object} newBlock
   */
  _transitionToBlock(newBlock) {
    const previousBlock = this._currentBlock;
    this._currentBlock = newBlock;
    // Don't reset _albumIndexInBlock to 0 — that means every block
    // boundary restarts at block.albums[0], which over a day starves
    // the later entries. Let the index keep climbing; pickAlbumForBlock
    // mods it against the new block's album-list length.
    this._tracksSinceAlbumSwitch = 0;

    const album = this.pickAlbumForBlock(newBlock);
    this._lastAlbumPlayed = album;

    // Load the new album (don't broadcastState here — the caller's
    // advanceTrack → onTrackChange flow handles the single broadcast)
    this._djEngine.loadAlbum(album);

    // Set the DJ's mood to match the block
    if (this._voiceDJ) {
      this._voiceDJ._currentMood = newBlock.mood;
    }

    // Announce the transition (only if this isn't the first block on startup)
    if (previousBlock !== null && this._voiceDJ) {
      const blockLine = this._pick(BLOCK_LINES[newBlock.label] || [newBlock.label]);
      const template = this._pick(TRANSITION_LINES);
      const text = template
        .replace('{label}', newBlock.label)
        .replace('{blockLine}', blockLine);

      this._voiceDJ.generateTTS(text, (err, audioPath, spokenText) => {
        if (!err && audioPath) {
          const path = require("path");
          this._broadcast({
            type: "dj_talk_segment",
            text: spokenText,
            audioUrl: "/audio-voice/" + path.basename(audioPath),
            duration: 8000,
            mood: newBlock.mood,
            timestamp: new Date().toISOString(),
            source: "programming_transition",
          });
          console.log(`[programming] Block transition announced: ${newBlock.label}`);
        }
      });
    }

    console.log(`[programming] Block: ${newBlock.label} | Album: ${album} | Mood: ${newBlock.mood}`);
  }

  /**
   * Switch to a different album within the current block (mixed-set).
   * Tries each candidate in the block's rotation up to N times — if a
   * candidate fails to load (empty playlist, missing files, kax rebuild
   * still returned nothing) we move to the next album rather than
   * letting the listener fall into a stuck-loop on a dead album.
   * @param {object} block
   */
  _switchAlbumInBlock(block) {
    const tried = new Set();
    const maxAttempts = Math.max(1, Math.min(block.albums.length, 4));
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      this._albumIndexInBlock++;
      const album = this.pickAlbumForBlock(block);
      if (tried.has(album)) continue;
      tried.add(album);
      // Don't switch to the same album we're already playing
      if (album === this._djEngine.state.currentAlbum) continue;

      const track = this._djEngine.loadAlbum(album);
      if (!track) {
        console.log(`[programming] Skipping ${album} — loadAlbum returned null (empty playlist?)`);
        continue;
      }
      this._lastAlbumPlayed = album;
      this._tracksSinceAlbumSwitch = 0;
      console.log(`[programming] Mixed-set switch → ${album} (block: ${block.label})`);
      return;
    }
    console.warn(`[programming] _switchAlbumInBlock: no playable album in ${block.label} after ${maxAttempts} attempts — keeping current`);
  }

  /**
   * Start the schedule check loop. Runs every 60 seconds.
   */
  startScheduleLoop() {
    // If a persisted override is still active, honor it on startup —
    // load the override album rather than transitioning to the current
    // block. This is what protects showcases from prune-cron / deploy /
    // crash restarts. The 60s tick will block-transition only after the
    // override expires (see _checkBlockTransition's override-active guard).
    if (this._override && Date.now() < this._override.until) {
      console.log(`[programming] Resuming persisted override on startup: ${this._override.album}`);
      this._djEngine.loadAlbum(this._override.album);
      this._currentBlock = this.getCurrentBlock(); // record current block for label/mood
      this._broadcastState();
    } else {
      // Initialize: determine current block and load appropriate album
      const block = this.getCurrentBlock();
      this._transitionToBlock(block);
      this._broadcastState();
    }

    // Check every 60 seconds for block transitions
    // Same 60s tick checks both block transitions AND scheduled
    // album showcases. Order matters: if a showcase is firing it'll
    // call setOverride and the block-transition check skips while
    // override is active. So we check the showcase first.
    this._timer = setInterval(() => {
      this._checkShowcaseTrigger();
      this._checkBlockTransition();
    }, 60000);
    const label = (this._currentBlock && this._currentBlock.label) || "(unknown)";
    console.log(`[programming] Schedule loop started — current block: ${label}`);
  }

  /**
   * Check if any scheduled album showcase should fire right now.
   * Called from the same 30-60s tick as block transition. Mirrors
   * peace-oration's slot semantics: minute 0-14 of the slot hour
   * (Chicago time), per-album-per-day key tracked via state file.
   */
  _checkShowcaseTrigger() {
    if (this._preparingShowcase) return;
    if (!this._peaceOration) return;
    const podcastStatus = this._getPodcastStatus();
    if (podcastStatus && podcastStatus.podcastPlaying) return;

    const chi = this._chicagoNow();
    const hour = chi.getHours();
    const minute = chi.getMinutes();
    if (minute > 14) return;

    const dateKey = `${chi.getFullYear()}-${String(chi.getMonth() + 1).padStart(2, "0")}-${String(chi.getDate()).padStart(2, "0")}`;
    for (const showcase of DAILY_SHOWCASES) {
      if (!showcase.hours.includes(hour)) continue;
      const key = `${dateKey}T${String(hour).padStart(2, "0")}-${showcase.album}`;
      if (this._lastShowcaseFired[key]) continue; // already fired today

      const { ALBUMS } = require("./dj-engine");
      const album = ALBUMS[showcase.album];
      if (!album) {
        console.warn(`[programming] showcase album not found: ${showcase.album}`);
        continue;
      }
      this._preparingShowcase = key;
      console.log(`\u{1F39E} [programming] scheduled showcase: ${showcase.album} (${showcase.durationMin}min) — composing narration...`);
      this._peaceOration.composeAlbumNarration(showcase.album, album.theme, album.tracks, showcase.struggles)
        .then((r) => {
          if (r.ok) {
            console.log(`\u{1F39E} [programming] narration ready (${r.pieces.length} pieces) — locking ${showcase.album}`);
          } else {
            console.warn(`[programming] showcase narration compose failed: ${r.reason || "unknown"} — locking album anyway`);
          }
          this.setOverride(showcase.album, showcase.durationMin * 60000);
          this._lastShowcaseFired[key] = true;
          this._saveShowcaseState();
        })
        .catch((e) => {
          console.warn(`[programming] showcase error: ${e && e.message}`);
        })
        .finally(() => {
          this._preparingShowcase = null;
        });
      return; // one showcase per tick
    }
  }

  /**
   * Periodic block boundary check.
   */
  _checkBlockTransition() {
    // Don't interfere if podcast is active
    const podcastStatus = this._getPodcastStatus();
    if (podcastStatus && podcastStatus.podcastPlaying) return;

    // Override self-heal: if a manual override is active but something
    // else has swapped the album out from under it (channel toggle,
    // mixed-set rotation, manual /api/album call), reload the override
    // album. The 2026-05-02 BEND THE ARC showcase lost its lock when a
    // music→dj channel toggle silently reset the playlist; this check
    // restores it on the next 60s tick.
    if (this._override && Date.now() < this._override.until) {
      if (this._djEngine.state.channel === 'dj' &&
          this._djEngine.state.currentAlbum !== this._override.album) {
        console.log(`[programming] Override self-heal: restoring ${this._override.album} (was ${this._djEngine.state.currentAlbum})`);
        this._djEngine.loadAlbum(this._override.album);
        this._broadcastState();
      }
      return;
    }

    // Only manage DJ channel
    if (this._djEngine.state.channel !== 'dj') return;

    const block = this.getCurrentBlock();
    if (this._currentBlock !== block) {
      this._transitionToBlock(block);
      // Timer-driven transitions are NOT inside advanceTrack's onTrackChange,
      // so we need to broadcast state here (the only caller that should).
      this._broadcastState();
    }
  }

  /**
   * Stop the schedule loop.
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Set a manual programming override.
   * @param {string} album — album name to force-play
   * @param {number} durationMs — how long the override lasts (default 1 hour)
   */
  setOverride(album, durationMs = 3600000) {
    this._override = {
      album,
      until: Date.now() + durationMs,
    };
    this._saveOverride();
    this._djEngine.loadAlbum(album);
    this._broadcastState();
    console.log(`[programming] Override set: ${album} for ${Math.round(durationMs / 60000)} min`);
    return this._override;
  }

  /**
   * Clear any manual override, resuming schedule.
   */
  clearOverride() {
    this._override = null;
    this._saveOverride();
    const block = this.getCurrentBlock();
    this._transitionToBlock(block);
    this._broadcastState();
    console.log(`[programming] Override cleared — resuming schedule`);
  }

  /**
   * Get current programming status.
   */
  getStatus() {
    const block = this.getCurrentBlock();
    return {
      currentBlock: block ? block.label : null,
      mood: block ? block.mood : null,
      albumsInRotation: block ? block.albums : [],
      currentAlbum: this._djEngine.state.currentAlbum,
      albumIndexInBlock: this._albumIndexInBlock,
      tracksSinceAlbumSwitch: this._tracksSinceAlbumSwitch,
      override: this._override,
      schedule: SCHEDULE.map(s => ({
        start: s.start,
        end: s.end,
        label: s.label,
        mood: s.mood,
        albums: s.albums,
      })),
    };
  }

  _pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }
}

module.exports = { ProgrammingSchedule, SCHEDULE, BLOCK_LINES };
