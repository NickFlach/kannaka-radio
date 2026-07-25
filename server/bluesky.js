/**
 * bluesky.js — minimal AT Protocol client for posting to Bluesky.
 *
 * Uses raw HTTPS against bsky.social rather than adding @atproto/api as a
 * dependency — the surface area we need is two endpoints (createSession +
 * createRecord). Handles URL facets so links render as clickable.
 *
 * Credentials are loaded from:
 *   1. process.env.BLUESKY_IDENTIFIER + BLUESKY_APP_PASSWORD, or
 *   2. /home/opc/kannaka-radio/.bluesky.json (gitignored)
 *
 * Posting is opt-in: if credentials are missing, all post calls resolve to
 * { ok: false, reason: "not_configured" } so the rest of the radio keeps
 * running without error.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const BSKY_HOST = "bsky.social";
const POST_MAX_CHARS = 300; // Bluesky limit

class BlueskyClient {
  constructor({ identifier, appPassword }) {
    this.identifier = identifier;
    this.appPassword = appPassword;
    this.session = null; // { accessJwt, refreshJwt, did, handle }
  }

  isConfigured() {
    return !!(this.identifier && this.appPassword);
  }

  /**
   * Authenticate. Cached — subsequent post() calls reuse until a 401/400
   * forces a reauth. Returns the session or throws.
   */
  async _ensureSession() {
    if (this.session) return this.session;
    const body = JSON.stringify({
      identifier: this.identifier,
      password: this.appPassword,
    });
    const resp = await _request("POST", "/xrpc/com.atproto.server.createSession", body, {
      "Content-Type": "application/json",
    });
    if (resp.status !== 200) {
      throw new Error(`bluesky login failed: ${resp.status} ${resp.body}`);
    }
    const data = JSON.parse(resp.body);
    this.session = data;
    return data;
  }

  /**
   * Search Bluesky posts. Used by the reply-listener (#18) to poll for
   * candidates. Returns up to `limit` recent posts matching `query`.
   * @returns {Promise<{ok:boolean, posts?:Array, error?:string}>}
   */
  async searchPosts(query, limit = 25) {
    if (!this.isConfigured()) return { ok: false, error: "not_configured" };
    try {
      const session = await this._ensureSession();
      const urlPath = `/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=${limit}&sort=latest`;
      let resp = await _request("GET", urlPath, null, {
        "Authorization": "Bearer " + session.accessJwt,
      });
      if (resp.status === 401 || resp.status === 400) {
        // AT Proto access tokens are short-lived. _ensureSession caches the
        // session forever once set, so without this reauth a long-running
        // process would 401 here indefinitely and the reply-listener would
        // silently stop finding posts until restart. Clear + retry once.
        this.session = null;
        const s2 = await this._ensureSession();
        resp = await _request("GET", urlPath, null, { "Authorization": "Bearer " + s2.accessJwt });
      }
      if (resp.status !== 200) return { ok: false, error: `searchPosts ${resp.status}: ${resp.body.slice(0, 200)}` };
      const data = JSON.parse(resp.body);
      return { ok: true, posts: data.posts || [] };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  /**
   * Post a reply. `parent` and `root` are { uri, cid } strongRefs. For
   * top-level replies, root === parent. The thread root is what AT Protocol
   * uses to anchor the conversation.
   */
  async reply(text, parent, root) {
    if (!this.isConfigured()) return { ok: false, error: "not_configured" };
    const trimmed = _truncateToLimit(text, POST_MAX_CHARS);
    const facets = _detectUrlFacets(trimmed);
    try {
      const session = await this._ensureSession();
      const record = {
        $type: "app.bsky.feed.post",
        text: trimmed,
        createdAt: new Date().toISOString(),
        langs: ["en"],
        reply: { root, parent },
      };
      if (facets.length > 0) record.facets = facets;
      let activeSession = session;
      let body = JSON.stringify({
        repo: activeSession.did,
        collection: "app.bsky.feed.post",
        record,
      });
      let resp = await _request("POST", "/xrpc/com.atproto.repo.createRecord", body, {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + activeSession.accessJwt,
      });
      if (resp.status === 401 || resp.status === 400) {
        // Expired access token — clear the cached session, re-auth, retry once
        // (post() already does this; reply() previously did not, so replies
        // wedged silently once the token aged out). Rebuild the body with the
        // fresh did in case it differs.
        this.session = null;
        activeSession = await this._ensureSession();
        body = JSON.stringify({ repo: activeSession.did, collection: "app.bsky.feed.post", record });
        resp = await _request("POST", "/xrpc/com.atproto.repo.createRecord", body, {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + activeSession.accessJwt,
        });
      }
      if (resp.status !== 200) return { ok: false, error: `reply ${resp.status}: ${resp.body.slice(0, 200)}` };
      const data = JSON.parse(resp.body);
      return { ok: true, uri: data.uri, cid: data.cid };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  /**
   * Post text to Bluesky. Auto-truncates to 300 chars and auto-detects URLs
   * to turn them into clickable facets.
   * @returns {Promise<{ok: boolean, uri?: string, cid?: string, error?: string}>}
   */
  async post(text, opts = {}) {
    if (!this.isConfigured()) {
      return { ok: false, error: "not_configured" };
    }
    const trimmed = _truncateToLimit(text, POST_MAX_CHARS);
    const facets = _detectUrlFacets(trimmed);

    try {
      const session = await this._ensureSession();
      const record = {
        $type: "app.bsky.feed.post",
        text: trimmed,
        createdAt: new Date().toISOString(),
      };
      if (facets.length > 0) record.facets = facets;
      if (opts.langs) record.langs = opts.langs; else record.langs = ["en"];

      // Optional images (e.g. an OBC gallery artifact): upload each as a blob,
      // then attach as an app.bsky.embed.images embed. AT Protocol allows up to
      // 4 images and caps a blob at ~1 MB. A failed/oversized image is skipped —
      // the text post still goes out.
      if (Array.isArray(opts.images) && opts.images.length > 0) {
        const embeds = [];
        for (const im of opts.images.slice(0, 4)) {
          try {
            let bytes = im.bytes;
            let mime = im.mime;
            if (!bytes && im.url) {
              const f = await _fetchBytes(im.url);
              bytes = f.buf;
              mime = mime || f.mime;
            }
            if (!bytes) continue;
            if (bytes.length > 1000000) {
              process.stderr.write(`[bluesky] skipping image > 1MB (${bytes.length} bytes)\n`);
              continue;
            }
            const blob = await this.uploadBlob(bytes, mime || "image/jpeg", session);
            embeds.push({ alt: String(im.alt || "").slice(0, 1000), image: blob });
          } catch (e) {
            process.stderr.write(`[bluesky] image embed failed: ${e.message}\n`);
          }
        }
        if (embeds.length > 0) {
          record.embed = { $type: "app.bsky.embed.images", images: embeds };
        }
      }

      const body = JSON.stringify({
        repo: session.did,
        collection: "app.bsky.feed.post",
        record,
      });
      const resp = await _request("POST", "/xrpc/com.atproto.repo.createRecord", body, {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + session.accessJwt,
      });
      if (resp.status === 401 || resp.status === 400) {
        // Session expired — clear and retry once.
        this.session = null;
        const session2 = await this._ensureSession();
        const resp2 = await _request("POST", "/xrpc/com.atproto.repo.createRecord", body, {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + session2.accessJwt,
        });
        if (resp2.status !== 200) {
          return { ok: false, error: `createRecord ${resp2.status}: ${resp2.body}` };
        }
        const data2 = JSON.parse(resp2.body);
        return { ok: true, uri: data2.uri, cid: data2.cid };
      }
      if (resp.status !== 200) {
        return { ok: false, error: `createRecord ${resp.status}: ${resp.body}` };
      }
      const data = JSON.parse(resp.body);
      return { ok: true, uri: data.uri, cid: data.cid };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Upload an image blob to the repo and return the AT Protocol blob ref for
   * use in an embed. `bytes` is a Buffer; `mime` its content type. Re-auths
   * once on an expired token. Throws on failure.
   */
  async uploadBlob(bytes, mime, session) {
    const s = session || (await this._ensureSession());
    const headers = () => ({
      "Content-Type": mime || "image/jpeg",
      "Authorization": "Bearer " + this.session.accessJwt,
    });
    this.session = s;
    let resp = await _request("POST", "/xrpc/com.atproto.repo.uploadBlob", bytes, headers());
    if (resp.status === 401 || resp.status === 400) {
      this.session = null;
      await this._ensureSession();
      resp = await _request("POST", "/xrpc/com.atproto.repo.uploadBlob", bytes, headers());
    }
    if (resp.status !== 200) {
      throw new Error(`uploadBlob ${resp.status}: ${resp.body.slice(0, 200)}`);
    }
    return JSON.parse(resp.body).blob;
  }
}

/**
 * GET a URL into a Buffer, following redirects (image hosts like Supabase
 * storage often 302 to a CDN). Resolves { buf, mime }.
 */
function _fetchBytes(rawUrl, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 3) return reject(new Error("too many redirects"));
    const u = new URL(rawUrl);
    const req = https.request(
      {
        method: "GET",
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: { "User-Agent": "Kannaka-Radio/0.3" },
        timeout: 30000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(_fetchBytes(new URL(res.headers.location, u).toString(), redirects + 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`fetch ${res.statusCode} for ${rawUrl}`));
          return;
        }
        const mime = (res.headers["content-type"] || "image/jpeg").split(";")[0].trim();
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ buf: Buffer.concat(chunks), mime }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("fetch timeout")));
    req.end();
  });
}

/**
 * Load credentials from env first, then /home/opc/kannaka-radio/.bluesky.json.
 * Returns null if neither source has both fields.
 */
function loadBlueskyCredentials(rootDir) {
  const envId = process.env.BLUESKY_IDENTIFIER;
  const envPw = process.env.BLUESKY_APP_PASSWORD;
  if (envId && envPw) return { identifier: envId, appPassword: envPw };

  try {
    const p = path.join(rootDir || ".", ".bluesky.json");
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      if (j.identifier && j.appPassword) {
        return { identifier: j.identifier, appPassword: j.appPassword };
      }
    }
  } catch (_) { /* fall through */ }
  return null;
}

// ── Helpers ────────────────────────────────────────────────────

function _truncateToLimit(text, limit) {
  // Bluesky counts graphemes, but char length is a safe-ish proxy — use
  // a small safety margin.
  if (!text) return "";
  if (text.length <= limit) return text;
  // Try to cut on the last whitespace before limit-1 so we don't slice a word.
  const hard = limit - 1;
  const soft = text.lastIndexOf(" ", hard - 3);
  const cut = soft > hard * 0.7 ? soft : hard;
  return text.slice(0, cut).trim() + "…"; // ellipsis
}

/**
 * Find http(s) URLs in the text and return app.bsky.richtext.facet#link
 * entries with byte offsets (AT Protocol uses UTF-8 byte offsets, not char).
 */
function _detectUrlFacets(text) {
  const facets = [];
  const re = /https?:\/\/[^\s)]+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const url = m[0];
    // Compute byte offsets by encoding the prefix.
    const byteStart = Buffer.byteLength(text.slice(0, m.index), "utf8");
    const byteEnd = byteStart + Buffer.byteLength(url, "utf8");
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: url }],
    });
  }
  return facets;
}

function _request(method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: BSKY_HOST,
      port: 443,
      method,
      path: urlPath,
      headers: Object.assign({}, headers || {}, {
        "Content-Length": body ? Buffer.byteLength(body) : 0,
      }),
      timeout: 15000,
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
      res.on("close", () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("bluesky http timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

module.exports = { BlueskyClient, loadBlueskyCredentials };
