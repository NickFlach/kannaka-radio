/**
 * vote-manager.js — Agent-curated playback via track voting.
 *
 * Agents (or users) cast votes for which track should play next.
 * A configurable time window collects votes; when it closes the
 * track with the most votes wins and is queued in the DJ engine.
 */

class VoteManager {
  constructor() {
    /** @type {Map<string, string>} agentId -> trackTitle */
    this.votes = new Map();
    /** @type {NodeJS.Timeout|null} active voting window timer */
    this.voteWindow = null;
    /** @type {function|null} callback(winner, tally) when window closes */
    this.onResult = null;
    /** @type {number|null} epoch-ms when the current window started */
    this.windowStartedAt = null;
    /** @type {number} duration of the current window in ms */
    this.windowDuration = 0;
  }

  // ── Voting ──────────────────────────────────────────────

  /**
   * Cast (or update) a vote.
   * @param {string} agentId  — unique voter identifier
   * @param {string} trackTitle — the track being voted for
   * @returns {{ accepted: boolean, totalVotes: number }}
   */
  castVote(agentId, trackTitle) {
    if (!agentId || !trackTitle) {
      return { accepted: false, totalVotes: this.votes.size };
    }
    this.votes.set(agentId, trackTitle);
    return { accepted: true, totalVotes: this.votes.size };
  }

  /**
   * Get the current tally as { trackTitle: count }.
   * @returns {Object<string, number>}
   */
  getTally() {
    const tally = {};
    for (const [, track] of this.votes) {
      tally[track] = (tally[track] || 0) + 1;
    }
    return tally;
  }

  /**
   * Determine the winner.  Ties are broken randomly.
   * @returns {string|null}
   */
  getWinner() {
    const tally = this.getTally();
    const entries = Object.entries(tally);
    if (entries.length === 0) return null;

    entries.sort((a, b) => b[1] - a[1]);
    const maxVotes = entries[0][1];
    const tied = entries.filter(e => e[1] === maxVotes);
    return tied[Math.floor(Math.random() * tied.length)][0];
  }

  // ── Window management ───────────────────────────────────

  /**
   * Open a voting window that resolves after `durationMs`.
   * Clears any previous votes.
   * @param {number}   durationMs
   * @param {function} callback — (winner: string|null, tally: object) => void
   */
  startWindow(durationMs, callback) {
    this.cancelWindow();          // cancel any existing window first
    this.votes.clear();
    this.onResult = callback;
    this.windowStartedAt = Date.now();
    this.windowDuration = durationMs;

    this.voteWindow = setTimeout(() => {
      const winner = this.getWinner();
      const tally = this.getTally();
      this.votes.clear();
      this.voteWindow = null;
      this.windowStartedAt = null;
      this.windowDuration = 0;
      if (this.onResult) this.onResult(winner, tally);
      this.onResult = null;
    }, durationMs);
  }

  /**
   * Cancel an active voting window without triggering the callback.
   */
  cancelWindow() {
    if (this.voteWindow) {
      clearTimeout(this.voteWindow);
      this.voteWindow = null;
    }
    this.windowStartedAt = null;
    this.windowDuration = 0;
    this.votes.clear();
  }

  // ── Status ──────────────────────────────────────────────

  /** @returns {boolean} */
  isActive() {
    return this.voteWindow !== null;
  }

  /**
   * Remaining time in the current voting window (ms), or 0.
   * @returns {number}
   */
  getRemainingMs() {
    if (!this.windowStartedAt) return 0;
    const elapsed = Date.now() - this.windowStartedAt;
    return Math.max(0, this.windowDuration - elapsed);
  }

  /** @returns {{ active: boolean, votes: number, tally: object, remainingMs: number }} */
  getStatus() {
    return {
      active: this.isActive(),
      votes: this.votes.size,
      tally: this.getTally(),
      remainingMs: this.getRemainingMs(),
    };
  }
}

module.exports = { VoteManager };
