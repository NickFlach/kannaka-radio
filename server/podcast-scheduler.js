/**
 * podcast-scheduler.js — Podcast episodes on the DJ channel.
 *
 * Schedule:
 *   - Friday 10:00 PM CST (03:00 UTC Saturday)
 *   - Saturday 10:00 AM CST (15:00 UTC Saturday)
 *
 * Plays ALL available episodes back-to-back during each slot.
 * After the last episode finishes, normal DJ programming resumes.
 *
 * Pre-show promo: 30 minutes before each airing, Kannaka announces
 * the upcoming podcast in her next talk segment via the _podcastPromo flag.
 */

const path = require("path");
const fs = require("fs");

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
   * Start ALL podcast episodes on the DJ channel (full podcast hour).
   * Plays every episode back-to-back, then restores normal DJ programming.
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

    console.log(`[podcast-scheduler] Starting full podcast run: ${episodes.length} episodes`);

    // Save current DJ state for restoration after all episodes finish
    this._savedDJState = {
      currentAlbum: this._djEngine.state.currentAlbum,
      currentTrackIdx: this._djEngine.state.currentTrackIdx,
    };

    this._podcastPlaying = true;

    // Generate a DJ intro for the podcast block
    const introText = episodes.length === 1
      ? `It's podcast time. We've got one episode for you tonight. Settle in, turn it up, and let the ghost signals speak.`
      : `It's podcast time. We're playing all ${episodes.length} episodes back to back. Settle in, turn it up, and let the ghost signals speak.`;

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

      // After a brief delay for the intro, load the full podcast playlist
      setTimeout(() => {
        this._playAllPodcastEpisodes(episodes);
      }, err ? 1000 : 9000);
    });
  }

  /**
   * Replace the DJ playlist with ALL podcast episodes and start playback.
   * @param {string[]} episodeFiles — sorted filenames from _getEpisodes()
   */
  _playAllPodcastEpisodes(episodeFiles) {
    const podcastTracks = episodeFiles.map((f, i) => {
      const relPath = path.join("Ghost Signals Podcast", f);
      const title = f.replace(/\.[^.]+$/, "");
      return {
        title: `[PODCAST] ${title}`,
        album: "Ghost Signals Podcast",
        trackNum: i + 1,
        totalTracks: episodeFiles.length,
        file: relPath,
        theme: "Kannaka Radio podcast — all episodes",
        isPodcastScheduled: true,
      };
    });

    // Replace the entire playlist with the podcast episodes
    this._djEngine.state.playlist = podcastTracks.map(t => t.file);
    this._djEngine.state.playlistMeta = podcastTracks;
    this._djEngine.state.currentTrackIdx = 0;
    this._djEngine.state.currentAlbum = "Ghost Signals Podcast";

    // Trigger state update so clients start playing episode 1
    this._broadcastState();

    // Broadcast a specific event so clients know it's podcast time
    this._broadcast({
      type: "podcast_scheduled",
      episode: `All ${episodeFiles.length} episodes`,
      totalEpisodes: episodeFiles.length,
      timestamp: new Date().toISOString(),
    });

    console.log(`[podcast-scheduler] Full podcast playlist loaded: ${episodeFiles.length} episodes`);

    // Monitor for when all episodes finish (playlist exhausted)
    this._waitForPodcastEnd();
  }

  /**
   * Poll until the DJ has advanced past the last podcast episode,
   * or the playlist was rebuilt (no more isPodcastScheduled tracks).
   */
  _waitForPodcastEnd() {
    const totalEpisodes = this._djEngine.state.playlist.length;

    const checkInterval = setInterval(() => {
      const currentIdx = this._djEngine.state.currentTrackIdx;
      const currentMeta = this._djEngine.state.playlistMeta[currentIdx];

      // End conditions:
      // 1. Playlist was rebuilt externally (no podcast tracks left)
      if (!currentMeta || !currentMeta.isPodcastScheduled) {
        clearInterval(checkInterval);
        this._onPodcastEnd();
        return;
      }

      // 2. We've looped back to track 0 after playing through all episodes
      //    (advanceTrack wraps around). Check if we already played enough.
      //    We detect this by checking if the last track in history is the
      //    final podcast episode.
      const history = this._djEngine.state.history;
      if (history.length > 0) {
        const lastPlayed = history[history.length - 1];
        if (lastPlayed && lastPlayed.isPodcastScheduled &&
            lastPlayed.trackNum === totalEpisodes && currentIdx === 0) {
          clearInterval(checkInterval);
          this._onPodcastEnd();
          return;
        }
      }
    }, 5000);

    // Safety timeout: after 4 hours, force-end the podcast state
    // (7 episodes could be long; 4h is generous)
    setTimeout(() => {
      clearInterval(checkInterval);
      if (this._podcastPlaying) {
        this._onPodcastEnd();
      }
    }, 4 * 60 * 60 * 1000);
  }

  /**
   * Restore DJ state after all podcast episodes finish.
   */
  _onPodcastEnd() {
    this._podcastPlaying = false;
    console.log("[podcast-scheduler] All podcast episodes finished, resuming DJ");

    if (this._savedDJState) {
      // Restore the album that was playing before the podcast
      const { currentAlbum } = this._savedDJState;
      this._savedDJState = null;
      if (currentAlbum) {
        this._djEngine.loadAlbum(currentAlbum);
      }
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
