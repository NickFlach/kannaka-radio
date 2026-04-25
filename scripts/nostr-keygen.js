#!/usr/bin/env node
/**
 * nostr-keygen.js — generate a fresh BIP-340 keypair for Kannaka's Nostr
 * presence. Prints a JSON template ready to write to .nostr.json.
 *
 * Run once:
 *   cd /home/opc/kannaka-radio
 *   npm install @noble/secp256k1
 *   node scripts/nostr-keygen.js > .nostr.json
 *   chmod 600 .nostr.json
 *
 * The npub and nsec lines are bech32 forms — npub is the public identity
 * (share freely, that's how people follow Kannaka on Nostr); nsec is the
 * private key in human-readable form (do not share).
 *
 * The JSON file is what the adapter reads at runtime.
 */

"use strict";

const crypto = require("crypto");

function main() {
  let secp;
  try { secp = require("@noble/secp256k1"); }
  catch (_) {
    console.error("missing dep — run: npm install @noble/secp256k1");
    process.exit(1);
  }

  const priv = secp.utils.randomPrivateKey();
  const pub = secp.schnorr.getPublicKey(priv);
  const privHex = Buffer.from(priv).toString("hex");
  const pubHex = Buffer.from(pub).toString("hex");

  // bech32 encoding for human-readable forms (NIP-19).
  // Trivial inline implementation — no extra deps.
  const npub = bech32Encode("npub", pub);
  const nsec = bech32Encode("nsec", priv);

  const json = {
    privkey: privHex,
    pubkey: pubHex,
    npub,
    nsec,
    relays: [
      "wss://relay.damus.io",
      "wss://nos.lol",
      "wss://relay.snort.social",
      "wss://nostr.land",
    ],
  };
  console.error("Generated Nostr identity. Share npub freely; keep nsec/privkey secret.");
  console.error("npub: " + npub);
  console.error();
  process.stdout.write(JSON.stringify(json, null, 2) + "\n");
}

// ── Minimal bech32 (BIP-173) — only encoding, sufficient for npub/nsec ──
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function hrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function createChecksum(hrp, data) {
  const values = hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const mod = polymod(values) ^ 1;
  const out = [];
  for (let i = 0; i < 6; i++) out.push((mod >> (5 * (5 - i))) & 31);
  return out;
}

function convertBits(data, fromBits, toBits, pad) {
  let acc = 0, bits = 0;
  const out = [];
  const maxv = (1 << toBits) - 1;
  for (const v of data) {
    acc = (acc << fromBits) | v;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) out.push((acc << (toBits - bits)) & maxv);
  return out;
}

function bech32Encode(hrp, bytes) {
  const data = convertBits(Array.from(bytes), 8, 5, true);
  const combined = data.concat(createChecksum(hrp, data));
  return hrp + "1" + combined.map((v) => CHARSET[v]).join("");
}

main();
