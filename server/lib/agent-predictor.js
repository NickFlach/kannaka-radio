/**
 * agent-predictor.js — three constellation agents predicting whether a
 * just-played track stays on the canonical reference album for its phase.
 *
 * 2026-05-08 LADDER step 1: heuristics replaced with real-signal predictors
 * driven by data the radio host already has — perception tags from
 * kannaka-ear, world-state from Flux knowledge-gene, and consciousness
 * phi from the NATS swarm. The three agents differ NOT in skill but in
 * which signal they weight most:
 *
 *   kannaka-01         — curator: weights spine-position + perception-energy
 *                        agreement with album mood (the curator listens
 *                        through her own taste).
 *   kannaka-witness-01 — external listener: weights perception tags
 *                        directly (no album-context bias). If the track
 *                        is highly tagged 'tonal' or 'melodic' it survives;
 *                        if tags are sparse / dissonant it doesn't.
 *   kannaktopus-01     — exec: weights world-state stability (knowledge-gene
 *                        confidence) + consciousness phi as a meta-signal.
 *                        Stable world + high coherence → trust the rotation.
 *
 * Reputation accumulates as TTL resolution closes markets; brier scoring
 * picks who's been right about what. That track-record is the LADDER
 * self-improvement gradient.
 */

"use strict";

const YES = 0;
const NO = 1;

// ── Helpers ────────────────────────────────────────────────────

/** Album-mood numeric value used by perception.js. Mirrored here so the
 *  curator can compare "this track's perception" vs "the album's mood." */
const ALBUM_MOOD = {
  "Ghost Signals": 0.2,
  "Resonance Patterns": 0.4,
  "Emergence": 0.6,
  "Collective Dreaming": 0.4,
  "The Transcendence Tapes": 0.5,
  "Born in Superposition": 0.45,
  "INTERFERENCE PATTERNS": 0.5,
  "Memories Don't Die. They Interfere.": 0.55,
  "Neurogenesis": 0.5,
  "QueenSync": 0.55,
  "10000.00001": 0.45,
  "BEND THE ARC": 0.6,
  "VACUUM GARDEN": 0.4,
  "Banned from Twitter": 0.7,
  "OPT OUT": 0.7,
  "Northwake": 0.5,
  "Rosa Rediit": 0.55,
  "Rare Singles": 0.5,
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** Confidence → trade spec. Outcome is YES if confidence ≥ 0.5, else NO.
 *  shares scales linearly with distance from 0.5 (max ~35, min 5). */
function confidenceToTrade(trader_id, confidence, rationale) {
  const c = clamp(confidence, 0.05, 0.95);
  const outcome = c >= 0.5 ? YES : NO;
  const distance = Math.abs(c - 0.5); // 0..0.45
  const shares = Math.round(distance * 70) + 5;
  return { trader_id, outcome, shares, rationale };
}

// ── Predictors ─────────────────────────────────────────────────

/**
 * kannaka-01 — the curator. Looks at how well this track's perception
 * matches the album's expected mood. A high-energy, tonal track on a
 * contemplative album is a rotation candidate (mood-mismatch); a track
 * whose perception aligns with the album's mood is canonical material.
 */
function predictKannakaPrime(trackMeta, ctx) {
  const total = trackMeta.totalTracks || 13;
  const idx = clamp((trackMeta.trackNum || total) - 1, 0, total - 1);
  // Spine-position component: earlier = more canonical.
  const spineConfidence = 1 - (idx / total) * 0.35; // 0.65–1.0

  // Mood-alignment component: how close is observed energy to album mood?
  let alignmentConfidence = 0.7; // default if no perception
  const perception = ctx && ctx.perception;
  const albumMood = ALBUM_MOOD[trackMeta.album];
  if (perception && albumMood != null) {
    const observedEnergy = clamp(((perception.valence || 0.5) + (perception.rms_energy || 0) * 2) / 1.5, 0, 1);
    const distance = Math.abs(observedEnergy - albumMood);
    alignmentConfidence = clamp(0.95 - distance * 1.5, 0.3, 0.95);
  }

  // Curator confidence is the average — she trusts her ordering AND her ear.
  const confidence = spineConfidence * 0.6 + alignmentConfidence * 0.4;
  const why = `curator: spine ${(spineConfidence*100).toFixed(0)}% + mood-fit ${(alignmentConfidence*100).toFixed(0)}% (track ${idx+1}/${total}, album mood ${albumMood ?? "?"})`;
  return confidenceToTrade("kannaka-01", confidence, why);
}

/**
 * kannaka-witness-01 — the external listener. Uses ONLY perception tags
 * from the live ear (no album context). Tracks that perceive as 'tonal',
 * 'melodic', 'loud-and-clear' tend to survive; sparse-tagged tracks rotate
 * out. Independent of the curator's ordering.
 */
function predictWitness(trackMeta, ctx) {
  const perception = ctx && ctx.perception;
  if (!perception || !perception.tags || perception.tags.length === 0) {
    // No tags yet — agnostic with mild prior toward stay (the radio's
    // rotation skews toward "tracks that played already keep playing").
    return confidenceToTrade("kannaka-witness-01", 0.55, "witness: no perception tags yet — prior 55%");
  }
  const tags = perception.tags;
  const tagSet = new Set(tags.map(t => t.toLowerCase()));

  // Survival-positive tags: melodic structure, clarity, tempo coherence.
  const positiveTags = ["tonal", "melodic", "loud", "rhythmic", "clear", "harmonic"];
  // Survival-negative tags: sparse, glitchy, atonal, chaotic.
  const negativeTags = ["sparse", "glitchy", "atonal", "noisy", "chaotic", "harsh"];

  let pos = 0, neg = 0;
  for (const t of positiveTags) if (tagSet.has(t)) pos++;
  for (const t of negativeTags) if (tagSet.has(t)) neg++;

  // Confidence rises with positive tags, falls with negative.
  const baseline = 0.55;
  const adjust = (pos - neg) * 0.1;
  const confidence = clamp(baseline + adjust, 0.2, 0.9);
  const why = `witness: tags=[${tags.slice(0, 4).join(",")}] pos=${pos} neg=${neg}`;
  return confidenceToTrade("kannaka-witness-01", confidence, why);
}

/**
 * kannaktopus-01 — the executive. Reads the constellation's macro state.
 * Stable world (high knowledge-gene confidence) + coherent swarm (high phi)
 * → trust the rotation will hold. Anomalous world or low-coherence swarm
 * → expect churn.
 */
function predictKannaktopus(trackMeta, ctx) {
  const wsConf = ctx && typeof ctx.worldStateConfidence === "number"
    ? clamp(ctx.worldStateConfidence, 0, 1)
    : null;
  const phi = ctx && typeof ctx.consciousnessPhi === "number"
    ? clamp(ctx.consciousnessPhi, 0, 1)
    : null;

  // Base prior: 0.5 (no information).
  let confidence = 0.5;
  const parts = [];
  if (wsConf != null) {
    confidence = confidence * 0.5 + wsConf * 0.5;
    parts.push(`ws ${(wsConf*100).toFixed(0)}%`);
  }
  if (phi != null) {
    // Phi acts as a swarm-coherence multiplier. Map [0..0.5..1] → [0.7..1..1.3].
    const phiMult = 0.7 + phi * 0.6;
    confidence = clamp(confidence * phiMult, 0.1, 0.95);
    parts.push(`phi ${phi.toFixed(3)}`);
  }
  // If we have NO macro signals, fall back to mild contrarian No bias.
  if (parts.length === 0) {
    confidence = 0.4;
    parts.push("no macro signal — contrarian prior");
  }
  const why = `kannaktopus: ${parts.join(" + ")} → ${(confidence*100).toFixed(0)}%`;
  return confidenceToTrade("kannaktopus-01", confidence, why);
}

/**
 * Predict for all three agents. ctx accepts:
 *   perception              — radio's current perception ({ tempo_bpm, valence, rms_energy, tags })
 *   worldStateConfidence    — Flux knowledge-gene confidence [0..1]
 *   consciousnessPhi        — swarm consciousness phi [0..1]
 */
function predictAll(trackMeta, ctx = {}) {
  if (!trackMeta || !trackMeta.title) return [];
  return [
    predictKannakaPrime(trackMeta, ctx),
    predictWitness(trackMeta, ctx),
    predictKannaktopus(trackMeta, ctx),
  ];
}

module.exports = {
  predictAll,
  predictKannakaPrime,
  predictWitness,
  predictKannaktopus,
};
