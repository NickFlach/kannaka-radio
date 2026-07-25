#!/usr/bin/env node
/**
 * youtube-check.js — verify the YouTube uploader OAuth is still live.
 *
 * The adapter's refresh token silently expires after ~7 days while the
 * Google OAuth consent screen is in "Testing" publishing status (an
 * unverified-app limitation). When that happens, uploads fail at token
 * refresh with `invalid_grant` ("Token has been expired or revoked"),
 * and — because the fan-out isolates per-adapter failures — nothing else
 * alerts. Run this to detect it early:
 *
 *   node scripts/youtube-check.js
 *
 * Exit 0 = live (also prints channel stats); exit 1 = expired/misconfigured.
 * Wire it into a cron / health probe so token expiry is visible, not silent.
 *
 * DURABLE FIX for the weekly expiry: in Google Cloud Console, publish the
 * OAuth consent screen ("Testing" -> "In production"), then re-run
 * scripts/youtube-grant.js once. Refresh tokens minted while the app is in
 * production status do not auto-expire for the app owner.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { URL } = require("url");

const CRED_PATH = path.join(path.resolve(__dirname, ".."), ".youtube.json");

function postForm(url, form) {
  const body = new URLSearchParams(form).toString();
  return request(url, "POST", { "Content-Type": "application/x-www-form-urlencoded" }, body);
}

function getJson(url, accessToken) {
  return request(url, "GET", { Authorization: `Bearer ${accessToken}` }, null);
}

function request(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { ...headers },
    };
    if (body != null) opts.headers["Content-Length"] = Buffer.byteLength(body);
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed;
        try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function main() {
  if (!fs.existsSync(CRED_PATH)) {
    console.error(`✗ ${CRED_PATH} not found — run: node scripts/youtube-grant.js`);
    process.exit(1);
  }
  let c;
  try { c = JSON.parse(fs.readFileSync(CRED_PATH, "utf8")); }
  catch (e) { console.error(`✗ ${CRED_PATH} unreadable: ${e.message}`); process.exit(1); }
  if (!c.client_id || !c.client_secret || !c.refresh_token) {
    console.error("✗ .youtube.json is missing client_id / client_secret / refresh_token");
    process.exit(1);
  }

  const tok = await postForm("https://oauth2.googleapis.com/token", {
    client_id: c.client_id,
    client_secret: c.client_secret,
    refresh_token: c.refresh_token,
    grant_type: "refresh_token",
  });

  if (tok.status !== 200 || !tok.body || !tok.body.access_token) {
    const desc = tok.body && tok.body.error_description
      ? tok.body.error_description
      : (typeof tok.body === "string" ? tok.body.slice(0, 200) : JSON.stringify(tok.body).slice(0, 200));
    console.error(`✗ OAUTH DEAD (${tok.status}): ${desc}`);
    console.error("  Fix: publish the OAuth consent screen to production in Google Cloud Console,");
    console.error("       then re-run: node scripts/youtube-grant.js");
    process.exit(1);
  }

  console.log(`✓ OAUTH LIVE — access token acquired (expires_in=${tok.body.expires_in}s)`);

  const ch = await getJson(
    "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true",
    tok.body.access_token,
  );
  const item = ch.body && ch.body.items && ch.body.items[0];
  if (item) {
    console.log(`  channel: "${item.snippet.title}" — subs ${item.statistics.subscriberCount}, videos ${item.statistics.videoCount}, views ${item.statistics.viewCount}`);
  } else {
    console.log(`  (channel stats unavailable: ${ch.status})`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
