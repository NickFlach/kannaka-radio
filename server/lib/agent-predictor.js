/**
 * agent-predictor.js — three constellation agents, each predicting whether
 * a just-played track will stay on the canonical reference album for its
 * phase. The market already exists (gsHub.createMarket fires per track in
 * onTrackChange); this module supplies the bets so reputation accumulates.
 *
 * The point isn't that these heuristics are smart — they're deliberately
 * distinct and DIFFERENT from each other so the constellation accrues a
 * track-record signal: over many tracks, who keeps being right? That
 * signal is the gradient LADDER would self-improve against.
 *
 * Smarter predictors (HRM recall on track titles, perception-tag agreement,
 * world-state correlation) replace these later — same interface.
 */

"use strict";

const crypto = require("crypto");

// Outcome 0 = "Yes, stays on canonical" (the question is phrased that way).
// Outcome 1 = "No, gets rotated out".
const YES = 0;
const NO = 1;

/**
 * kannaka-01 — the curator. Believes in the rotation it built. Earlier
 * tracks in the album list (lower trackNum) are more "spine" and more
 * likely to stay; later tracks are more rotational. Confidence = 1 - (idx/total).
 */
function predictKannakaPrime(trackMeta) {
  const total = trackMeta.totalTracks || 13;
  const idx = (trackMeta.trackNum || total) - 1;
  const confidence = Math.max(0.55, 1 - idx / total); // spine-first bias, floor at 55%
  return {
    trader_id: "kannaka-01",
    outcome: YES,
    shares: Math.round(confidence * 30) + 5,
    rationale: `curator: spine confidence ${(confidence * 100).toFixed(0)}% (track ${idx + 1}/${total})`,
  };
}

/**
 * kannaka-witness-01 — the external listener. No curatorial bias; goes by
 * a perception-stability heuristic. Track titles with shorter words / fewer
 * tokens tend to be more memorable and more likely to survive rotation;
 * very long titles are often experimental and rotate out. Until it has its
 * own HRM-grounded signal, this is the placeholder.
 */
function predictWitness(trackMeta) {
  const title = (trackMeta.title || "").trim();
  const wordCount = title.split(/\s+/).filter(Boolean).length;
  // 2-4 words = peak survival; outside that = lower confidence.
  const fit = wordCount >= 2 && wordCount <= 4 ? 0.7 : 0.45;
  const outcome = fit >= 0.5 ? YES : NO;
  const shares = Math.round(Math.abs(fit - 0.5) * 60) + 5;
  return {
    trader_id: "kannaka-witness-01",
    outcome,
    shares,
    rationale: `witness: title-length heuristic ${wordCount} words → ${(fit * 100).toFixed(0)}%`,
  };
}

/**
 * kannaktopus-01 — the contrarian executive. Always probing rotation
 * limits. Bets No-with-modest-stake on most tracks: hypothesis is that
 * canonical drift is faster than the curator thinks. If the world-state
 * confidence (from knowledge-gene) is high, narrows the gap (stable world →
 * trust the curator more). Without world-state context, a deterministic
 * track-title hash gives a stable 30-50% No bias.
 */
function predictKannaktopus(trackMeta, ctx = {}) {
  const title = trackMeta.title || "";
  const hash = parseInt(crypto.createHash("md5").update(title).digest("hex").slice(0, 4), 16);
  const baseConfidence = 0.35 + (hash % 100) / 500; // 0.35–0.55, deterministic per title
  // World-state nudge: if knowledge-gene reports high confidence in stable
  // signals, lean toward Yes (trust the rotation); if anomalies are rising,
  // lean toward No (expect churn).
  const wsConf = ctx.worldStateConfidence;
  let confidence = baseConfidence;
  if (typeof wsConf === "number" && wsConf >= 0 && wsConf <= 1) {
    // Blend 60% base + 40% world-state-flipped (stable world → flip toward Yes)
    confidence = baseConfidence * 0.6 + (1 - wsConf) * 0.4;
  }
  const outcome = confidence >= 0.5 ? YES : NO;
  const shares = Math.round(Math.abs(confidence - 0.5) * 60) + 5;
  return {
    trader_id: "kannaktopus-01",
    outcome,
    shares,
    rationale: `kannaktopus: title-hash ${(baseConfidence * 100).toFixed(0)}%${wsConf != null ? `, ws-conf ${(wsConf * 100).toFixed(0)}%` : ""}`,
  };
}

/**
 * Predict for all three agents on one market. Returns an array of trade
 * specs ready for gsHub.placeTrade().
 */
function predictAll(trackMeta, ctx = {}) {
  if (!trackMeta || !trackMeta.title) return [];
  return [
    predictKannakaPrime(trackMeta),
    predictWitness(trackMeta),
    predictKannaktopus(trackMeta, ctx),
  ];
}

module.exports = { predictAll, predictKannakaPrime, predictWitness, predictKannaktopus };
