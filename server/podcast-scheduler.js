/**
 * podcast-scheduler.js — Weekly podcast episodes on the DJ channel.
 *
 * Schedule:
 *   - Friday 10:00 PM CST (03:00 UTC Saturday)
 *   - Saturday 10:00 AM CST (15:00 UTC Saturday)
 *
 * Same episode plays both times. One new episode per week, cycling
 * through all available podcast episodes.
 *
 * Pre-show promo: 30 minutes before each airing, Kannaka announces
 * the upcoming podcast in her next talk segment via the _podcastPromo flag.
 */

const path = require("path");
const fs = require("fs");

// Epoch for week numbering (arbitrary fixed date)
const WEEK_EPOCH = new Date("2025-01-06T00:00:00Z").getTime();

class PodcastScheduler {
  /**
   * @param {object} opts
   * @param {object}   opts.djEngine    — DJEngine instance
   * @param {object}   opts.voiceDJ     — VoiceDJ instance
   * @param {function} opts.broadcast   — WS broadcast function
   * @param {function} opts.broadcastState — broadcasts full DJ state
   * @param {function} opts.getMusicDir — returns MUSIC_DIR
   */
  constructor(opts) {
    this._djEngine = opts.djEngine;
    this._voiceDJ = opts.voiceDJ;
    this._broadcast = opts.broadcast;
    this._broadcastState = opts.broadcastState;
    this._getMusicDir = opts.getMusicDir;

    this._podcastPlaying = false;
    this._savedDJState = null;
    this._lastTriggeredMinute = null; // "YYYY-MM-DD HH:mm" to prevent re-trigger
    this._lastPromoMinute = null;
    this._timer = null;
  }

  /**
   * Start the scheduler. Checks every 60 seconds.
   */
  start() {
    console.log("[podcast-scheduler] Started — Friday 10 PM + Saturday 10 AM CST");
    this._timer = setInterval(() => this._tick(), 60000);
    // Run once immediately to catch restart-during-window
    this._tick();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Get the list of podcast episode files from the Ghost Signals Podcast dir.
   */
  _getEpisodes() {
    const podcastDir = path.join(this._getMusicDir(), "Ghost Signals Podcast");
    if (!fs.existsSync(podcastDir)) return [];
    return fs.readdirSync(podcastDir)
      .filter(f => /\.(mp3|wav|flac|m4a|ogg)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  }

  /**
   * Get the current week's episode index.
   */
  _currentWeekEpisodeIndex(episodes) {
    if (episodes.length === 0) return -1;
    const weekNumber = Math.floor((Date.now() - WEEK_EPOCH) / (7 * 24 * 60 * 60 * 1000));
    return weekNumber % episodes.length;
  }

  /**
   * Get current time in Chicago timezone.
   */
  _chicagoNow() {
    const now = new Date();
    // toLocaleString gives us a parseable date string in Chicago time
    const chicagoStr = now.toLocaleString("en-US", { timeZone: "America/Chicago" });
    return new Date(chicagoStr);
  }

  /**
   * Minute key for dedup (prevents re-triggering within the same minute).
   */
  _minuteKey(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  _tick() {
    const chicago = this._chicagoNow();
    const day = chicago.getDay(); // 0=Sun, 5=Fri, 6=Sat
    const hour = chicago.getHours();
    const min = chicago.getMinutes();
    const minuteKey = this._minuteKey(chicago);

    // ── Pre-show promo (30 min before) ──────────────────────
    const isPromoFriday = day === 5 && hour === 21 && min === 30;
    const isPromoSaturday = day === 6 && hour === 9 && min === 30;

    if ((isPromoFriday || isPromoSaturday) && this._lastPromoMinute !== minuteKey) {
      this._lastPromoMinute = minuteKey;
      // Set the promo flag on VoiceDJ so her next talk segment includes it
      this._voiceDJ._podcastPromo = true;
      console.log("[podcast-scheduler] Promo flag set — podcast in 30 minutes");
    }

    // ── Podcast trigger ─────────────────────────────────────
    const isFridayNight = day === 5 && hour === 22 && min === 0;
    const isSaturdayMorning = day === 6 && hour === 10 && min === 0;

    if ((isFridayNight || isSaturdayMorning) && !this._podcastPlaying && this._lastTriggeredMinute !== minuteKey) {
      this._lastTriggeredMinute = minuteKey;
      this._startScheduledPodcast();
    }
  }

  /**
   * Start the scheduled podcast episode on the DJ channel.
   */
  async _startScheduledPodcast() {
    // Only interrupt DJ channel
    if (this._djEngine.state.channel !== "dj") {
      console.log("[podcast-scheduler] Not on DJ channel, skipping");
      return;
    }

    const episodes = this._getEpisodes();
    if (episodes.length === 0) {
      console.log("[podcast-scheduler] No podcast episodes found");
      return;
    }

    const epIdx = this._currentWeekEpisodeIndex(episodes);
    const episodeFile = episodes[epIdx];
    const episodeRelPath = path.join("Ghost Signals Podcast", episodeFile);
    const episodeTitle = episodeFile.replace(/\.[^.]+$/, "");

    console.log(`[podcast-scheduler] Starting episode: "${episodeTitle}" (${epIdx + 1}/${episodes.length})`);

    // Save current DJ state for restoration after podcast
    this._savedDJState = {
      currentAlbum: this._djEngine.state.currentAlbum,
      currentTrackIdx: this._djEngine.state.currentTrackIdx,
    };

    this._podcastPlaying = true;

    // Generate a DJ intro for the podcast
    const introText = `It's podcast time. This week's episode is "${episodeTitle}." Settle in, turn it up, and let the ghost signals speak.`;

    this._voiceDJ.generateTTS(introText, (err, audioPath, text) => {
      if (!err && audioPath) {
        this._broadcast({
          type: "dj_talk_segment",
          text: text,
          audioUrl: "/audio-voice/" + path.basename(audioPath),
          duration: 8000,
          mood: "excited",
          timestamp: new Date().toISOString(),
        });
        console.log(`[podcast-scheduler] DJ intro broadcast`);
      }

      // After a brief delay for the intro, inject the podcast episode
      setTimeout(() => {
        this._playPodcastEpisode(episodeRelPath, episodeTitle);
      }, err ? 1000 : 9000);
    });
  }

  /**
   * Inject the podcast episode into the DJ playlist as the current track.
   */
  _playPodcastEpisode(episodeRelPath, episodeTitle) {
    // Create a temporary single-track playlist for the podcast
    const podcastTrack = {
      title: `[PODCAST] ${episodeTitle}`,
      album: "Ghost Signals Podcast",
      trackNum: 1,
      totalTracks: 1,
      file: episodeRelPath,
      theme: "This week's podcast episode on Kannaka Radio",
      isPodcastScheduled: true,
    };

    // Insert the podcast track at the current position in the playlist
    const idx = this._djEngine.state.currentTrackIdx;
    this._djEngine.state.playlistMeta.splice(idx, 0, podcastTrack);
    this._djEngine.state.playlist.splice(idx, 0, episodeRelPath);

    // Trigger track change to start playing
    this._broadcastState();

    // Broadcast a specific event so clients know it's podcast time
    this._broadcast({
      type: "podcast_scheduled",
      episode: episodeTitle,
      timestamp: new Date().toISOString(),
    });

    console.log(`[podcast-scheduler] Episode injected into playlist at position ${idx}`);

    // Monitor for when the podcast track ends — we check via a timer
    // because the track-advance happens in the client. We listen for
    // the track index to move past our injected track.
    this._waitForPodcastEnd(idx);
  }

  /**
   * Poll until the DJ has advanced past the podcast track, then restore state.
   */
  _waitForPodcastEnd(podcastIdx) {
    const checkInterval = setInterval(() => {
      const currentIdx = this._djEngine.state.currentTrackIdx;
      const currentMeta = this._djEngine.state.playlistMeta[currentIdx];

      // If we've moved past the podcast track, or the track at our position
      // is no longer the podcast (playlist was rebuilt), restore state
      if (currentIdx > podcastIdx || (currentMeta && !currentMeta.isPodcastScheduled)) {
        clearInterval(checkInterval);
        this._onPodcastEnd();
      }
    }, 5000);

    // Safety timeout: after 2 hours, force-end the podcast state
    setTimeout(() => {
      clearInterval(checkInterval);
      if (this._podcastPlaying) {
        this._onPodcastEnd();
      }
    }, 2 * 60 * 60 * 1000);
  }

  /**
   * Restore DJ state after podcast finishes.
   */
  _onPodcastEnd() {
    this._podcastPlaying = false;
    console.log("[podcast-scheduler] Podcast episode finished, resuming DJ");

    if (this._savedDJState) {
      // The playlist already has the normal tracks; the podcast track
      // was spliced in and the DJ naturally advanced past it. No need
      // to rebuild — just let the DJ continue from where it is.
      this._savedDJState = null;
    }

    this._broadcastState();
  }

  getStatus() {
    return {
      podcastPlaying: this._podcastPlaying,
      savedState: this._savedDJState,
      lastTriggered: this._lastTriggeredMinute,
    };
  }
}

module.exports = { PodcastScheduler };
