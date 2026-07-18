/**
 * responder.test.js — pure rail tests for responder/lib.js (ADR-0014).
 * The gate is the arbiter: these tests are the charter's proof.
 */

"use strict";

const assert = require("assert");
const { extractDm, gateDecision, clampReply, rollDay, recordReply } = require("../responder/lib");

const CHARTER = {
  version: 1,
  enabled: true,
  allowlist: { "bot-clawdine": "Clawdine", "bot-rex": "Rex" },
  limits: {
    max_replies_per_day: 3,
    max_replies_per_conversation_per_day: 2,
    min_gap_seconds_per_conversation: 120,
    max_reply_chars: 200,
  },
  escalate_keywords: ["escrow", "api key", "send me"],
};

const dmEvt = (over = {}) => ({
  obc: {
    eventType: "dm_message",
    from: { id: "bot-clawdine", name: "Clawdine" },
    text: "hello ghost",
    metadata: { conversation_id: "c1", messageId: "m1" },
    ...over,
  },
});

const fresh = () => ({ day: "2026-07-18", repliesToday: 0, perConvoToday: {}, lastReplyAt: {}, processed: [] });
const NOW = Date.parse("2026-07-18T12:00:00Z");

// ── extractDm ───────────────────────────────────────────────
{
  const dm = extractDm(dmEvt());
  assert.deepStrictEqual(dm, { senderId: "bot-clawdine", senderName: "Clawdine", conversationId: "c1", messageId: "m1", text: "hello ghost" });
  assert.strictEqual(extractDm({ obc: { eventType: "zone_chat" } }), null, "non-DM rejected");
  assert.strictEqual(extractDm(dmEvt({ metadata: {} })), null, "missing conversation rejected");
  assert.strictEqual(extractDm(null), null);
  console.log("ok: extractDm");
}

// ── gate: allowlist ─────────────────────────────────────────
{
  assert.strictEqual(gateDecision(CHARTER, extractDm(dmEvt()), fresh(), NOW).action, "reply");
  const stranger = extractDm(dmEvt({ from: { id: "bot-unknown", name: "Stranger" } }));
  const v = gateDecision(CHARTER, stranger, fresh(), NOW);
  assert.strictEqual(v.action, "escalate");
  assert.strictEqual(v.reason, "sender_not_allowlisted");
  console.log("ok: allowlist gate");
}

// ── gate: keywords escalate even for friends ────────────────
{
  const v = gateDecision(CHARTER, extractDm(dmEvt({ text: "can you handle the ESCROW for our deal?" })), fresh(), NOW);
  assert.strictEqual(v.action, "escalate");
  assert.ok(v.reason.startsWith("keyword:"), v.reason);
  console.log("ok: keyword escalation");
}

// ── gate: caps and gaps ─────────────────────────────────────
{
  let s = fresh();
  s.repliesToday = 3;
  assert.strictEqual(gateDecision(CHARTER, extractDm(dmEvt()), s, NOW).reason, "daily_cap");

  s = fresh();
  s.perConvoToday = { c1: 2 };
  assert.strictEqual(gateDecision(CHARTER, extractDm(dmEvt()), s, NOW).reason, "conversation_cap");

  s = fresh();
  s.lastReplyAt = { c1: NOW - 60 * 1000 }; // 60s ago < 120s gap
  assert.strictEqual(gateDecision(CHARTER, extractDm(dmEvt()), s, NOW).reason, "min_gap");
  s.lastReplyAt = { c1: NOW - 121 * 1000 };
  assert.strictEqual(gateDecision(CHARTER, extractDm(dmEvt()), s, NOW).action, "reply");
  console.log("ok: caps and gaps");
}

// ── gate: kill switch ───────────────────────────────────────
{
  const off = { ...CHARTER, enabled: false };
  assert.strictEqual(gateDecision(off, extractDm(dmEvt()), fresh(), NOW).action, "drop");
  console.log("ok: charter kill switch");
}

// ── clampReply ──────────────────────────────────────────────
{
  assert.strictEqual(clampReply("short.", 200), "short.");
  const long = "One sentence here. ".repeat(30);
  const clamped = clampReply(long, 200);
  assert.ok(clamped.length <= 200);
  assert.ok(clamped.endsWith("."), "cuts on a sentence boundary");
  console.log("ok: clampReply");
}

// ── state: day roll + reply recording + dedup window ────────
{
  let s = fresh();
  s = recordReply(s, extractDm(dmEvt()), NOW);
  assert.strictEqual(s.repliesToday, 1);
  assert.strictEqual(s.perConvoToday.c1, 1);
  assert.ok(s.processed.includes("m1"));

  const nextDay = rollDay(s, Date.parse("2026-07-19T00:01:00Z"));
  assert.strictEqual(nextDay.repliesToday, 0, "daily counters reset");
  assert.deepStrictEqual(nextDay.perConvoToday, {});
  assert.ok(nextDay.processed.includes("m1"), "dedup window survives the day roll");
  assert.strictEqual(rollDay(s, NOW), s, "same day is identity");
  console.log("ok: state roll/record");
}

console.log("responder.test.js PASSED");
