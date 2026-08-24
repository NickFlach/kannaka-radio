'use strict';

/**
 * A durable record of when each track last played.
 *
 * dj-engine already keeps `_recentlyPlayed`, but that ledger is trimmed to 24
 * hours on both load and write, because its job is the 12-hour no-repeat rule.
 * It therefore cannot answer the question "what has not played in a long
 * time?" — to it, a track played three months ago and a track that has never
 * played once look identical, and both look like nothing.
 *
 * This ledger answers exactly that question and nothing else. It never trims by
 * age, only by a generous entry cap, so "never played" stays distinguishable
 * from "played, but long ago" for as long as the station has a library.
 *
 * Deliberately separate from the no-repeat ledger rather than an extension of
 * it: the two have opposite retention needs, and merging them would mean one
 * of the two rules silently getting the other's window.
 */

const fs = require('fs');
const path = require('path');

/** Bounded so a runaway library cannot grow the file without limit. Well above
 *  any plausible library size (this station has ~680 files). */
const MAX_ENTRIES = 20000;

class PlayLedger {
  constructor(opts = {}) {
    this.filePath = opts.filePath || null;
    this._now = opts.now || (() => Date.now());
    /** file -> { last: ms, plays: n } */
    this.entries = new Map();
    this._load();
  }

  _load() {
    if (!this.filePath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      for (const [k, v] of Object.entries(raw || {})) {
        // Tolerate both the rich shape and a bare timestamp, so an older or
        // hand-edited file still loads instead of resetting every track to
        // "never played" — which would be indistinguishable from real data
        // and would quietly re-promote the whole library.
        if (typeof v === 'number') this.entries.set(k, { last: v, plays: 1 });
        else if (v && typeof v.last === 'number') {
          this.entries.set(k, { last: v.last, plays: Number(v.plays) || 1 });
        }
      }
    } catch { /* fresh ledger */ }
  }

  save() {
    if (!this.filePath) return false;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const obj = {};
      for (const [k, v] of this.entries) obj[k] = v;
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, this.filePath); // atomic; a torn ledger reads as empty
      return true;
    } catch { return false; }
  }

  /** Record a play. Returns the new entry. */
  markPlayed(file) {
    if (!file) return null;
    const prev = this.entries.get(file);
    const rec = { last: this._now(), plays: (prev ? prev.plays : 0) + 1 };
    this.entries.set(file, rec);
    if (this.entries.size > MAX_ENTRIES) {
      // Evict the oldest — they are the least useful to remember, since
      // anything that old already ranks as "long ago" on its own.
      const sorted = [...this.entries.entries()].sort((a, b) => a[1].last - b[1].last);
      for (let i = 0; i < sorted.length - MAX_ENTRIES; i++) this.entries.delete(sorted[i][0]);
    }
    this.save();
    return rec;
  }

  /** ms since epoch, or null when this file has never played. */
  lastPlayed(file) {
    const e = this.entries.get(file);
    return e ? e.last : null;
  }

  playCount(file) {
    const e = this.entries.get(file);
    return e ? e.plays : 0;
  }

  /**
   * Order files so the most-neglected come first: never-played (in stable
   * input order, so a shuffle upstream decides among equals), then
   * longest-since-played.
   */
  rankByNeglect(files) {
    const never = [];
    const played = [];
    for (const f of files) {
      const last = this.lastPlayed(f);
      if (last === null) never.push(f);
      else played.push([f, last]);
    }
    played.sort((a, b) => a[1] - b[1]);
    return [...never, ...played.map((p) => p[0])];
  }

  /** How many of these have never played — the headline the station cares about. */
  neverPlayedCount(files) {
    let n = 0;
    for (const f of files) if (this.lastPlayed(f) === null) n++;
    return n;
  }
}

module.exports = { PlayLedger, MAX_ENTRIES };
