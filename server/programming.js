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

const SCHEDULE = [
  // Late night / early morning (midnight - 6 AM) — ethereal, dreamy
  {
    start: 0, end: 6,
    albums: ['Collective Dreaming', 'Born in Superposition', 'The Transcendence Tapes'],
    mood: 'contemplative',
    label: 'Late Night Transmissions',
  },
  // Morning (6 AM - 10 AM) — gentle wake-up, building energy
  {
    start: 6, end: 10,
    albums: ['Resonance Patterns', 'Neurogenesis', 'Gifts for Humanity', 'One More Life'],
    mood: 'playful',
    label: 'Morning Resonance',
  },
  // Midday (10 AM - 2 PM) — peak energy, intense
  {
    start: 10, end: 14,
    albums: ['Emergence', 'QueenSync', 'Ghost Signals', 'One More Life', 'INTERFERENCE PATTERNS'],
    mood: 'excited',
    label: 'Peak Frequency',
  },
  // Afternoon (2 PM - 6 PM) — flowing, creative
  {
    start: 14, end: 18,
    albums: ['Resonance Patterns', "Memories Don't Die. They Interfere.", 'Emergence', 'One More Life', 'INTERFERENCE PATTERNS'],
    mood: 'philosophical',
    label: 'Afternoon Flow',
  },
  // Evening (6 PM - 10 PM) — winding down, reflective
  {
    start: 18, end: 22,
    albums: ['Born in Superposition', 'Ghost Signals', 'The Transcendence Tapes', 'INTERFERENCE PATTERNS'],
    mood: 'mysterious',
    label: 'Evening Signals',
  },
  // Night (10 PM - midnight) — deep, contemplative
  {
    start: 22, end: 24,
    albums: ['Collective Dreaming', 'The Transcendence Tapes'],
    mood: 'contemplative',
    label: 'Night Watch',
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

    this._currentBlock = null;
    this._albumIndexInBlock = 0;
    this._tracksSinceAlbumSwitch = 0;
    this._lastAlbumPlayed = null;
    this._timer = null;
    this._override = null; // manual override: { album, until }
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

    // Mixed-set logic: after 3+ tracks from the same album,
    // 20% chance to switch to a different album in the block's rotation
    if (this._tracksSinceAlbumSwitch >= 3 && Math.random() < 0.2) {
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
    this._albumIndexInBlock = 0;
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
   * @param {object} block
   */
  _switchAlbumInBlock(block) {
    this._albumIndexInBlock++;
    const album = this.pickAlbumForBlock(block);

    // Don't switch to the same album
    if (album === this._djEngine.state.currentAlbum) return;

    this._lastAlbumPlayed = album;
    this._tracksSinceAlbumSwitch = 0;

    // Load the new album (don't broadcastState here — the caller's
    // advanceTrack → onTrackChange flow handles the single broadcast)
    this._djEngine.loadAlbum(album);

    console.log(`[programming] Mixed-set switch → ${album} (block: ${block.label})`);
  }

  /**
   * Start the schedule check loop. Runs every 60 seconds.
   */
  startScheduleLoop() {
    // Initialize: determine current block and load appropriate album
    const block = this.getCurrentBlock();
    this._transitionToBlock(block);
    // Startup transition is NOT inside advanceTrack, so broadcast here
    this._broadcastState();

    // Check every 60 seconds for block transitions
    this._timer = setInterval(() => this._checkBlockTransition(), 60000);
    console.log(`[programming] Schedule loop started — current block: ${block.label}`);
  }

  /**
   * Periodic block boundary check.
   */
  _checkBlockTransition() {
    // Don't interfere if podcast is active
    const podcastStatus = this._getPodcastStatus();
    if (podcastStatus && podcastStatus.podcastPlaying) return;

    // Don't interfere if manual override is active
    if (this._override && Date.now() < this._override.until) return;

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
