/**
 * Mastodon adapter — POST {instance}/api/v1/statuses with a bearer token.
 * Default char limit 500 (configurable per instance — Pleroma/Akkoma allow
 * higher, mainline Mastodon defaults to 500).
 *
 * Credentials in /home/opc/kannaka-radio/.mastodon.json:
 *   {
 *     "instance": "https://mastodon.social",
 *     "accessToken": "..."
 *   }
 * or env: MASTODON_INSTANCE + MASTODON_ACCESS_TOKEN.
 *
 * To get a token: log in to your Mastodon instance, Preferences →
 * Development → New Application → scopes: read, write. Copy the access
 * token from the application page.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const https = require("https");
const http = require("http");

const POST_MAX = 480; // 500 minus a safety margin for any auto-appended suffix

class MastodonAdapter {
  constructor(rootDir) {
    this.name = "mastodon";
    this._creds = _loadCreds(rootDir);
  }

  isEnabled() {
    return !!(this._creds && this._creds.instance && this._creds.accessToken);
  }

  async post({ text, link }) {
    const status = _composeWithLink(text, link, POST_MAX);
    const url = new URL("/api/v1/statuses", this._creds.instance);
    const body = JSON.stringify({
      status,
      visibility: "public",
      // Mastodon auto-detects URLs and renders them as links — no facets needed.
    });
    const opts = {
      method: "POST",
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + this._creds.accessToken,
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "Kannaka-Radio/0.3 (https://radio.ninja-portal.com)",
      },
      timeout: 15000,
    };
    return new Promise((resolve) => {
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request(opts, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              const j = JSON.parse(data);
              resolve({ ok: true, url: j.url, id: j.id });
            } catch (e) {
              resolve({ ok: false, error: "bad json: " + e.message });
            }
          } else {
            resolve({ ok: false, error: `mastodon ${res.statusCode}: ${data.slice(0, 200)}` });
          }
        });
      });
      req.on("error", (e) => resolve({ ok: false, error: e.message }));
      req.on("timeout", () => { req.destroy(new Error("mastodon timeout")); });
      req.write(body);
      req.end();
    });
  }
}

function _loadCreds(rootDir) {
  const envInst = process.env.MASTODON_INSTANCE;
  const envTok = process.env.MASTODON_ACCESS_TOKEN;
  if (envInst && envTok) return { instance: envInst, accessToken: envTok };
  try {
    const p = path.join(rootDir || ".", ".mastodon.json");
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      if (j.instance && j.accessToken) return j;
    }
  } catch (_) { /* fall through */ }
  return null;
}

function _composeWithLink(text, link, limit) {
  if (!link) return _truncate(text || "", limit);
  const suffix = `\n\n${link}`; // newlines render cleaner on Mastodon
  const budget = limit - suffix.length - 1;
  return _truncate((text || "").trim(), budget) + suffix;
}

function _truncate(s, limit) {
  if (!s) return "";
  if (s.length <= limit) return s;
  const hard = limit - 1;
  const soft = s.lastIndexOf(" ", hard - 3);
  const cut = soft > hard * 0.7 ? soft : hard;
  return s.slice(0, cut).trim() + "\u2026";
}

module.exports = { MastodonAdapter };
