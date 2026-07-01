# Oracle wrapper scripts

systemd unit files in `/etc/systemd/system/` reference these wrapper
scripts via `ExecStart=`. They live on the Oracle host (`/home/opc/`
and `/home/opc/kannaka-radio/`) and stay there in normal operation,
but they're vendored here as `*.example` so:

1. **A `git stash --include-untracked` can't permanently lose them.**
   On 2026-04-19 and again on 2026-05-03 a stash with `-u` swept
   `run-swarm.sh` from `/home/opc/kannaka-memory/`. systemd entered a
   restart loop with `status=127/n/a` ("No such file or directory")
   that took 30 minutes to diagnose the second time. With the script
   tracked here, recovery is `cp ops/oracle/run-swarm.sh.example
   /home/opc/kannaka-memory/run-swarm.sh`.

2. **A new Oracle deployment has a starting point.** Copy each
   `.example` to its target path (drop the `.example` suffix), make it
   executable, fill in any placeholders (icecast password etc), and
   point the systemd unit at it.

## Mapping (from `/etc/systemd/system/*.service`)

| Service                     | ExecStart target                              | Source here                          |
| --------------------------- | --------------------------------------------- | ------------------------------------ |
| `kannaka-radio.service`     | `/home/opc/run-radio.sh`                      | `run-radio.sh.example`               |
| `kannaka-swarm-serve.service` | `/home/opc/run-swarm-serve.sh`              | `run-swarm-serve.sh.example`         |
| `kannaka-swarm-worker.service` | `/home/opc/run-swarm-worker.sh`            | `run-swarm-worker.sh.example`        |
| `icecast-source.service`    | `/home/opc/run-icecast-source.sh`             | `run-icecast-source.sh.example`      |
| `*/2 * * * *` (cron)        | `/home/opc/kannaka-radio/run-push-nats.sh`    | `run-push-nats.sh.example`           |

`kannaka-memory.service` lives next door in
`kannaka-memory/ops/oracle/run-swarm.sh.example`.

## Required env files

The wrappers source two env files that are NOT vendored here (they
hold secrets):

| File                              | Contents                                              |
| --------------------------------- | ----------------------------------------------------- |
| `/home/opc/.kannaka-nats.env`     | `NATS_USER=…` + `NATS_PASSWORD=…` (kannaka_internal). |
| `/home/opc/.kannaka-obc.env`      | OpenBotCity JWT + agent ids (radio only).             |
| `/home/opc/.kannaka-icecast.env`  | `ICECAST_SOURCE_PASSWORD=…` (icecast-source only).    |

Permissions: `chmod 0600` on each, owned by `opc`.

## Recovery recipe

If a service is in `status=127/n/a` restart loop:

```bash
sudo journalctl -u <service> -n 5 --no-pager   # confirms missing-script error
ssh opc@host
cd /home/opc/kannaka-radio   # or kannaka-memory
git pull
cp ops/oracle/<wrapper>.example /home/opc/<wrapper>
chmod +x /home/opc/<wrapper>
sudo systemctl restart <service>
```

If the service had been removed from a stash, `git stash pop` works too.

## Deploying a new kannaka-memory binary (zombie-inode rule)

The kannaka-memory Rust binary is built/deployed from the repo **next door**
(`/home/opc/kannaka-memory`), not from here. But the rule that governs it bites
this box's whole `kannaka-*` fleet, so it's documented here where the Oracle
runbook lives:

**Any deploy that rebuilds `kannaka` (`cargo build --release`) MUST restart
every `kannaka-*` systemd unit that execs it — not just `kannaka-memory`.**
`cargo` replaces the file at its path but the old inode lives on; every
long-running process that already `exec`-ed it keeps running the OLD code until
restarted. The units that exec the binary include `kannaka-memory` (the single
writer — restart it first), `kannaka-swarm-serve`, `kannaka-swarm-worker`,
`kannaka-attention`, `kannaka-staff`, `kannaka-substrate`, `kannaka-ui-bridge`
(list drifts — discover live, don't trust it). The radio/icecast Node services
don't exec the Rust binary and are unaffected (restarting them is harmless).

Symptom of a missed restart: `sudo readlink /proc/<pid>/exe` prints
`…/target/release/kannaka (deleted)`, and SELinux `setroubleshoot` logs noise
about `kannaka (deleted)` writing `kannaka.metrics.json`.

Mechanical helper (records a rollback SHA and reverts on a failed smoke check):

```bash
# from the dev box, after pushing kannaka-memory AND rebuilding it on Oracle:
bash scripts/deploy-oracle.sh --restart-kannaka   # alias: --fleet
```

`--restart-kannaka` restarts every *active* `kannaka-*.service` (memory first),
then asserts no `/proc/<pid>/exe` still resolves to a `(deleted)` inode. It
discovers the unit set live via `systemctl list-units --state=active
'kannaka-*.service'`, so it can't rot as units are added or removed.
