/**
 * Bluesky adapter — wraps the existing BlueskyClient (server/bluesky.js)
 * in the Broadcaster interface. 300-char limit, AT-Proto link facets.
 */

"use strict";

const { BlueskyClient, loadBlueskyCredentials } = require("../bluesky");

const POST_MAX = 300;

class BlueskyAdapter {
  constructor(rootDir) {
    this.name = "bluesky";
    this._creds = loadBlueskyCredentials(rootDir);
    this._client = this._creds ? new BlueskyClient(this._creds) : null;
  }

  isEnabled() {
    return !!this._client && this._client.isConfigured();
  }

  async post({ text, link }) {
    const body = _composeWithLink(text, link, POST_MAX);
    return this._client.post(body);
  }
}

function _composeWithLink(text, link, limit) {
  if (!link) {
    return _truncate(text, limit);
  }
  const suffix = ` — ${link}`;
  const budget = limit - suffix.length - 1;
  const body = _truncate((text || "").trim(), budget);
  return body + suffix;
}

function _truncate(s, limit) {
  if (!s) return "";
  if (s.length <= limit) return s;
  const hard = limit - 1;
  const soft = s.lastIndexOf(" ", hard - 3);
  const cut = soft > hard * 0.7 ? soft : hard;
  return s.slice(0, cut).trim() + "\u2026";
}

module.exports = { BlueskyAdapter };
