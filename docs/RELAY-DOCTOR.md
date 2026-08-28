# relay-doctor

Unattended health check and self-repair for a deployed Maestro Relay.

The relay is the only inbound path from Discord, so when it breaks there is no
working channel to report that it broke. `scripts/relay-doctor.mjs` closes that
gap: it runs on a Cue heartbeat, repairs the failures it recognises, and
escalates the rest with the evidence already collected.

## Running it

```bash
node scripts/relay-doctor.mjs              # check, repair, notify
node scripts/relay-doctor.mjs --json       # machine-readable report
node scripts/relay-doctor.mjs --dry-run    # report what it would do; no repairs, no notifications
node scripts/relay-doctor.mjs --probe      # add the end-to-end probe, respecting its rate limit
node scripts/relay-doctor.mjs --force-probe
node scripts/relay-doctor.mjs --no-agent   # notify only; never dispatch an agent
node scripts/relay-doctor.mjs --reset      # forget all state and re-baseline
```

Exit codes are the scheduler contract: `0` healthy, `1` a fault was repaired,
`2` a fault needs attention.

## Checks

| Check | Detects | Repair |
|---|---|---|
| `service` | API unreachable, or a provider gateway not ready | `launchctl kickstart`; falls back to `bootstrap` from the plist when the job is fully unloaded |
| `patch-drift` | The deployed build is missing a local patch, e.g. after `maestro-relay-ctl update` reinstalls an upstream release | rebuild from source, run the suite, rsync `dist/`, restart |
| `error-log` | New `queue:send-error` / `queue:agent-failure` lines since the last run, classified against a signature table | per-signature; unrecognised signatures escalate |
| `probe` | The full inbound path: spawn `maestro-cli`, capture stdout, parse the JSON | none; escalates |

The error log is read from a saved byte offset, so a heartbeat stays cheap
regardless of log size, and rotation resets the offset rather than replaying
history. The first run adopts the current end of the log as a baseline: the
doctor is a forward-looking watchdog, not a historical auditor.

## Signatures

`SIGNATURES` in the script maps an error-log line to a diagnosis and a repair.
Adding an entry is how a fault stops needing a human. The table currently
recognises stdout pollution (the `parseCliJson` case), a missing `maestro-cli`,
a busy agent, an unmapped agent id, and a CLI timeout.

## Escalation

**The doctor never posts to Discord.** That channel is a conversation between
people, and infrastructure chatter in it is noise for everyone reading. A
successful self-repair is the system working as designed, so it gets a line in
`~/.local/state/maestro-relay/doctor.log` and nothing else.

An unrepairable fault writes a JSON report under
`~/.local/state/maestro-relay/reports/`, appends to the audit log, raises a
desktop notification, and dispatches an agent to investigate with the report
path in the prompt.

Guards, because this runs with nobody watching:

- **Escalation cooldown** (`RELAY_DOCTOR_COOLDOWN_MINUTES`, default 45) keyed on
  the set of escalated ids, so a persistent fault does not page repeatedly while
  a genuinely new fault is never suppressed.
- **Repair attempt limit** (`RELAY_DOCTOR_MAX_REPAIRS`, default 3) per
  signature, after which the doctor stops trying and escalates instead.
- **Test gate**: a rebuild is never deployed if the relay's own suite fails,
  even to end an outage.
- `--dry-run` suppresses every side effect, including notifications.

## Configuration

All optional; the defaults match a standard install.

| Variable | Default |
|---|---|
| `MAESTRO_RELAY_HOME` | `~/.local/share/maestro-relay` |
| `MAESTRO_RELAY_SRC` | `~/Projects/Maestro-Relay` |
| `RELAY_API_PORT` | `3457` |
| `RELAY_PLIST` | `~/Library/LaunchAgents/sh.maestro.relay.plist` |
| `RELAY_DOCTOR_AGENT` | the Kensho agent id |
| `RELAY_DOCTOR_PROBE_MINUTES` | `180` |
| `RELAY_DOCTOR_COOLDOWN_MINUTES` | `45` |
| `RELAY_DOCTOR_MAX_REPAIRS` | `3` |
| `RELAY_DOCTOR_STATE` | `~/.local/state/maestro-relay/doctor-state.json` |
| `RELAY_DOCTOR_REPORTS` | `~/.local/state/maestro-relay/reports` |
| `RELAY_DOCTOR_LOG` | `~/.local/state/maestro-relay/doctor.log` |

## Schedule

Defined in `Kensho/.maestro/cue.yaml` as Command nodes, so a healthy heartbeat
costs a subprocess rather than a model call:

- **Relay Doctor Heartbeat** — every 10 minutes
- **Relay Doctor Deep Probe** — 07:30 / 13:30 / 19:30, adds the active probe
- **Relay Doctor Startup Check** — on Maestro launch, for the post-reboot case
- **Relay Doctor Manual** — `maestro-cli cue trigger "Relay Doctor Manual"`
