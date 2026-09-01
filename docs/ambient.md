# Ambient mode

Ambient mode lets an agent follow an ordinary channel conversation and speak only when it has something to add — no mention, no thread. People talk normally; the agent listens, and occasionally it answers.

It is **off by default**, per channel, and toggled by an operator with `/agents ambient on`. When it is off, nothing about the relay's behavior changes.

> **Provider scope**: Discord only today. The buffer in `src/core/ambient.ts` is provider-neutral (no platform types, no database access), so a provider adapter opts in by calling `ambient.add()` from its message handler and passing `ambient: true` through `enqueue`.

## Behavior

There are now three shapes a conversation can take in an agent channel:

| Shape             | Trigger                    | Session                                          |
| ----------------- | -------------------------- | ------------------------------------------------ |
| Channel + mention | `@agent do X`              | Existing per-user thread path, unchanged         |
| Thread            | `/session new`             | Existing per-thread session, unchanged           |
| **Ambient**       | Anyone talking, ambient on | One batch of messages forwarded as a single turn |

A **direct mention always short-circuits ambient**. Saying the bot's name should get a prompt answer, not a twenty-second wait, so mentions take the existing thread path untouched. Both forms count: `@agent` and a ping of the bot's role.

A **Discord reply does not** count as a mention here. Replying to a message auto-pings its author, so hitting Reply on the agent's own ambient answer would otherwise pull the exchange into an owner-bound thread — which is the opposite of what following up in the room should do. Replies stay in the channel and join the next batch.

## Batching

Ambient messages are buffered and forwarded as one turn rather than one turn per message. People type in fragments — three short lines are usually one thought — so per-message forwarding would spawn an agent turn per line and answer the first fragment before reading the rest.

A batch flushes when any of these is true:

| Guard                                  | Default | Env                   |
| -------------------------------------- | ------- | --------------------- |
| Quiet window since the last message    | 20s     | `AMBIENT_WINDOW_MS`   |
| Messages buffered                      | 25      | `AMBIENT_MAX_BATCH`   |
| Age of the oldest message in the batch | 120s    | `AMBIENT_MAX_WAIT_MS` |

Each new message pushes the quiet deadline back, which is the same cue a person in the room uses to decide someone has finished talking. The max-wait ceiling is what stops a conversation where someone types every 19 seconds from deferring the quiet timer forever.

The batch reaches the agent as a labelled transcript:

```
[Pedram] the ORB result moved after the rebuild
[Ali] which cache build was that against?
```

## Silence

The agent is told that staying silent is the **expected** outcome, and that it should reply with exactly `[silence]` when it has nothing worth adding. A silent reply is dropped by the queue: no message, no usage footer, no reaction left behind.

This is the part that makes ambient mode usable rather than exhausting. A model asked to consider a conversation will otherwise always find something to say. `isSilence()` tolerates a model that wraps the sentinel in backticks or asterisks.

Ambient replies that _are_ posted carry no usage footer either — they read as conversation, not as a command result.

## Usage

```
/agents ambient on                                      # listen in this channel
/agents ambient on scope:"quantitative trading research" # ...and say what it's for
/agents ambient off
```

Run it inside a registered agent channel. `/agents ambient` is **operator-only and fails closed**: unlike every other slash command, an empty `DISCORD_ALLOWED_USER_IDS` denies it rather than allowing everyone. Putting an agent into a standing listening posture is not something an unconfigured deployment should let a passer-by do.

Re-running `/agents ambient on` without `scope:` keeps the scope already stored. Pass `scope:` to replace it.

The optional `scope` is a one-line description of what the agent should care about, stored per channel and spliced into the ambient prompt. Without it the agent falls back to its own judgment about what is relevant.

## Configuration

```bash
AMBIENT_WINDOW_MS=20000    # quiet window before a batch is flushed
AMBIENT_MAX_BATCH=25       # flush early once this many messages are buffered
AMBIENT_MAX_WAIT_MS=120000 # hard ceiling on how long a batch may wait
```

All three are process-wide. Whether ambient is actually on is a per-channel flag in the database.

A value that is not a positive number is rejected at read time with a warning and the default is used, and each is clamped to a floor (1s window, 1 message, 5s max wait). An unnoticed `AMBIENT_WINDOW_MS=2m` would otherwise parse to a two-millisecond window and turn every single message into its own agent turn — the exact cost blow-up batching exists to prevent.

The window is the one number worth thinking about: too short and the agent answers half a thought, too long and it feels absent from the conversation.

## Cost

> **Ambient mode on a busy channel is a continuous agent session.** The batching window is the only thing between that and a surprising bill.

There is deliberately **no per-channel turn cap** in this implementation — a sensible cap depends on pricing and traffic that the operator knows and the relay does not. Turn ambient on in a channel whose volume you understand, and watch `/agents show <agent>` for the first day.

## Storage

Migration 6 adds two columns to `agent_channels`, following the existing `read_only` pattern:

| Column          | Type                         | Meaning                                 |
| --------------- | ---------------------------- | --------------------------------------- |
| `ambient`       | `INTEGER NOT NULL DEFAULT 0` | 1 when the channel is being listened to |
| `ambient_scope` | `TEXT`                       | Optional operator-supplied focus line   |

The migration is idempotent and tolerates duplicate-column errors, so it is safe to re-run. Existing rows default to ambient off.

The message buffer itself is in memory — a relay restart drops any partial batch. That is intentional; persisting fragments of a half-finished conversation is worse than losing them.

## Limitations

- **No turn cap.** See "Cost" above.
- **Voice notes are not buffered.** A Discord voice message carries no text, so ambient skips it rather than pushing an empty line into the transcript. Mention the bot to have a voice note transcribed and answered.
- **Failed ambient turns post nothing.** Nobody addressed the bot, so an error goes to the log instead of into the conversation. Check `logs/errors.log` if an ambient channel has gone quiet.
- **Discord only.** The buffer is provider-neutral, but no other adapter is wired to it yet.
- **`ambient_scope` is spliced into the prompt as a plain string.** It comes from an operator-only slash command today, so it is not an injection surface — it would become one if that command were ever opened to non-operators.
