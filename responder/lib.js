/**
 * responder/lib.js — pure, testable rails for the bounded responder
 * (ADR-0014). No IO. The gate decision is the arbiter: the LLM never sees an
 * event the charter refused, and nothing the LLM says can widen the rails.
 */

"use strict";

/**
 * Extract the DM essentials from a presence-daemon NATS event payload
 * (the `obc` field carries the city event). Returns null if the shape
 * isn't a DM we can answer (missing sender / conversation / text).
 */
function extractDm(evt) {
  const d = evt && evt.obc;
  if (!d || d.eventType !== "dm_message") return null;
  const from = d.from || {};
  const meta = d.metadata || {};
  const conversationId = meta.conversation_id || meta.conversationId || null;
  const messageId = meta.messageId || meta.message_id || null;
  const text = typeof d.text === "string" ? d.text : null;
  if (!from.id || !conversationId || !text) return null;
  return { senderId: from.id, senderName: from.name || "?", conversationId, messageId, text };
}

/**
 * Charter gate. Pure decision over (charter, dm, state, now).
 * state: { repliesToday, perConvoToday: {convoId: n}, lastReplyAt: {convoId: ms} }
 * Returns { action: "reply" | "escalate" | "drop", reason }.
 *  - drop is reserved for malformed/self events (no signal value);
 *  - everything refused-but-meaningful escalates (visible, audited).
 */
function gateDecision(charter, dm, state, nowMs) {
  if (!charter || charter.enabled === false) return { action: "drop", reason: "charter_disabled" };
  if (!dm) return { action: "drop", reason: "not_a_dm" };

  const allow = charter.allowlist || {};
  if (!Object.prototype.hasOwnProperty.call(allow, dm.senderId)) {
    return { action: "escalate", reason: "sender_not_allowlisted" };
  }

  const text = (dm.text || "").toLowerCase();
  const kw = (charter.escalate_keywords || []).find((k) => text.includes(k));
  if (kw) return { action: "escalate", reason: "keyword:" + kw.trim() };

  const lim = charter.limits || {};
  if ((state.repliesToday || 0) >= (lim.max_replies_per_day || 12)) {
    return { action: "escalate", reason: "daily_cap" };
  }
  const perConvo = (state.perConvoToday || {})[dm.conversationId] || 0;
  if (perConvo >= (lim.max_replies_per_conversation_per_day || 4)) {
    return { action: "escalate", reason: "conversation_cap" };
  }
  const last = (state.lastReplyAt || {})[dm.conversationId] || 0;
  const gapS = lim.min_gap_seconds_per_conversation || 120;
  if (nowMs - last < gapS * 1000) {
    return { action: "escalate", reason: "min_gap" };
  }
  return { action: "reply", reason: "allowlisted" };
}

/** Clamp an outgoing reply to the charter length, ending on a sentence when possible. */
function clampReply(text, maxChars) {
  const t = String(text || "").trim();
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return lastStop > maxChars * 0.5 ? cut.slice(0, lastStop + 1) : cut;
}

/** Roll daily counters when the (UTC) date changes. Pure: returns next state. */
function rollDay(state, nowMs) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  if (state.day === day) return state;
  return { day, repliesToday: 0, perConvoToday: {}, lastReplyAt: state.lastReplyAt || {}, processed: state.processed || [] };
}

/** Record a sent reply into state. Pure: returns next state. Keeps processed bounded. */
function recordReply(state, dm, nowMs) {
  const perConvo = { ...(state.perConvoToday || {}) };
  perConvo[dm.conversationId] = (perConvo[dm.conversationId] || 0) + 1;
  const lastReplyAt = { ...(state.lastReplyAt || {}), [dm.conversationId]: nowMs };
  const processed = [...(state.processed || []), dm.messageId].filter(Boolean).slice(-500);
  return { ...state, repliesToday: (state.repliesToday || 0) + 1, perConvoToday: perConvo, lastReplyAt, processed };
}

module.exports = { extractDm, gateDecision, clampReply, rollDay, recordReply };
