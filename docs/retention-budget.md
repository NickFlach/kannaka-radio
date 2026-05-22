# Disk Retention Budget

Established after the 2026-05-19 root-disk 100%-full incident (#36). Captures
every accumulating directory on the Oracle box, who's responsible for pruning
it, and the rationale so the next on-call can audit.

## Hard limits

The Oracle root volume is **30 GB** (`/dev/mapper/ocivolume-root` mounted at
`/`). `disk-monitor.sh` (cron `:33`) alerts at 80% (`RADIO.alert.disk`) and
escalates as bands cross 90 / 95 / 100.

## Directories and rules

| Path | Sink | Owner | Retention | Notes |
|---|---|---|---|---|
| `/home/opc/kannaka-radio/music/` | Album MP3s | kannaka-radio | **unbounded (intentional)** | ~3 GB. Releases are append-only. Manual cleanup only — delete an album folder if it's been pulled from rotation. |
| `/home/opc/kannaka-radio/chunks/voice/` | Voice-DJ TTS intros | `prune-cron.sh` (`:17`) | mtime > 7d → delete | Intros are read-once and never replayed. Pre-incident this grew to 1.5 GB. |
| `/home/opc/kannaka-radio/chunks/chunk_*.wav` | Ghost Recorder one-shot broadcasts | `prune-cron.sh` (`:17`) | mtime > 1d → delete | Never replayed past the source minute. |
| `/home/opc/.kannaka/kannaka.hrm` | Live HRM | kannaka-memory | live (~10–40 MB) | The actual store. Don't touch. |
| `/home/opc/.kannaka/snapshots/` | Substrate auto-snapshots | substrate's `retain` knob | governed by substrate config | Currently ~2 MB. Stays small unless `retain` is raised. |
| `/home/opc/.kannaka/kannaka.hrm.{bak-*,pre-*,merged,corrupt-bak-*}` | Manual rescue sidecars | `prune-cron.sh` (`:17`) | mtime > 14d → delete | Added 2026-05-21 after the chiral-persistence incident left a fresh corrupt-bak. |
| `/home/opc/.kannaka/kannaka.hrm.v2-backup.*` | Migration safety net | manual | indefinite | One known-good v2 backup. Don't auto-prune — it's the floor. |
| `/home/opc/kannaka-memory/target/release/{deps,build}` | Rust incremental build artifacts | manual (or `cargo clean`) | check on disk pressure | Grows to 2+ GB on a fresh rebuild. Cleared by hand on 2026-05-19. |
| `/var/log/messages-*` | Rotated syslog | system `logrotate` | system default | 50–70 MB per rotation. Not our config — escalate if a rotation gets stuck. |
| `/var/log/icecast/` | Icecast access/error logs | icecast | 35 MB current | Logrotate'd by icecast itself. |
| `/tmp/disk-monitor.last-alert.*` | Disk-monitor throttle state | self | per-hour, naturally rotated | Created by `disk-monitor.sh` to suppress duplicate alerts. |

## Cron schedule (Oracle, opc crontab)

```
0  2 * * * /home/opc/kannaka-memory/research/autoresearch-cron.sh   # 2 AM autoresearch
0  7 * * * /home/opc/kannaka-radio/dream-cron.sh                    # 7 AM dreams
*/5 * * * * /home/opc/kannaka-observatory/cache-observe.sh          # observe cache refresh
17 * * * * /home/opc/kannaka-radio/prune-cron.sh                    # hourly HRM + disk prune
33 * * * * /home/opc/kannaka-radio/scripts/disk-monitor.sh          # hourly disk-pressure alert (RADIO.alert.disk)
```

Offsets are chosen so prune (`:17`) finishes well before the disk-monitor
(`:33`) reads, and neither collides with the `:00` autoresearch / dream
slots or the `*/5` observe sweeps.

## How to extend

When you add a new accumulating directory, **the same commit must add a row
to this table** and either (a) a prune rule in `prune-cron.sh.example`, or
(b) an explicit "unbounded (intentional)" justification. A new sink without
either is a regression — the only way to keep this stable is to make the
budget the source of truth.
