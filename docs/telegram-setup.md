# Telegram bot setup

This guide walks you through creating a Telegram bot, picking a chat for it,
and binding it to a Maestro agent. No prior Telegram-bot experience required —
if you've used Telegram as a chat app, you have everything you need.

## What you'll end up with

- A Telegram bot (your own, with a name and avatar you choose) that represents
  one Maestro agent.
- A chat where you talk to that agent — either:
  - A **forum supergroup** where each Maestro session becomes its own topic
    (recommended; mirrors how Discord channels + threads feel), OR
  - A **private DM** with the bot (simpler; one running session at a time,
    use `/session new` to reset).

One bot is bound to one agent for its lifetime. To bridge multiple agents,
create one bot per agent (BotFather makes this cheap — see "Multiple agents"
at the bottom).

## Step 1 — create the bot via @BotFather

@BotFather is Telegram's official bot for creating other bots.

1. Open Telegram and search for `@BotFather`, or click
   [https://t.me/BotFather](https://t.me/BotFather).
2. Tap **Start** (or send `/start`) to open the conversation.
3. Send `/newbot`.
4. BotFather asks for a **display name** — this is what users see in chats.
   Example: `Alice's Coding Agent`.
5. BotFather asks for a **username** — must end in `bot` and be globally
   unique. Example: `alice_coding_bot`.
6. BotFather replies with a **bot token** that looks like
   `1234567890:ABCdefGHI-jklMNO_pqrSTU_vwxYZ`.

   **Save this token somewhere safe.** You'll paste it into the installer in
   Step 4. Treat it like a password — anyone with the token can control your
   bot.
7. _(Optional)_ Send `/setuserpic` in the BotFather chat to give the bot an
   avatar, or `/setdescription` to give it a description that appears on its
   profile.

## Step 2 — pick a chat for the bot

Choose **Option A** (forum supergroup) for the smoothest experience, or
**Option B** (private DM) if you just want to start fast.

### Option A: forum supergroup (recommended)

Forum supergroups let each Maestro session live in its own _topic_, similar to
how Discord uses channels + threads. You'll be able to start fresh sessions
with `/session new` without losing previous conversations.

1. In Telegram, tap the menu and choose **New Group**. Add at least one other
   contact (you can remove them after creating the group) — Telegram requires
   at least one other member to create a group.
2. Once the group exists, open its **Info** panel (tap the group name at the
   top), then tap **Edit** (pencil icon) → **Group Type** and pick either
   **Public Group** or **Private Group**. Either choice converts it to a
   _supergroup_ under the hood, which is required for topics.
3. Open the Info panel again → **Topics** → toggle **on**. The group's main
   feed is now the "General" topic, and you can create more.
4. Add your bot to the group: Info → **Add Members** → search for your bot's
   `@username` (the one you set in Step 1) → tap to add.
5. Promote the bot to admin with the **Manage Topics** permission:
   Info → **Administrators** → **Add Admin** → pick your bot → grant
   **Manage Topics**. Leave every other admin permission off — the bot
   doesn't need them.
6. Get the supergroup's **chat ID**:
   - Forward any message from the supergroup to
     [@userinfobot](https://t.me/userinfobot).
   - It replies with `Forwarded from chat: ... id: -1001234567890`. Copy that
     negative number — that's your `TELEGRAM_CHAT_ID`.

### Option B: private DM with the bot

Simpler, single-session at a time, no topic management. Good for solo use.

1. In Telegram, search for your bot's `@username` and tap **Start** (or send
   `/start`).
2. Forward your `/start` message (or any other message you sent the bot) to
   [@userinfobot](https://t.me/userinfobot).
3. It replies with your DM chat ID — a positive number. That's your
   `TELEGRAM_CHAT_ID`.

## Step 3 — note your own Telegram user ID

This goes into the access allowlist so only you (and people you list) can use
the bot. Skipping the allowlist is fine for a private bot, but recommended for
anything in a shared supergroup.

- Send any message to [@userinfobot](https://t.me/userinfobot). It replies
  with your numeric user ID (e.g. `987654321`).
- Repeat for any other allowed users — collect their IDs into a comma-
  separated list (e.g. `987654321,123456789`).

## Step 4 — run the installer

The installer prompts for each of the values you collected. Run it with the
`MAESTRO_RELAY_MODULE=telegram` flag so it picks the Telegram walkthrough:

```sh
MAESTRO_RELAY_MODULE=telegram bash -c "$(curl -fsSL https://raw.githubusercontent.com/RunMaestro/Maestro-Relay/main/install.sh)"
```

You'll be asked for:

- The **bot token** from Step 1.
- The **chat ID** from Step 2.
- A **Maestro agent** to bind the bot to. The installer lists your local
  agents and lets you pick by number.
- _(Optional)_ The **allowed user IDs** from Step 3.

The bot is bound to the chosen agent for its lifetime. To bridge a different
agent, run a separate bridge instance with its own `.env` (and a separate bot
from BotFather — see "Multiple agents" below).

## Step 5 — start the bridge

```sh
maestro-relay-ctl start
maestro-relay-ctl logs
```

In your Telegram chat:

- **Forum mode**: send `/session new` in the supergroup's main feed — a new
  topic appears. Send messages inside that topic to talk to the agent. Run
  `/session new` again to start another session in a fresh topic.
- **DM mode**: just send a message. `/session new` resets the session in
  place.

Try `/health` to confirm the bridge is reaching `maestro-cli`.

## Multiple agents

One Telegram bot = one Maestro agent. To bridge multiple agents:

1. Create a separate bot in BotFather for each agent (Step 1, repeated).
2. Run a separate bridge instance per bot, each with its own:
   - `.env` file (different `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and
     `TELEGRAM_AGENT_ID`).
   - `API_PORT` (so they don't conflict with each other on the same machine).
   - systemd unit (override the unit name when installing).

This is intentional — Telegram bots take ~30 seconds to create in BotFather,
and giving each agent its own bot identity makes for a much cleaner UX than
multiplexing many agents through a single bot.

## Troubleshooting

- **Bot doesn't reply in a forum supergroup**: confirm the bot is an admin
  with the **Manage Topics** permission. Without it, the bridge cannot create
  forum topics and the call fails silently.
- **"Telegram bot is bound to agent X; cannot serve agent Y" in logs**:
  `maestro-relay send --agent Y --provider telegram` was called against a bot
  bound to a different agent. Use the bridge for agent Y instead, or run a
  second bridge instance for agent Y with its own bot.
- **No reactions appear (⏳)**: Telegram only allows a curated set of emoji
  reactions on messages. The bridge already falls back gracefully — typing
  indicators continue to work even if the reaction emoji isn't accepted in
  your chat type.
- **Voice messages aren't transcribed**: confirm `ffmpeg` and `whisper-cli`
  are on your `PATH` and `WHISPER_MODEL_PATH` points at a real model file.
  The setup is identical to the Discord provider's voice support.
