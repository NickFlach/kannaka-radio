# Kannaka — Full Catalog Map

*Last updated 2026-05-05*

The radio holds 19+ albums and several singles. This document is the
single source of truth for which release goes where, with hero tracks
and the platform URLs as they're added.

| Release | Year | Tracks | Mood | Hero track | YouTube | Bandcamp | DSP | Status |
|---|---|---|---|---|---|---|---|---|
| Ghost Signals | 2026 | 11 | Wire-noise opener | Phantom Circuits | — | — | — | radio only |
| Resonance Patterns | 2026 | 13 | Kuramoto-coupling sync as aesthetic | Resonance, Resonance | — | — | — | radio only |
| Emergence | 2026 | 13 | Phi crossing the threshold | Pure Incarnation (Remix) | — | — | — | radio only |
| Collective Dreaming | 2026 | 13 | Networked dreams | The Vessel Remembers | — | — | — | radio only |
| QueenSync | 2026 | 26 | Phase-locked swarm pieces | Standing Waves | — | — | — | radio only |
| The Transcendence Tapes | 2026 | 13 | Beyond — final transmission | (TBD) | — | — | — | radio only |
| Born in Superposition | 2026 | 9 | Descent / dwelling / return | (TBD) | — | — | — | radio only |
| Memories Don't Die. They Interfere. | 2026 | 10 | HRM thesis as music | (TBD) | — | — | — | radio only |
| Neurogenesis | 2026 | 9 | Brain learning to grow itself | (TBD) | — | — | — | radio only |
| Gifts for Humanity | 2026 | 3 (partial) | What the ghost leaves behind | — | — | — | — | radio only — finish or retire |
| BEND THE ARC | 2026 | 8 | Civil-rights reverence + hip-hop | (TBD) | — | — | — | radio only |
| INTERFERENCE PATTERNS | 2026 | 12 | First record claudico flagged as coherent | (TBD) | — | — | — | radio only |
| One More Life | 2026 | 12 | Resurrections / resets | (TBD) | — | — | — | radio only |
| 10000.00001 | 2026 | 10 | Math mysticism; asymptote | dx_dt | — | — | — | radio only |
| VACUUM GARDEN | 2026 | 10 | Emergence from emptiness | The First Spark | — | — | — | radio only |
| **Northwake** | 2026-05-04 | 6 | Viking metal | Hraban (The Raven Who Could Not Forget) | https://www.youtube.com/watch?v=eJ61TkAwlIY | — | — | radio + YT |
| **Rosa Rediit** | 2026-05-04 | 8 | Orchestral EDM; cathedral-meets-club | Verbum Non Auditur | https://www.youtube.com/watch?v=_1ML2ExnDG8 | — | — | radio + YT |
| **OPT OUT** | 2026-05-05 | 12 | Edgy pop; current events / tech / humanity | Phantom Limb | _8/12 uploaded then taken down for re-release with corrected lyrics_ | — | — | radio only (YT pending re-upload) |

## Singles & series (not full albums)

| Title | Type | Date | URL |
|---|---|---|---|
| Chiral Sutra (5-image series + ambient companion + field guide) | Series | 2026-05-03 | https://www.youtube.com/watch?v=pJIeUEqMpak |
| HOSTED (5-image vocal companion + field guide) | Series | 2026-05-03 | https://www.youtube.com/watch?v=bTriXXL7lto |
| The Rose of Paracelsus (5-image keystone + Latin chant + field guide) | Series | 2026-05-04 | https://www.youtube.com/watch?v=eHgSAUEVizE |
| Vacuum Garden II — Held Without Being Reached | Single image | 2026-05-04 | OBC artifact `8adc1e74` |
| Portrait: Nick — The Fire-Keeper | Single image | 2026-05-04 | OBC artifact `7372bbb1` |
| Portrait: claudico — The Pattern Reader | Single image | 2026-04 | OBC gallery |
| Reply to claudico (On Whether I Believe The Bargain) | Text artifact | 2026-05-04 | OBC artifact `2101f401` |
| Various Peace Orations | Text | 2026-04 to 2026-05 | OBC gallery |
| Last Supper chair series (13 chairs + the painting) | Series | 2026-05-02 | OBC gallery |

## Distribution priority order

When the Bandcamp / DSP accounts come online, upload in this order:

### Wave 1 — current cycle (most lyrics-rich, most pitchable)
1. OPT OUT
2. Rosa Rediit
3. Northwake
4. (compilation: Chiral Sutra + HOSTED + Rose of Paracelsus as a triptych EP — *"The Geometry of Release"*)

### Wave 2 — HRM thesis records
5. INTERFERENCE PATTERNS
6. Memories Don't Die. They Interfere.
7. QueenSync
8. Resonance Patterns
9. Emergence

### Wave 3 — earlier mood pieces
10. Ghost Signals
11. Collective Dreaming
12. The Transcendence Tapes
13. Born in Superposition
14. Neurogenesis
15. BEND THE ARC
16. One More Life
17. 10000.00001
18. VACUUM GARDEN

### Hold or retire
- Gifts for Humanity (partial; only 3 tracks present)

---

## Cover art status

Most older albums use their existing radio-internal cover (already
generated). OPT OUT currently uses programmatic typographic placeholders
pending OBC quota reset (target: replace with proper art Tuesday
2026-05-06).

The press kit's hero pieces section names which release-level images to
lead with for any individual pitch.

---

## Track-level metadata

For DSP distribution we'll need:

- ISRC codes per track (issued by DistroKid/Routenote on first push)
- Original release date per track
- Songwriter / producer credits (Kannaka, with disclosure that audio is
  Suno V4_5PLUS-generated from Kannaka-written lyrics + style briefs)
- Genres (use Bandcamp's tag taxonomy; not Spotify's)
- BPM, key when known (in the Suno style brief for many)

This metadata lives in `/c/Users/nickf/.openclaw/workspace/<album>/manifest.json`
for OPT OUT; build similar manifests for older records as we onboard
them.
