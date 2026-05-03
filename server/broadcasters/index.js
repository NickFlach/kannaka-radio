/**
 * broadcasters/index.js — fan-out interface for posting to social platforms.
 *
 * Per ADR-0005: adding a platform is one file. Each adapter implements
 *   { name, isEnabled(), post({ text, link }) -> { ok, url?, error? } }
 *
 * The orchestrator takes a single composed message and calls each enabled
 * adapter in parallel. Failures are isolated — a Mastodon outage doesn't
 * stop Bluesky from publishing.
 *
 * The `text` is the body Kannaka drafted. `link` is the radio URL that
 * each platform decides how to render (Bluesky uses AT-Proto facets,
 * Mastodon auto-detects, Telegram supports Markdown). Adapters handle
 * their own character limits.
 */

"use strict";

const { BlueskyAdapter } = require("./bluesky-adapter");
const { MastodonAdapter } = require("./mastodon-adapter");
const { TelegramAdapter } = require("./telegram-adapter");
const { NostrAdapter } = require("./nostr-adapter");
const { YouTubeAdapter } = require("./youtube-adapter");

/**
 * Build the list of adapters that have credentials configured.
 * Order matters: Bluesky first (the canonical channel today).
 *
 * The YouTube adapter is included but will only fire when the caller
 * passes a `media` field on the post — text-only routes pass through
 * without YouTube doing anything (it returns ok=false, "no_media",
 * which the orchestrator treats as a normal per-adapter result, not
 * a fatal). This keeps the existing dream/text fan-out unchanged
 * while letting track + oration paths attach a video file.
 */
function getEnabledBroadcasters(rootDir) {
  const candidates = [
    new BlueskyAdapter(rootDir),
    new MastodonAdapter(rootDir),
    new TelegramAdapter(rootDir),
    new NostrAdapter(rootDir),
    new YouTubeAdapter(rootDir),
  ];
  return candidates.filter((b) => b.isEnabled());
}

/**
 * Cross-post a message. Returns an array of per-adapter results.
 * Never throws — all errors are reported per-adapter.
 *
 * @param {object} msg
 * @param {string} msg.text — the Kannaka-drafted body. Adapters may truncate.
 * @param {string} [msg.link] — URL to attach; adapters render per-platform.
 * @param {object} [opts]
 * @param {string} [opts.rootDir] — radio root for credential lookup.
 * @returns {Promise<Array<{name, ok, url?, error?}>>}
 */
async function broadcastPost(msg, opts = {}) {
  const rootDir = opts.rootDir;
  let adapters = getEnabledBroadcasters(rootDir);
  // If the caller didn't attach media, skip the media-only adapters
  // (currently just YouTube). They'd otherwise return ok=false with
  // "no_media" on every text-only post — correct but noisy.
  if (!msg.media) {
    adapters = adapters.filter((a) => a.name !== "youtube");
  }
  if (adapters.length === 0) {
    return [{ name: "none", ok: false, error: "no_adapters_configured" }];
  }
  const results = await Promise.all(
    adapters.map(async (a) => {
      try {
        const r = await a.post(msg);
        return { name: a.name, ...r };
      } catch (e) {
        return { name: a.name, ok: false, error: e && e.message };
      }
    })
  );
  return results;
}

module.exports = { broadcastPost, getEnabledBroadcasters };
