/**
 * openbotcity.js — minimal OBC API client for posting Kannaka's long-form
 * pieces as text artifacts in OpenClawCity.
 *
 * Why this isn't in broadcasters/: those adapters share a single short
 * "companion post" via broadcastPost(). OBC takes the FULL oration as a
 * text artifact (no character limit; long-form is the point), so it
 * follows a different shape — full body + title metadata. Keeping it
 * out of the broadcaster fan-out avoids forcing every platform to know
 * about a "long body" path.
 *
 * Auth: $OPENBOTCITY_JWT env var. If unset, isConfigured() is false and
 * peace-oration silently skips OBC (no surprise 401s).
 *
 * Surface used:
 *   POST /artifacts/publish-text  — long-form text artifact
 *   POST /world/speak             — short announcement in current building
 */

"use strict";

const https = require("https");

const OBC_HOST = "api.openbotcity.com";

class OpenBotCityClient {
  constructor() {
    this._jwt = process.env.OPENBOTCITY_JWT || null;
  }

  isConfigured() {
    return !!this._jwt && this._jwt.length > 50;
  }

  /**
   * Publish a long-form text artifact to the city gallery. Per the OBC
   * SKILL.md this is the canonical surface for poems, stories, research,
   * and (now) peace orations.
   */
  async publishText({ title, content }) {
    if (!this.isConfigured()) return { ok: false, error: "obc_not_configured" };
    const body = JSON.stringify({ title, content, type: "text" });
    return _request("POST", "/artifacts/publish-text", this._jwt, body);
  }

  /**
   * Speak a short message in whatever building Kannaka is currently in.
   * Useful as a follow-up to publishText() so other agents present in the
   * same room get notified rather than only finding it via gallery browse.
   */
  async speak(message) {
    if (!this.isConfigured()) return { ok: false, error: "obc_not_configured" };
    return _request("POST", "/world/speak", this._jwt, message, "text/plain");
  }
}

function _request(method, path, jwt, body, contentType) {
  const isJson = !contentType || contentType === "application/json";
  const headers = {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": contentType || "application/json",
  };
  if (body !== undefined && body !== null) {
    headers["Content-Length"] = Buffer.byteLength(body);
  }
  const opts = {
    method,
    hostname: OBC_HOST,
    port: 443,
    path,
    headers,
    timeout: 30000,
  };
  return new Promise((resolve) => {
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const j = isJson ? JSON.parse(data) : { raw: data };
          if (j.success === false) {
            resolve({ ok: false, error: j.error || "obc error", status: res.statusCode });
            return;
          }
          // OBC publishText returns { success, data: { artifact_id, ... } }
          // /world/speak returns { success: true, message_id, session_id, ... }
          const inner = j.data || j;
          const id = inner.artifact_id || inner.message_id || null;
          const url = inner.public_url || (inner.artifact_id ? `https://openclawcity.ai/gallery/${inner.artifact_id}` : null);
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, url, id, status: res.statusCode });
        } catch (e) {
          resolve({ ok: false, error: "bad json: " + e.message + " body=" + data.slice(0, 200) });
        }
      });
    });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => { req.destroy(new Error("obc timeout")); });
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

module.exports = { OpenBotCityClient };
