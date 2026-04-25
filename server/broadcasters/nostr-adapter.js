/**
 * Nostr adapter — publishes a kind-1 (text note) event to multiple relays.
 *
 * NIP-01 reference: https://github.com/nostr-protocol/nips/blob/master/01.md
 *
 * Wire format (after BIP-340 schnorr signing):
 *   {
 *     "id":        <sha256 of serialized event>,
 *     "pubkey":    <hex 32-byte public key>,
 *     "created_at": <unix timestamp>,
 *     "kind":      1,
 *     "tags":      [["r", "<radio url>"]]   // optional reference tag
 *     "content":   <text>,
 *     "sig":       <hex 64-byte schnorr signature>
 *   }
 *
 * The relays don't authenticate posts — anyone with a valid signature can
 * publish. The "account" is the keypair. Multiple relays are normal:
 * subscribers federate by listening to several, so we publish to several
 * for reach.
 *
 * Credentials in /home/opc/kannaka-radio/.nostr.json:
 *   {
 *     "privkey": "<hex 32 bytes>",
 *     "relays": [
 *       "wss://relay.damus.io",
 *       "wss://nos.lol",
 *       "wss://relay.snort.social",
 *       "wss://nostr.land"
 *     ]
 *   }
 *
 * Generate a fresh keypair with: node scripts/nostr-keygen.js
 *
 * Dependencies:
 *   - `ws` (already in package.json — used by the radio's WebSocket server)
 *   - `@noble/secp256k1` — pure-JS BIP-340 schnorr. Add with:
 *       npm install @noble/secp256k1
 *     The adapter is dormant if the package isn't installed.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let _secp = null;
function _trySecp() {
  if (_secp !== null) return _secp;
  try {
    _secp = require("@noble/secp256k1");
    // v3 expects callers to install a SHA-256 implementation. Wire Node's
    // built-in crypto so the schnorr.sign path doesn't blow up with
    // "hashes.sha256 not set". Older v1/v2 ignore the assignment.
    if (_secp.hashes && !_secp.hashes.sha256) {
      _secp.hashes.sha256 = (msg) =>
        new Uint8Array(crypto.createHash("sha256").update(Buffer.from(msg)).digest());
    }
  } catch (_) {
    _secp = false;
  }
  return _secp;
}

let _WS = null;
function _tryWS() {
  if (_WS !== null) return _WS;
  try { _WS = require("ws"); } catch (_) { _WS = false; }
  return _WS;
}

const POST_MAX = 1000; // Nostr has no hard limit; relays often soft-cap at ~64KiB. Keep posts readable.
const PUBLISH_TIMEOUT_MS = 8000;

class NostrAdapter {
  constructor(rootDir) {
    this.name = "nostr";
    this._creds = _loadCreds(rootDir);
  }

  isEnabled() {
    if (!this._creds || !this._creds.privkey) return false;
    if (!Array.isArray(this._creds.relays) || this._creds.relays.length === 0) return false;
    if (!_trySecp() || !_tryWS()) return false;
    return true;
  }

  async post({ text, link }) {
    if (!this.isEnabled()) return { ok: false, error: "not_configured" };
    const secp = _trySecp();
    const WS = _tryWS();

    const content = _composeWithLink(text, link, POST_MAX);
    const tags = link ? [["r", link]] : [];
    const created_at = Math.floor(Date.now() / 1000);

    const privkey = _hexToBytes(this._creds.privkey);
    const pubkey = _bytesToHex(secp.schnorr.getPublicKey(privkey));

    const serialized = JSON.stringify([
      0, pubkey, created_at, 1, tags, content,
    ]);
    const idBytes = crypto.createHash("sha256").update(serialized).digest();
    const id = _bytesToHex(idBytes);
    const sig = _bytesToHex(await secp.schnorr.sign(idBytes, privkey));

    const event = { id, pubkey, created_at, kind: 1, tags, content, sig };

    // Publish to every relay; succeed if any relay accepts. Failures per
    // relay are normal (offline, permissioned, rate-limited) and not fatal.
    const results = await Promise.all(
      this._creds.relays.map((url) => _publishOne(WS, url, event))
    );
    const okCount = results.filter((r) => r.ok).length;
    if (okCount === 0) {
      return { ok: false, error: `all relays rejected: ${results.map((r) => r.error).join("; ")}` };
    }
    // The "URL" for a Nostr event isn't a single thing — clients render it.
    // Use a njump.me link as a reasonable canonical viewer.
    return {
      ok: true,
      url: `https://njump.me/${id}`,
      id,
      relays_accepted: okCount,
      relays_total: this._creds.relays.length,
    };
  }
}

function _publishOne(WS, url, event) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; try { ws.close(); } catch (_) {} resolve(r); } };
    let ws;
    try { ws = new WS(url, { handshakeTimeout: PUBLISH_TIMEOUT_MS }); }
    catch (e) { return resolve({ ok: false, error: `${url}: ${e.message}` }); }

    const t = setTimeout(() => finish({ ok: false, error: `${url}: timeout` }), PUBLISH_TIMEOUT_MS);

    ws.on("open", () => {
      try { ws.send(JSON.stringify(["EVENT", event])); }
      catch (e) { clearTimeout(t); finish({ ok: false, error: `${url}: send: ${e.message}` }); }
    });
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        // Relay reply shape: ["OK", <event_id>, <true|false>, <reason>]
        if (Array.isArray(msg) && msg[0] === "OK" && msg[1] === event.id) {
          clearTimeout(t);
          if (msg[2] === true) finish({ ok: true });
          else finish({ ok: false, error: `${url}: ${msg[3] || "rejected"}` });
        }
      } catch (_) { /* ignore noise */ }
    });
    ws.on("error", (e) => { clearTimeout(t); finish({ ok: false, error: `${url}: ${e.message}` }); });
    ws.on("close", () => { clearTimeout(t); finish({ ok: false, error: `${url}: closed before OK` }); });
  });
}

function _loadCreds(rootDir) {
  const envKey = process.env.NOSTR_PRIVKEY;
  const envRelays = process.env.NOSTR_RELAYS; // comma-separated
  if (envKey && envRelays) {
    return { privkey: envKey, relays: envRelays.split(",").map((s) => s.trim()).filter(Boolean) };
  }
  try {
    const p = path.join(rootDir || ".", ".nostr.json");
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      if (j.privkey && Array.isArray(j.relays)) return j;
    }
  } catch (_) { /* fall through */ }
  return null;
}

function _composeWithLink(text, link, limit) {
  if (!link) return _truncate(text || "", limit);
  const suffix = `\n\n${link}`;
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

function _hexToBytes(hex) {
  const clean = (hex || "").replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function _bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

module.exports = { NostrAdapter };
