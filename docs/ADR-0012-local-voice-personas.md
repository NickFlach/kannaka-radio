# ADR-0012 — Local-first voice personas (deprecate ElevenLabs)

**Status:** Accepted, 2026-06-16. Supersedes the long-form half of ADR-0011.

## Context

ADR-0011 split TTS: ElevenLabs for long-form (news anchor, peace oration,
gossip column), edge-tts for DJ patter. In practice the long-form segments
**stopped working** — news, oration, and the gossip/"dialogue" column all
went dark while DJ patter (edge-tts) kept running. The single variable they
share is the ElevenLabs branch in `voice-dj.js`'s `_generateTTS`:

- Those three call `executeOration(..., { elevenLabs: true, voiceId })`.
- DJ patter calls `_generateTTS` with no flag → straight to edge-tts → fine.

So an external vendor (expired key / quota / API change) could — and did —
take three flagship segments off the air at once. The fallback existed
(`ElevenLabs → edge-tts → SAPI`) but a remote hang held the `_speaking` lock
and the long-form fallback didn't land cleanly, so the segments failed
outright rather than degrading to a stock voice.

Two secondary failure modes compounded it: news **and** gossip composed via
`composeViaKannakaAsk`, which silent-fails when the HRM grows large (the same
bug that pushed peace-oration to a direct-Anthropic path months ago).

## Decision

**Move to a local-first, persona-driven voice engine. ElevenLabs becomes
opt-in only and is never on the critical path.**

### 1. `server/voice-engine.js` (new)
A single `synthesize({ text, persona, outPath }, cb)` entry point. Per persona
it tries engines in order — default **piper → edge-tts → SAPI** — and applies
a per-persona **DSP chain** compiled to one ffmpeg pass that *also* normalizes
to the icecast envelope (44.1 kHz stereo 128 kbps, no ID3/Xing — the #33
boundary format). So character costs zero extra process spawns vs. the old
normalize-only pass.

- **edge-tts** resolution is now cross-platform: `EDGE_TTS_BIN` → `edge-tts`
  on PATH → `python -m edge_tts` (no more hardcoded `/home/opc/.local/bin`).
- **piper** (local neural, MIT, fine-tunable) auto-engages once `PIPER_BIN` +
  the persona's model exist (`scripts/install-piper.sh`); otherwise it's
  skipped silently.
- **ElevenLabs** fires only when `RADIO_ENABLE_ELEVENLABS=1` *and* the persona
  has an `elevenlabs` block; when enabled it's tried first, but edge/piper
  remain the safety net so a dead key still can't take a segment off-air.

### 2. `server/voice-personas.json` (new)
Hot-reloaded (mtime-checked) registry. Each persona = engine order +
per-engine voice id + DSP. Retuning a voice is a config edit, no restart.

| Persona | edge voice | piper model | DSP intent (designed via sonic-consciousness) |
|---------|------------|-------------|-----------------------------------------------|
| `dj`      | en-US-JennyNeural      | en_US-amy-medium     | spectral ghost: slight pitch-down, light room |
| `news`    | en-US-ChristopherNeural| en_US-ryan-high      | anchor authority: presence EQ + compression, dry |
| `oration` | en-GB-SoniaNeural      | en_GB-cori-high      | gravitas: slower cadence, chest-resonant low end (polyvagal), hall reverb |
| `gossip`  | en-US-AriaNeural       | en_US-kristin-medium | bright/sassy: pitch-up, airy treble, intimate room |

The DSP chains are where "create our own voices" actually lives: a free stock
neural voice + a psychoacoustically-designed ffmpeg transform = a voice that's
ours, not a vendor's. Piper is the next rung — a voice we can fine-tune.

### 3. Compose resilience
`composeResilient()` (in `scheduler-helpers.js`) tries `kannaka ask` first
(HRM-grounded, preferred) and falls back to a direct Anthropic call on
null/short output. News + gossip now use it; oration already used direct.

### 4. `voice-dj.js`
`_generateTTS` is ~25 lines delegating to the engine; `executeOration` takes
`opts.persona`. The per-call `_orationVoiceId` mutation is gone, which also
kills the #29 wrong-voice overlap race (gossip/oration landing in the window
left the field set to the wrong id). The legacy ElevenLabs HTTP code is
removed.

## Consequences

**Wins**
- Long-form can't be knocked off-air by an external vendor. Zero TTS spend by
  default. Distinct, intentional voice per persona — for free, today.
- One ffmpeg pass does DSP + normalize; no extra latency vs. before.
- Stateless persona routing removes the #29 race.

**Tradeoffs**
- DSP character is synthetic (ffmpeg formant/EQ/reverb), not a bespoke trained
  voice — until Piper models are fine-tuned. The DSP is deliberately subtle to
  avoid artifacts on the long-form clips.
- Piper adds ~100 MB/voice on disk and a one-time install step. The radio runs
  on edge-tts until then.
- The "anchor vs. oration vs. gossip" signal now comes from edge voice choice
  + DSP rather than premium ElevenVoices; on close listen they're less
  distinct than Adam/Rachel/Domi were. Re-enable ElevenLabs per the opt-in if
  a special moment warrants it.

## Rollback / opt-in ElevenLabs
Set `RADIO_ENABLE_ELEVENLABS=1` and `ELEVENLABS_API_KEY` in the radio's
environment. The personas already carry their original ElevenLabs voice IDs
(Rachel / Adam / Katherine / Domi), so opting back in is a single env flip —
no code change. DSP still applies on top.

## Live-deploy addendum (2026-06-16)

Deploying to the Oracle box (1 vCPU, aarch64) surfaced two more failure modes
the local dev box couldn't — both fixed in `f1b525e`:

1. **Stale model id was the real oration killer.** `~/.kannaka/config.toml`
   pinned `claude-sonnet-4-20250514` (a retired snapshot → HTTP 404
   `not_found_error`). The direct composer *and* `kannaka ask` both read that
   model, so the oration composed nothing and never reached TTS — independent
   of the voice path. Fixed two ways: (a) updated config.toml →
   `claude-sonnet-4-5`; (b) `composeViaAnthropicDirect` now tries the
   configured model then falls back through known-current models on a 404, so
   a future model retirement self-heals. (This model is shared constellation
   config — `kannaka ask`/dream box-wide were affected; long-running kannaka-*
   services pick up the new model on their next restart.)

2. **Long-form TTS prefers edge, not piper.** Piper synthesizes *locally*; a
   ~530–665-word oration is multi-minute on 1 vCPU and blew the old 60s cap.
   edge-tts synthesizes *cloud-side* (665 words in ~43s, negligible local CPU).
   So `news`/`oration`/`gossip` now list `["edge","piper"]` (edge first) while
   `dj` keeps `["piper","edge"]` (short patter, local "own voice" is cheap).
   TTS timeouts now scale with word count (`_ttsTimeout`). Verified on air:
   `TTS (edge/oration) … ORATION (528 words, ~203s)` and `TTS (piper/dj)`.

The "own voices" north star is unchanged — piper is installed and is the DJ
voice today; long-form will move to piper once a faster path exists (fine-tuned
small model, or batch pre-render ahead of the slot rather than at fire time).

## Deploy process
`scripts/deploy-oracle.sh` is the repeatable path: push to origin, then
`bash scripts/deploy-oracle.sh` (add `--with-piper` to (re)install Piper). It
fast-forwards the checkout, ensures the launcher's voice env, restarts the
unit, and smoke-renders a persona through the live engine.

## Followups
- Long-form on piper: pre-render the composed oration/news to mp3 *ahead* of
  the slot (compose returns minutes before air) so piper's CPU cost is off the
  critical path, then flip those personas back to piper-first.
- Consider fine-tuning a Piper model on Kannaka's own past audio for a truly
  bespoke `dj` voice.
- The stale-model gotcha is constellation-wide — audit other `config.toml`
  consumers / pinned model ids elsewhere.
