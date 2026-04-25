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

/**
 * Build the list of adapters that have credentials configured.
 * Order matters: Bluesky first (the canonical channel today).
 */
function getEnabledBroadcasters(rootDir) {
  const candidates = [
    new BlueskyAdapter(rootDir),
    new MastodonAdapter(rootDir),
    new TelegramAdapter(rootDir),
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
  const adapters = getEnabledBroadcasters(rootDir);
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
