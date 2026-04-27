/**
 * Bluesky adapter — wraps the existing BlueskyClient (server/bluesky.js)
 * in the Broadcaster interface. 300-char limit.
 *
 * Discoverability strategy (2026-04 algorithm reality):
 *   - Body URL is dropped. Bluesky's home-feed algo penalizes outbound
 *     links + the 300-char budget is too tight to spend on a URL.
 *   - 3-4 hashtags appended inline; Bluesky's facet system makes them
 *     clickable and surfaces them on hashtag-feed clients.
 */

"use strict";

const { BlueskyClient, loadBlueskyCredentials } = require("../bluesky");
const { tagsFor, composeForFeed } = require("./discovery");

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

  async post({ text, link, topic }) {
    // 4 tags max — Bluesky's facet rendering tolerates more, but readability
    // tanks past 4. The body shrinks to fit.
    const tags = tagsFor(topic, 4);
    const body = composeForFeed(text, tags, POST_MAX);
    return this._client.post(body);
  }
}

module.exports = { BlueskyAdapter };
