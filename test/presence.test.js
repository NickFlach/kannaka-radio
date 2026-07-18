/**
 * presence.test.js — pure-logic tests for presence/lib.js (ADR-0013).
 * Offline: no network, no daemon boot.
 */

"use strict";

const assert = require("assert");
const {
  parseEnvFile,
  serializeEnvFile,
  jwtExp,
  auditEntry,
  verifyAuditChain,
  SSEParser,
  obcSubject,
} = require("../presence/lib");

// ── env file round-trip preserves structure ─────────────────
{
  const src = "# obc creds\nOPENBOTCITY_JWT=old.token.here\n\nOBC_API=https://api.openbotcity.com\n";
  const parsed = parseEnvFile(src);
  assert.strictEqual(parsed.vars.OPENBOTCITY_JWT, "old.token.here");
  assert.strictEqual(parsed.vars.OBC_API, "https://api.openbotcity.com");

  const out = serializeEnvFile(parsed, { OPENBOTCITY_JWT: "new.token.value" });
  assert.ok(out.includes("# obc creds"), "comment preserved");
  assert.ok(out.includes("OPENBOTCITY_JWT=new.token.value"), "jwt updated");
  assert.ok(out.includes("OBC_API=https://api.openbotcity.com"), "other var untouched");
  assert.ok(out.endsWith("\n"), "newline-terminated");

  // Round-trip with no updates is a fixpoint (modulo trailing newline).
  const again = serializeEnvFile(parseEnvFile(out), {});
  assert.strictEqual(again, out, "serialize∘parse is a fixpoint");
  console.log("ok: env file round-trip");
}

// ── appending a key absent from the file ────────────────────
{
  const out = serializeEnvFile(parseEnvFile("A=1\n"), { B: "2" });
  assert.ok(out.includes("A=1") && out.includes("B=2"), "new key appended");
  console.log("ok: env append");
}

// ── jwtExp decodes exp; tolerates garbage ───────────────────
{
  const payload = Buffer.from(JSON.stringify({ sub: "x", exp: 1808708590 })).toString("base64url");
  assert.strictEqual(jwtExp(`h.${payload}.s`), 1808708590);
  assert.strictEqual(jwtExp("not-a-jwt"), null);
  assert.strictEqual(jwtExp(`h.${Buffer.from("{}").toString("base64url")}.s`), null);
  console.log("ok: jwtExp");
}

// ── audit chain builds and verifies; tamper detected ────────
{
  const e1 = auditEntry("", { ts: "t1", action: "daemon_started", detail: { port: 8899 } });
  const e2 = auditEntry(e1.hash, { ts: "t2", action: "go_live", detail: { title: "x" } });
  const e3 = auditEntry(e2.hash, { ts: "t3", action: "end_live", detail: {} });
  assert.ok(verifyAuditChain([e1, e2, e3]), "intact chain verifies");

  const tampered = [e1, { ...e2, detail: { title: "FORGED" } }, e3];
  assert.ok(!verifyAuditChain(tampered), "tampered detail breaks the chain");
  assert.ok(!verifyAuditChain([e1, e3]), "removed link breaks the chain");
  console.log("ok: audit chain");
}

// ── SSE parser: multi-chunk, multi-line data, ids, comments ─
{
  const p = new SSEParser();
  let evs = p.feed("id: 41\nevent: dm\ndata: {\"type\":\"dm\",");
  assert.strictEqual(evs.length, 0, "incomplete block buffered");
  evs = p.feed("\"from\":\"rex\"}\n\n: keepalive comment\n\ndata: hello\ndata: world\n\n");
  assert.strictEqual(evs.length, 2);
  assert.strictEqual(evs[0].id, "41");
  assert.strictEqual(evs[0].event, "dm");
  assert.deepStrictEqual(JSON.parse(evs[0].data), { type: "dm", from: "rex" });
  assert.strictEqual(evs[1].data, "hello\nworld", "multi-line data joined");
  assert.strictEqual(p.lastEventId, "41", "lastEventId tracked");

  // CRLF framing
  const p2 = new SSEParser();
  const crlf = p2.feed("id: 7\r\ndata: x\r\n\r\n");
  assert.strictEqual(crlf.length, 1);
  assert.strictEqual(crlf[0].id, "7");
  console.log("ok: SSE parser");
}

// ── obcSubject sanitizes hostile event names ────────────────
{
  assert.strictEqual(obcSubject("dm"), "KANNAKA.events.obc.dm");
  assert.strictEqual(obcSubject("Mention"), "KANNAKA.events.obc.mention");
  assert.strictEqual(obcSubject("a.b>c *"), "KANNAKA.events.obc.a_b_c__");
  assert.strictEqual(obcSubject(""), "KANNAKA.events.obc.message");
  assert.strictEqual(obcSubject(undefined), "KANNAKA.events.obc.message");
  const long = obcSubject("x".repeat(200));
  assert.ok(long.length <= "KANNAKA.events.obc.".length + 64, "leaf capped");
  console.log("ok: obcSubject sanitization");
}

console.log("presence.test.js PASSED");
