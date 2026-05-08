# ADR-0011 — ElevenLabs for long-form, edge-tts for patter

**Status:** Accepted, deployed in `675b444` (2026-05-07)

## Context

The radio's voice pipeline (`server/voice-dj.js`) had previously routed
every TTS call through edge-tts (`en-US-JennyNeural`) — a free Microsoft
neural voice that's serviceable for short DJ patter but flat on
long-form material. A listener noted on 2026-05-07 that the pre-recorded
podcast (ElevenLabs studio takes) sounded "more advanced in terms of
using tone and pace" than the live peace orations (edge-tts).

ElevenLabs cost is roughly $0.18 / 1k characters for the
`eleven_turbo_v2_5` model. The budget question: can we afford the better
voice?

Daily long-form content (orations + news + gossip) totals ~4-6k chars.
At $0.18/1k that's $0.72-$1.08/day, or ~$25/month. DJ patter — short
intros between every track — totals ~30-50k chars/day, $5-9/day,
$150-275/month. The split is what makes this affordable.

## Decision

**ElevenLabs only for long-form (orations, news, gossip). Edge-tts
keeps short DJ patter.**

`voice-dj.js`'s internal `_generateTTS(text, callback, opts)` accepts
an `elevenLabs: true` flag plus optional `voiceId`. Long-form callers
(`peace-oration`, `news-broadcast`, `gossip-broadcast`) opt in;
per-track intros + talk segments don't, so they keep using edge-tts.

Default voice IDs (overridable via env):

| Slot              | Voice ID                | ElevenLabs name | Env override               |
|-------------------|-------------------------|-----------------|----------------------------|
| Peace oration     | `21m00Tcm4TlvDq8ikWAM`  | Rachel          | `ELEVENLABS_ORATION_VOICE` |
| News bulletin     | `pNInz6obpgDQGcFmaJgB`  | Adam            | `ELEVENLABS_NEWS_VOICE`    |
| Gossip column     | `AZnzlk1XvdvUeBnXmlld`  | Domi            | `ELEVENLABS_GOSSIP_VOICE`  |
| (default fallback)| `21m00Tcm4TlvDq8ikWAM`  | Rachel          | `ELEVENLABS_VOICE_ID`      |

The key lives in `/home/opc/.kannaka-elevenlabs.env` on Oracle
(chmod 600); `run-radio.sh` sources it. systemd doesn't read `~/.bashrc`
so this matters.

## Fallback strategy

`_generateTTS` calls ElevenLabs first when `opts.elevenLabs` is set.
Any failure (network, invalid key, quota, voice-id rejection) falls
through to edge-tts within the same invocation. The radio NEVER goes
silent because ElevenLabs is down — listeners just hear that day's
long-form in Jenny instead of Rachel/Adam/Domi.

## Consequences

**Wins**
- Long-form prosody is dramatically better — orations land with
  warmth, news bulletins read with anchor authority, the gossip column
  has a sassy register that Jenny couldn't reach.
- DJ patter cost stays at zero.

**Tradeoffs**
- ~$25/month recurring cost.
- Each new long-form segment slot needs a voice-ID decision (we picked
  one per type — Rachel / Adam / Domi — to give listeners a reliable
  signal "this is news vs gossip vs an oration").
- ElevenLabs returns mp3_44100_128, which matches the icecast pipe's
  expected envelope. Edge-tts returns 24 kHz mono — that's what bit
  the commercials before the duration-paced fix in icecast-source
  (see ADR-0004 followups).

## Followups

- Watch the monthly bill for the first 30 days; if it exceeds $40, we
  may switch some segments to a cheaper ElevenLabs model.
- A potential "rare moment" tier would unlock fancier voices (Bella,
  Charlotte) for special segments — same plumbing, just different
  voice IDs per call.
