/**
 * podcast-scheduler.js — Podcast episodes on the DJ channel.
 *
 * Schedule (2026-04-27 onward):
 *   - DAILY at 10:00 AM CST and 10:00 PM CST
 *   - One episode per day, rotating by day-of-week through the
 *     7 available episodes. Mon→ep[0], Tue→ep[1], ..., Sun→ep[6].
 *     If episode count != 7, falls back to (day-of-year % count).
 *   - Both the morning and evening airing on a given day play the
 *     SAME episode — second-chance replay.
 *
 * After the episode finishes, normal DJ programming resumes.
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
    console.log("[podcast-scheduler] Started — daily 10 AM + 10 PM CST, day-of-week rotation");
    this._timer = setInterval(() => this._tick(), 60000);
    // Run once immediately to catch restart-during-window
    this._tick();
  }

  /**
   * Pick today's episode index. JS Date#getDay returns 0=Sun..6=Sat.
   * We map Mon=0..Sun=6 so the work-week kicks the rotation off, but
   * any rotation works as long as it's deterministic per-day.
   *
   * If we have exactly 7 episodes, this gives one per day of week.
   * If the count differs, we fall back to (day-of-year % count) so
   * the rotation still cycles cleanly without re-airing the same
   * episode two days running.
   */
  _episodeIndexFor(chicago, episodeCount) {
    if (episodeCount <= 0) return 0;
    if (episodeCount === 7) {
      const jsDay = chicago.getDay();           // 0=Sun..6=Sat
      const monAligned = (jsDay + 6) % 7;        // 0=Mon..6=Sun
      return monAligned;
    }
    // Day-of-year for any other episode count.
    const start = new Date(chicago.getFullYear(), 0, 0);
    const diff = chicago - start;
    const dayOfYear = Math.floor(diff / 86400000);
    return ((dayOfYear % episodeCount) + episodeCount) % episodeCount;
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
    const hour = chicago.getHours();
    const min = chicago.getMinutes();
    const minuteKey = this._minuteKey(chicago);

    // ── Pre-show promo (30 min before each airing) ──────────
    // Daily: 9:30 AM (before 10 AM airing) + 9:30 PM (before 10 PM airing).
    const isPromoMorning = hour === 9 && min === 30;
    const isPromoEvening = hour === 21 && min === 30;

    if ((isPromoMorning || isPromoEvening) && this._lastPromoMinute !== minuteKey) {
      this._lastPromoMinute = minuteKey;
      this._voiceDJ._podcastPromo = true;
      console.log("[podcast-scheduler] Promo flag set — podcast in 30 minutes");
    }

    // ── Podcast trigger — daily 10 AM and 10 PM CST ─────────
    const isMorning = hour === 10 && min === 0;
    const isEvening = hour === 22 && min === 0;

    if ((isMorning || isEvening) && !this._podcastPlaying && this._lastTriggeredMinute !== minuteKey) {
      this._lastTriggeredMinute = minuteKey;
      this._startScheduledPodcast();
    }
  }

  /**
   * Start TODAY'S podcast episode on the DJ channel.
   *
   * One episode per slot, picked by day-of-week so the same episode
   * airs morning and evening (second-chance replay), and a different
   * episode the next day. After the episode finishes, normal DJ
   * programming resumes.
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

    const chicago = this._chicagoNow();
    const idx = this._episodeIndexFor(chicago, episodes.length);
    const todayEpisode = episodes[idx];
    const epTitle = todayEpisode.replace(/\.[^.]+$/, "");

    console.log(`[podcast-scheduler] Today's episode (idx ${idx}/${episodes.length}): ${epTitle}`);

    // Save current DJ state for restoration after the episode finishes
    this._savedDJState = {
      currentAlbum: this._djEngine.state.currentAlbum,
      currentTrackIdx: this._djEngine.state.currentTrackIdx,
    };

    this._podcastPlaying = true;

    // Friendly intro line — references the episode by its cleaned-up name.
    // The DJ engine's voice-dj already exists for richer intros; this is
    // the explicit "we're switching channels for the next half hour" cue.
    const introText = `It's podcast time. Today's episode: ${epTitle}. Settle in, turn it up, let the ghost signals speak.`;

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

      // After the intro plays out, load just today's one episode.
      setTimeout(() => {
        this._playAllPodcastEpisodes([todayEpisode]);
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
