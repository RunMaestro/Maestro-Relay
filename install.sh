#!/usr/bin/env bash
# Maestro Relay installer.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/RunMaestro/Maestro-Relay/main/install.sh | bash
# Re-run to upgrade to the latest release. Existing config is preserved.
# Optional: MAESTRO_RELAY_MODULE=discord|telegram (default: discord).
#   Run `MAESTRO_RELAY_MODULE=telegram bash install.sh` to install the Telegram bridge.
#
# Legacy MAESTRO_BRIDGE_* / MAESTRO_DISCORD_* env vars are accepted as fallback so v0.0.x
# installs upgrading via `maestro-discord-ctl update` keep working.

set -Eeuo pipefail

# Resolve config with MAESTRO_BRIDGE_* / MAESTRO_DISCORD_* fallback for back-compat.
REPO="${MAESTRO_RELAY_REPO:-${MAESTRO_BRIDGE_REPO:-${MAESTRO_DISCORD_REPO:-RunMaestro/Maestro-Relay}}}"
INSTALL_DIR="${MAESTRO_RELAY_HOME:-${MAESTRO_BRIDGE_HOME:-${MAESTRO_DISCORD_HOME:-$HOME/.local/share/maestro-relay}}}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/maestro-relay"
# If a legacy config dir exists and the new dir doesn't, prefer legacy location.
if [ ! -d "$CONFIG_DIR" ] && [ -d "${XDG_CONFIG_HOME:-$HOME/.config}/maestro-bridge" ]; then
  CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/maestro-bridge"
elif [ ! -d "$CONFIG_DIR" ] && [ -d "${XDG_CONFIG_HOME:-$HOME/.config}/maestro-discord" ]; then
  CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/maestro-discord"
fi
BIN_DIR="${MAESTRO_RELAY_BIN_DIR:-${MAESTRO_BRIDGE_BIN_DIR:-${MAESTRO_DISCORD_BIN_DIR:-$HOME/.local/bin}}}"
VERSION="${MAESTRO_RELAY_VERSION:-${MAESTRO_BRIDGE_VERSION:-${MAESTRO_DISCORD_VERSION:-latest}}}"
MODULE="${MAESTRO_RELAY_MODULE:-${MAESTRO_BRIDGE_MODULE:-discord}}"
NODE_MIN_MAJOR=22
RELEASE_BACKUP=""
RELEASE_TARBALL=""

VOICE_FFMPEG=""
VOICE_WHISPER=""
VOICE_MODEL=""
DEFAULT_MODEL_NAME="ggml-base.en.bin"
DEFAULT_MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${DEFAULT_MODEL_NAME}"

rollback_install() {
  if [ -n "$RELEASE_BACKUP" ] && [ -d "$RELEASE_BACKUP" ]; then
    rm -rf "$INSTALL_DIR"
    mv "$RELEASE_BACKUP" "$INSTALL_DIR"
    warn "Restored previous install from $RELEASE_BACKUP"
  fi
}

c_red()    { printf '\033[31m%s\033[0m' "$*"; }
c_green()  { printf '\033[32m%s\033[0m' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m' "$*"; }
c_blue()   { printf '\033[34m%s\033[0m' "$*"; }
c_bold()   { printf '\033[1m%s\033[0m' "$*"; }

info() { printf '%s %s\n' "$(c_blue '==>')" "$*"; }
ok()   { printf '%s %s\n' "$(c_green '✓')" "$*"; }
warn() { printf '%s %s\n' "$(c_yellow '!')" "$*" >&2; }
die()  { printf '%s %s\n' "$(c_red '✗')" "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1${2:+ — $2}"
}

# Real try-open of /dev/tty. `[ -r /dev/tty ]` returns true in some
# non-interactive contexts (e.g. `bash -c "$(curl ...)"`) where the
# subsequent `</dev/tty` redirect then fails noisily.
can_read_tty() {
  { : </dev/tty; } 2>/dev/null
}

detect_os() {
  case "$(uname -s)" in
    Linux)  echo linux ;;
    Darwin) echo macos ;;
    *)      die "Unsupported OS: $(uname -s). Linux and macOS only." ;;
  esac
}

check_node() {
  require_cmd node "install Node.js ${NODE_MIN_MAJOR}+ from https://nodejs.org/"
  require_cmd npm "install Node.js ${NODE_MIN_MAJOR}+ from https://nodejs.org/"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt "$NODE_MIN_MAJOR" ]; then
    die "Node.js ${NODE_MIN_MAJOR}+ required (found $(node --version))."
  fi
  ok "Node.js $(node --version)"
}

check_maestro_cli() {
  if command -v maestro-cli >/dev/null 2>&1; then
    ok "maestro-cli found ($(maestro-cli --version 2>/dev/null | head -n1 || echo 'version unknown'))"
  else
    warn "maestro-cli not found on PATH. The bridge will fail to relay messages until it is installed."
    warn "See https://docs.runmaestro.ai/cli for instructions."
  fi
}

normalize_module() {
  local raw="$1"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "$raw" in
    discord|'') echo "discord" ;;
    slack)      echo "slack" ;;
    telegram)   echo "telegram" ;;
    teams)      echo "teams" ;;
    *) die "Unsupported module/provider: $raw (supported: discord, slack, telegram, teams)" ;;
  esac
}

resolve_release() {
  local api_url tag
  if [ "$VERSION" = "latest" ]; then
    api_url="https://api.github.com/repos/${REPO}/releases/latest"
  else
    api_url="https://api.github.com/repos/${REPO}/releases/tags/${VERSION}"
  fi
  tag="$(curl -fsSL "$api_url" | sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n1)"
  [ -n "$tag" ] || die "Could not resolve release tag from ${api_url}"
  echo "$tag"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    return 1
  fi
}

download_release() {
  local tag="$1" dest="$2"
  local url="https://github.com/${REPO}/releases/download/${tag}/maestro-relay-${tag}.tar.gz"
  local sha_url="${url}.sha256"
  info "Downloading ${tag} from ${url}"
  curl -fsSL "$url" -o "$dest" || die "Download failed: $url"

  local sha_file expected actual
  sha_file="$(mktemp)"
  if curl -fsSL "$sha_url" -o "$sha_file" 2>/dev/null; then
    expected="$(awk '{print $1}' "$sha_file")"
    rm -f "$sha_file"
    if [ -z "$expected" ]; then
      die "Empty checksum at $sha_url"
    fi
    if ! actual="$(sha256_of "$dest")"; then
      warn "No sha256sum/shasum on PATH — skipping checksum verification"
      return
    fi
    if [ "$expected" != "$actual" ]; then
      die "Checksum mismatch for $url (expected $expected, got $actual)"
    fi
    ok "Verified SHA-256 checksum"
  else
    rm -f "$sha_file"
    warn "Checksum file not published at $sha_url — skipping verification"
  fi
}

install_release() {
  local tag="$1" tarball="$2"
  local staging
  staging="$(mktemp -d)"
  tar -xzf "$tarball" -C "$staging"
  local extracted
  extracted="$(find "$staging" -mindepth 1 -maxdepth 1 -type d | head -n1)"
  [ -n "$extracted" ] || extracted="$staging"

  mkdir -p "$INSTALL_DIR"
  if [ -d "$INSTALL_DIR/dist" ]; then
    RELEASE_BACKUP="${INSTALL_DIR}.backup.$(date +%s)"
    mv "$INSTALL_DIR" "$RELEASE_BACKUP"
    mkdir -p "$INSTALL_DIR"
    info "Backed up previous install to $RELEASE_BACKUP"
  fi

  cp -R "$extracted"/. "$INSTALL_DIR"/
  printf '%s\n' "$tag" > "$INSTALL_DIR/.version"

  if [ -n "$RELEASE_BACKUP" ] && [ -f "$RELEASE_BACKUP/maestro-bot.db" ] && [ ! -f "$INSTALL_DIR/maestro-bot.db" ]; then
    cp "$RELEASE_BACKUP/maestro-bot.db" "$INSTALL_DIR/maestro-bot.db"
    info "Preserved SQLite database"
  fi

  # Migrate .env from a legacy install (e.g. manual git clone) into the XDG
  # config dir so write_config will preserve it instead of writing a template.
  if [ -n "$RELEASE_BACKUP" ] \
     && [ -f "$RELEASE_BACKUP/.env" ] \
     && [ ! -L "$RELEASE_BACKUP/.env" ] \
     && [ ! -f "$CONFIG_DIR/.env" ]; then
    mkdir -p "$CONFIG_DIR"
    cp "$RELEASE_BACKUP/.env" "$CONFIG_DIR/.env"
    chmod 600 "$CONFIG_DIR/.env"
    info "Migrated existing .env → $CONFIG_DIR/.env"
  fi

  rm -rf "$staging"
  ok "Extracted release to $INSTALL_DIR"
}

install_deps() {
  info "Installing production dependencies (npm ci --omit=dev)…"
  (cd "$INSTALL_DIR" && npm ci --omit=dev --no-audit --no-fund --silent)
  ok "Dependencies installed"
}

prompt_var() {
  local desc="$2" default="${3:-}" current="${!1:-}"
  if [ -n "$current" ]; then
    echo "$current"
    return
  fi
  local prompt="  ${desc}"
  [ -n "$default" ] && prompt="${prompt} [${default}]"
  prompt="${prompt}: "
  local value=""
  if can_read_tty; then
    read -r -p "$prompt" value </dev/tty || true
  fi
  [ -z "$value" ] && value="$default"
  echo "$value"
}

write_config() {
  mkdir -p "$CONFIG_DIR"
  local env_file="$CONFIG_DIR/.env"
  if [ -f "$env_file" ]; then
    ok "Config exists at $env_file (preserving)"
    ln -sf "$env_file" "$INSTALL_DIR/.env"
    return
  fi

  MODULE="$(normalize_module "$MODULE")"
  case "$MODULE" in
    discord)  write_config_discord "$env_file" ;;
    slack)    write_config_slack "$env_file" ;;
    telegram) write_config_telegram "$env_file" ;;
    teams)    write_config_teams "$env_file" ;;
  esac
}

write_config_discord() {
  local env_file="$1"

  local interactive=0
  can_read_tty && interactive=1
  local have_required=0
  if [ -n "${DISCORD_BOT_TOKEN:-}" ] \
     && [ -n "${DISCORD_CLIENT_ID:-}" ] \
     && [ -n "${DISCORD_GUILD_ID:-}" ]; then
    have_required=1
  fi

  if [ "$interactive" -eq 0 ] && [ "$have_required" -eq 0 ]; then
    info "Non-interactive shell — writing template to $env_file (edit before starting)"
    cp "$INSTALL_DIR/.env.example" "$env_file"
    chmod 600 "$env_file"
    ln -sf "$env_file" "$INSTALL_DIR/.env"
    return
  fi

  if [ "$interactive" -eq 1 ]; then
    info "Configuring $env_file"
    echo "  Find these values in https://discord.com/developers/applications"
  else
    info "Writing config from environment to $env_file"
  fi

  local tmp_env
  tmp_env="$(mktemp "${env_file}.XXXXXX")"
  chmod 600 "$tmp_env"
  {
    printf '# Generated by install.sh on %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'ENABLED_PROVIDERS=%s\n' "$MODULE"
    printf 'API_PORT=3457\n'
    local token client_id guild_id allowed
    token="$(prompt_var DISCORD_BOT_TOKEN 'Discord bot token')"
    client_id="$(prompt_var DISCORD_CLIENT_ID 'Discord application (client) ID')"
    guild_id="$(prompt_var DISCORD_GUILD_ID 'Discord guild (server) ID')"
    allowed="$(prompt_var DISCORD_ALLOWED_USER_IDS 'Allowed user IDs (comma-separated, optional)')"
    printf 'DISCORD_BOT_TOKEN=%s\n' "$token"
    printf 'DISCORD_CLIENT_ID=%s\n' "$client_id"
    printf 'DISCORD_GUILD_ID=%s\n' "$guild_id"
    printf 'DISCORD_ALLOWED_USER_IDS=%s\n' "$allowed"
    printf 'DISCORD_MENTION_USER_ID=\n'
    printf 'FFMPEG_PATH=%s\n' "${VOICE_FFMPEG:-ffmpeg}"
    printf 'WHISPER_CLI_PATH=%s\n' "${VOICE_WHISPER:-whisper-cli}"
    printf 'WHISPER_MODEL_PATH=%s\n' "${VOICE_MODEL:-models/${DEFAULT_MODEL_NAME}}"
  } > "$tmp_env"
  mv "$tmp_env" "$env_file"
  ln -sf "$env_file" "$INSTALL_DIR/.env"
  ok "Wrote $env_file"
}

write_config_slack() {
  local env_file="$1"

  local interactive=0
  can_read_tty && interactive=1
  local have_required=0
  if [ -n "${SLACK_BOT_TOKEN:-}" ] \
     && [ -n "${SLACK_SIGNING_SECRET:-}" ] \
     && [ -n "${SLACK_TEAM_ID:-}" ] \
     && [ -n "${SLACK_APP_ID:-}" ]; then
    have_required=1
  fi

  if [ "$interactive" -eq 0 ] && [ "$have_required" -eq 0 ]; then
    info "Non-interactive shell — writing template to $env_file (edit before starting)"
    cp "$INSTALL_DIR/.env.example" "$env_file"
    chmod 600 "$env_file"
    ln -sf "$env_file" "$INSTALL_DIR/.env"
    return
  fi

  if [ "$interactive" -eq 1 ]; then
    info "Configuring $env_file"
    echo "  Find these values in https://api.slack.com/apps"
  else
    info "Writing config from environment to $env_file"
  fi

  local tmp_env
  tmp_env="$(mktemp "${env_file}.XXXXXX")"
  chmod 600 "$tmp_env"
  {
    printf '# Generated by install.sh on %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'ENABLED_PROVIDERS=%s\n' "$MODULE"
    printf 'API_PORT=3457\n'
    local bot_token signing_secret team_id app_id socket_token slack_allowed mention_user slack_port
    bot_token="$(prompt_var SLACK_BOT_TOKEN 'Slack bot token (xoxb-...)')"
    signing_secret="$(prompt_var SLACK_SIGNING_SECRET 'Slack signing secret')"
    team_id="$(prompt_var SLACK_TEAM_ID 'Slack team (workspace) ID')"
    app_id="$(prompt_var SLACK_APP_ID 'Slack app ID')"
    socket_token="$(prompt_var SLACK_SOCKET_MODE_TOKEN 'Slack Socket Mode app-level token (xapp-..., optional)')"
    slack_allowed="$(prompt_var SLACK_ALLOWED_USER_IDS 'Allowed Slack user IDs (comma-separated, optional)')"
    mention_user="$(prompt_var SLACK_MENTION_USER_ID 'Slack mention user ID (optional)')"
    slack_port="$(prompt_var SLACK_PORT 'Slack HTTP port (optional, default 3000)')"
    printf 'SLACK_BOT_TOKEN=%s\n' "$bot_token"
    printf 'SLACK_SIGNING_SECRET=%s\n' "$signing_secret"
    printf 'SLACK_TEAM_ID=%s\n' "$team_id"
    printf 'SLACK_APP_ID=%s\n' "$app_id"
    printf 'SLACK_SOCKET_MODE_TOKEN=%s\n' "$socket_token"
    printf 'SLACK_ALLOWED_USER_IDS=%s\n' "$slack_allowed"
    printf 'SLACK_MENTION_USER_ID=%s\n' "$mention_user"
    printf 'SLACK_PORT=%s\n' "${slack_port:-3000}"
    printf 'FFMPEG_PATH=%s\n' "${VOICE_FFMPEG:-ffmpeg}"
    printf 'WHISPER_CLI_PATH=%s\n' "${VOICE_WHISPER:-whisper-cli}"
    printf 'WHISPER_MODEL_PATH=%s\n' "${VOICE_MODEL:-models/${DEFAULT_MODEL_NAME}}"
  } > "$tmp_env"
  mv "$tmp_env" "$env_file"
  ln -sf "$env_file" "$INSTALL_DIR/.env"
  ok "Wrote $env_file"
}

write_config_teams() {
  local env_file="$1"

  local interactive=0
  can_read_tty && interactive=1
  local have_required=0
  if [ -n "${TEAMS_APP_ID:-}" ] \
     && [ -n "${TEAMS_APP_PASSWORD:-}" ] \
     && [ -n "${TEAMS_TENANT_ID:-}" ]; then
    have_required=1
  fi

  if [ "$interactive" -eq 0 ] && [ "$have_required" -eq 0 ]; then
    info "Non-interactive shell — writing template to $env_file (edit before starting)"
    cp "$INSTALL_DIR/.env.example" "$env_file"
    chmod 600 "$env_file"
    ln -sf "$env_file" "$INSTALL_DIR/.env"
    return
  fi

  if [ "$interactive" -eq 1 ]; then
    info "Configuring $env_file"
    echo "  Find these values in https://portal.azure.com (Entra app registration + Azure Bot) — see docs/teams.md"
  else
    info "Writing config from environment to $env_file"
  fi

  local tmp_env
  tmp_env="$(mktemp "${env_file}.XXXXXX")"
  chmod 600 "$tmp_env"
  {
    printf '# Generated by install.sh on %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'ENABLED_PROVIDERS=%s\n' "$MODULE"
    printf 'API_PORT=3457\n'
    local app_id app_password app_type tenant_id teams_port public_url teams_allowed mention_user
    app_id="$(prompt_var TEAMS_APP_ID 'Teams/Entra app (client) ID')"
    app_password="$(prompt_var TEAMS_APP_PASSWORD 'Teams app client secret')"
    app_type="$(prompt_var TEAMS_APP_TYPE 'Teams app type (SingleTenant|MultiTenant)' 'SingleTenant')"
    tenant_id="$(prompt_var TEAMS_TENANT_ID 'Entra tenant ID (required for SingleTenant)')"
    teams_port="$(prompt_var TEAMS_PORT 'Teams HTTP port for /api/messages (optional, default 3978)')"
    public_url="$(prompt_var TEAMS_PUBLIC_URL 'Public HTTPS base URL Teams POSTs to (optional)')"
    teams_allowed="$(prompt_var TEAMS_ALLOWED_USER_IDS 'Allowed Teams AAD object IDs (comma-separated, optional)')"
    mention_user="$(prompt_var TEAMS_MENTION_USER_ID 'Teams mention user ID (optional)')"
    printf 'TEAMS_APP_ID=%s\n' "$app_id"
    printf 'TEAMS_APP_PASSWORD=%s\n' "$app_password"
    printf 'TEAMS_APP_TYPE=%s\n' "${app_type:-SingleTenant}"
    printf 'TEAMS_TENANT_ID=%s\n' "$tenant_id"
    printf 'TEAMS_PORT=%s\n' "${teams_port:-3978}"
    printf 'TEAMS_PUBLIC_URL=%s\n' "$public_url"
    printf 'TEAMS_ALLOWED_USER_IDS=%s\n' "$teams_allowed"
    printf 'TEAMS_MENTION_USER_ID=%s\n' "$mention_user"
  } > "$tmp_env"
  mv "$tmp_env" "$env_file"
  ln -sf "$env_file" "$INSTALL_DIR/.env"
  ok "Wrote $env_file"
}

write_config_telegram() {
  local env_file="$1"

  local interactive=0
  can_read_tty && interactive=1
  local have_required=0
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] \
     && [ -n "${TELEGRAM_CHAT_ID:-}" ] \
     && [ -n "${TELEGRAM_AGENT_ID:-}" ]; then
    have_required=1
  fi

  if [ "$interactive" -eq 0 ] && [ "$have_required" -eq 0 ]; then
    info "Non-interactive shell — writing template to $env_file (edit before starting)"
    cp "$INSTALL_DIR/.env.example" "$env_file"
    chmod 600 "$env_file"
    ln -sf "$env_file" "$INSTALL_DIR/.env"
    return
  fi

  if [ "$interactive" -eq 1 ]; then
    info "Configuring Telegram provider"
    echo
    echo "  $(c_bold 'Step 1 — create your bot via @BotFather')"
    echo "    1. Open Telegram and search for @BotFather (https://t.me/BotFather)"
    echo "    2. Send /newbot and follow the prompts (give it a display name and username)"
    echo "    3. Copy the bot token BotFather returns (looks like 1234567890:ABC-XYZ...)"
    echo "    Full walkthrough with screenshots: docs/telegram-setup.md"
    echo
  else
    info "Writing Telegram config from environment to $env_file"
  fi
  local token
  token="$(prompt_var TELEGRAM_BOT_TOKEN 'Telegram bot token')"

  if [ "$interactive" -eq 1 ]; then
    echo
    echo "  $(c_bold 'Step 2 — pick a chat for your bot')"
    echo "    Recommended: a $(c_bold 'forum supergroup') (each Maestro session becomes its own topic)."
    echo "      a. Create a new Telegram group, then convert it to a supergroup (Group Settings → Group Type → Public/Private supergroup)"
    echo "      b. Enable Topics: Group Settings → Topics → toggle on"
    echo "      c. Add your bot as a member, promote to admin with 'Manage Topics' permission"
    echo "      d. Find the chat ID: forward any message from the group to @userinfobot — it replies with the supergroup ID (a negative number like -1001234567890)"
    echo
    echo "    Alternative: a private DM with your bot (simpler; no topics, sessions reset in place via /new)."
    echo "      a. In Telegram, search your bot's @username and send /start"
    echo "      b. Forward your /start message to @userinfobot to get your DM chat ID (positive number)"
    echo
  fi
  local chat_id
  chat_id="$(prompt_var TELEGRAM_CHAT_ID 'Telegram chat ID (supergroup or DM)')"

  if [ "$interactive" -eq 1 ]; then
    echo
    echo "  $(c_bold 'Step 3 — bind this bot to a Maestro agent')"
  fi
  local agent_id
  agent_id="$(pick_telegram_agent)"

  if [ "$interactive" -eq 1 ]; then
    echo
    echo "  $(c_bold 'Step 4 — restrict access (recommended)')"
    echo "    Comma-separated list of Telegram user IDs allowed to interact with the bot."
    echo "    Find your own user ID by sending any message to @userinfobot."
    echo "    Leave empty for no allowlist (anyone in the chat can use the bot)."
  fi
  local allowed
  allowed="$(prompt_var TELEGRAM_ALLOWED_USER_IDS 'Allowed user IDs (optional)')"

  local tmp_env
  tmp_env="$(mktemp "${env_file}.XXXXXX")"
  chmod 600 "$tmp_env"
  {
    printf '# Generated by install.sh on %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'ENABLED_PROVIDERS=telegram\n'
    printf 'API_PORT=3457\n'
    printf 'TELEGRAM_BOT_TOKEN=%s\n' "$token"
    printf 'TELEGRAM_CHAT_ID=%s\n' "$chat_id"
    printf 'TELEGRAM_AGENT_ID=%s\n' "$agent_id"
    printf 'TELEGRAM_ALLOWED_USER_IDS=%s\n' "$allowed"
    printf 'TELEGRAM_MENTION_USER_ID=\n'
    printf 'FFMPEG_PATH=%s\n' "${VOICE_FFMPEG:-ffmpeg}"
    printf 'WHISPER_CLI_PATH=%s\n' "${VOICE_WHISPER:-whisper-cli}"
    printf 'WHISPER_MODEL_PATH=%s\n' "${VOICE_MODEL:-models/${DEFAULT_MODEL_NAME}}"
  } > "$tmp_env"
  mv "$tmp_env" "$env_file"
  ln -sf "$env_file" "$INSTALL_DIR/.env"
  ok "Wrote $env_file"
}

pick_telegram_agent() {
  if [ -n "${TELEGRAM_AGENT_ID:-}" ]; then
    echo "$TELEGRAM_AGENT_ID"
    return
  fi
  if ! command -v maestro-cli >/dev/null 2>&1; then
    warn "maestro-cli not found on PATH — type the Maestro agent ID manually."
    prompt_var TELEGRAM_AGENT_ID 'Maestro agent ID'
    return
  fi

  local json
  json="$(maestro-cli list agents --json 2>/dev/null || echo '[]')"

  local parsed=""
  if command -v jq >/dev/null 2>&1; then
    parsed="$(printf '%s' "$json" | jq -r '.[] | (.id + "\t" + (.name // "(unnamed)"))' 2>/dev/null || true)"
  else
    parsed="$(printf '%s' "$json" | node -e '
let s = "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  try {
    const a = JSON.parse(s);
    if (!Array.isArray(a)) return;
    for (const x of a) {
      process.stdout.write((x.id || "") + "\t" + (x.name || "(unnamed)") + "\n");
    }
  } catch (e) {}
});
' 2>/dev/null || true)"
  fi

  if [ -z "$parsed" ]; then
    warn "No Maestro agents available — type the agent ID manually."
    prompt_var TELEGRAM_AGENT_ID 'Maestro agent ID'
    return
  fi

  local i=0
  local -a ids=()
  printf '    Available Maestro agents:\n' >&2
  while IFS=$'\t' read -r id name; do
    [ -z "$id" ] && continue
    i=$((i + 1))
    ids+=("$id")
    printf '      %d) %s  (id: %s)\n' "$i" "$name" "$id" >&2
  done <<< "$parsed"

  if [ "$i" -eq 0 ]; then
    warn "No Maestro agents parsed — type the agent ID manually."
    prompt_var TELEGRAM_AGENT_ID 'Maestro agent ID'
    return
  fi

  local choice=""
  if can_read_tty; then
    read -r -p "  Pick an agent by number (or paste an agent ID): " choice </dev/tty || true
  fi

  if [ -z "$choice" ]; then
    warn "No selection made — type the agent ID manually."
    prompt_var TELEGRAM_AGENT_ID 'Maestro agent ID'
    return
  fi

  # If choice is numeric, validate against the list size and re-prompt on
  # out-of-range. Out-of-range integers almost never resolve to a real Maestro
  # agent ID, so silently accepting them used to fail later at start time.
  while :; do
    case "$choice" in
      ''|*[!0-9]*)
        # Non-numeric input — treat as a raw agent ID and stop prompting.
        echo "$choice"
        return
        ;;
      *)
        if [ "$choice" -ge 1 ] && [ "$choice" -le "$i" ]; then
          echo "${ids[$((choice - 1))]}"
          return
        fi
        warn "Selection out of range (pick 1-$i, or paste an agent ID)."
        if can_read_tty; then
          read -r -p "  Re-pick: " choice </dev/tty || choice=""
          if [ -z "$choice" ]; then
            warn "No selection made — type the agent ID manually."
            prompt_var TELEGRAM_AGENT_ID 'Maestro agent ID'
            return
          fi
        else
          warn "Non-interactive shell — type the agent ID manually."
          prompt_var TELEGRAM_AGENT_ID 'Maestro agent ID'
          return
        fi
        ;;
    esac
  done
}

config_complete() {
  local file="$1" key value enabled provider
  [ -f "$file" ] || return 1
  enabled="$(sed -nE 's/^[[:space:]]*ENABLED_PROVIDERS[[:space:]]*=[[:space:]]*([^#[:space:]]+).*$/\1/p' "$file" | head -n1)"
  enabled="${enabled#\"}"; enabled="${enabled%\"}"
  enabled="${enabled#\'}"; enabled="${enabled%\'}"
  [ -n "$enabled" ] || enabled="discord"
  # Validate EVERY enabled provider's required env vars, not just the first
  # match — multi-provider deployments like ENABLED_PROVIDERS=discord,telegram
  # must have credentials for both.
  local IFS=','
  local -a required_keys=()
  for provider in $enabled; do
    provider="${provider// /}"
    case "$provider" in
      telegram)
        required_keys+=(TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID TELEGRAM_AGENT_ID)
        ;;
      slack)
        required_keys+=(SLACK_BOT_TOKEN SLACK_SIGNING_SECRET SLACK_TEAM_ID SLACK_APP_ID)
        ;;
      teams)
        required_keys+=(TEAMS_APP_ID TEAMS_APP_PASSWORD TEAMS_TENANT_ID)
        ;;
      discord|'')
        required_keys+=(DISCORD_BOT_TOKEN DISCORD_CLIENT_ID DISCORD_GUILD_ID)
        ;;
      *) return 1 ;;
    esac
  done
  unset IFS
  for key in "${required_keys[@]}"; do
    value="$(sed -nE "s/^${key}=([^#[:space:]]+).*/\1/p" "$file" | head -n1)"
    [ -n "$value" ] || return 1
    case "$value" in
      your_*) return 1 ;;
    esac
  done
  return 0
}

deploy_commands() {
  local env_file="$CONFIG_DIR/.env"
  if ! config_complete "$env_file"; then
    warn "Skipping command deployment — config at $env_file is incomplete or contains template values."
    warn "Edit it and run 'maestro-relay-ctl deploy' when ready."
    return
  fi
  info "Deploying chat commands"
  if (cd "$INSTALL_DIR" && npm run deploy-commands --silent); then
    ok "Commands deployed"
  else
    warn "Command deployment failed. Edit $env_file and re-run 'maestro-relay-ctl deploy'."
  fi
}

expand_tilde() {
  local p="$1"
  case "$p" in
    "~"|"~/"*) printf '%s' "${HOME}${p#\~}" ;;
    *) printf '%s' "$p" ;;
  esac
}

prompt_yes_no() {
  local prompt="$1" default="${2:-Y}" ans=""
  can_read_tty || { printf '%s' "$default"; return; }
  read -r -p "$prompt" ans </dev/tty || ans=""
  [ -z "$ans" ] && ans="$default"
  case "$ans" in
    y|Y|yes|YES) printf 'Y' ;;
    n|N|no|NO)   printf 'N' ;;
    *)           printf '%s' "$default" ;;
  esac
}

setup_voice_choose_model() {
  local model_env="${MAESTRO_RELAY_MODEL:-${MAESTRO_BRIDGE_MODEL:-${MAESTRO_DISCORD_MODEL:-}}}"
  if [ -n "$model_env" ]; then
    local m
    m="$(expand_tilde "$model_env")"
    if [ -f "$m" ]; then
      VOICE_MODEL="$m"
      ok "Using existing model from MAESTRO_RELAY_* env var: $m"
      return 0
    else
      warn "Configured model path ($m) not found — falling back to download"
    fi
  fi

  if can_read_tty; then
    if [ "$(prompt_yes_no '  Already have a whisper model downloaded? [y/N] ' N)" = "Y" ]; then
      local input m
      while :; do
        read -r -p "  Absolute path to .bin model: " input </dev/tty || input=""
        if [ -z "$input" ]; then
          warn "No path entered — falling back to download"
          break
        fi
        m="$(expand_tilde "$input")"
        if [ -f "$m" ]; then
          VOICE_MODEL="$m"
          ok "Using existing model: $m"
          return 0
        fi
        warn "File not found: $m"
      done
    fi
  fi

  local target_dir="$INSTALL_DIR/models"
  local target="$target_dir/$DEFAULT_MODEL_NAME"
  mkdir -p "$target_dir"

  if [ -f "$target" ]; then
    ok "Model already present: $target"
    VOICE_MODEL="$target"
    return 0
  fi

  info "Downloading $DEFAULT_MODEL_NAME (~142 MB) → $target"
  local tmp
  tmp="$(mktemp "${target}.XXXXXX")"
  if curl -fL --progress-bar "$DEFAULT_MODEL_URL" -o "$tmp"; then
    mv "$tmp" "$target"
    ok "Model downloaded"
    VOICE_MODEL="$target"
  else
    rm -f "$tmp"
    warn "Model download failed — voice transcription will stay disabled until WHISPER_MODEL_PATH is set."
  fi
  return 0
}

setup_voice() {
  # Existing config — leave it alone, never re-prompt or re-download on upgrade.
  if [ -f "$CONFIG_DIR/.env" ]; then
    return 0
  fi

  local ffmpeg_path whisper_path
  ffmpeg_path="$(command -v ffmpeg 2>/dev/null || true)"
  whisper_path="$(command -v whisper-cli 2>/dev/null || true)"

  if [ -z "$ffmpeg_path" ] || [ -z "$whisper_path" ]; then
    info "Voice transcription deps not on PATH — installing without voice"
    [ -z "$ffmpeg_path" ]  && warn "  ffmpeg not found"
    [ -z "$whisper_path" ] && warn "  whisper-cli not found"
    warn "Install both, then run 'maestro-relay-ctl update' to enable transcription."
    return 0
  fi

  ok "Found ffmpeg: $ffmpeg_path"
  ok "Found whisper-cli: $whisper_path"

  local enable=0
  local voice_env="${MAESTRO_RELAY_VOICE:-${MAESTRO_BRIDGE_VOICE:-${MAESTRO_DISCORD_VOICE:-}}}"
  if [ "$voice_env" = "1" ]; then
    enable=1
  elif [ "$voice_env" = "0" ]; then
    enable=0
  elif can_read_tty; then
    info "Configure voice transcription"
    if [ "$(prompt_yes_no '  Enable voice transcription? [Y/n] ' Y)" = "Y" ]; then
      enable=1
    fi
  else
    info "Non-interactive shell — skipping voice setup (set MAESTRO_RELAY_VOICE=1 to opt in)"
  fi

  if [ "$enable" -ne 1 ]; then
    info "Voice transcription not enabled — install will continue without it"
    return 0
  fi

  VOICE_FFMPEG="$ffmpeg_path"
  VOICE_WHISPER="$whisper_path"
  setup_voice_choose_model
  return 0
}

install_ctl() {
  mkdir -p "$BIN_DIR"
  local ctl="$INSTALL_DIR/bin/maestro-relay-ctl.sh"
  [ -f "$ctl" ] || die "Control script missing at $ctl"
  chmod +x "$ctl"
  ln -sf "$ctl" "$BIN_DIR/maestro-relay-ctl"
  ln -sf "$ctl" "$BIN_DIR/maestro-bridge-ctl"
  # Backwards-compat alias for users with `maestro-discord-ctl` in muscle memory
  # or in scripts. Both point at the same wrapper.
  ln -sf "$ctl" "$BIN_DIR/maestro-discord-ctl"
  ok "Installed maestro-relay-ctl → $BIN_DIR/maestro-relay-ctl (aliases: maestro-bridge-ctl, maestro-discord-ctl)"
  case ":$PATH:" in
    *":$BIN_DIR:"*) : ;;
    *) warn "$BIN_DIR is not on your PATH. Add it to your shell profile." ;;
  esac
}

install_service_linux() {
  command -v systemctl >/dev/null 2>&1 || { warn "systemctl not found — skipping service install."; return; }
  local unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$unit_dir"
  local template="$INSTALL_DIR/templates/maestro-relay.service"
  [ -f "$template" ] || { warn "Service template missing at $template"; return; }
  sed \
    -e "s|@INSTALL_DIR@|$INSTALL_DIR|g" \
    -e "s|@CONFIG_DIR@|$CONFIG_DIR|g" \
    -e "s|@NODE_BIN@|$(command -v node)|g" \
    "$template" > "$unit_dir/maestro-relay.service"
  # Disable+remove a legacy maestro-discord unit if present so we don't leave
  # two competing user services running on upgrade.
  if [ -f "$unit_dir/maestro-discord.service" ]; then
    systemctl --user disable --now maestro-discord 2>/dev/null || true
    rm -f "$unit_dir/maestro-discord.service"
    info "Removed legacy systemd unit maestro-discord.service"
  fi
  if [ -f "$unit_dir/maestro-bridge.service" ]; then
    systemctl --user disable --now maestro-bridge 2>/dev/null || true
    rm -f "$unit_dir/maestro-bridge.service"
    info "Removed legacy systemd unit maestro-bridge.service"
  fi
  systemctl --user daemon-reload || true
  ok "Installed systemd unit → $unit_dir/maestro-relay.service"
  echo "    Enable on login:  systemctl --user enable --now maestro-relay"
  echo "    (and optionally:  loginctl enable-linger \$USER)"
}

install_service_macos() {
  local plist_dir="$HOME/Library/LaunchAgents"
  mkdir -p "$plist_dir"
  mkdir -p "$INSTALL_DIR/logs"
  local template="$INSTALL_DIR/templates/sh.maestro.relay.plist"
  [ -f "$template" ] || { warn "Plist template missing at $template"; return; }
  sed \
    -e "s|@INSTALL_DIR@|$INSTALL_DIR|g" \
    -e "s|@CONFIG_DIR@|$CONFIG_DIR|g" \
    -e "s|@NODE_BIN@|$(command -v node)|g" \
    "$template" > "$plist_dir/sh.maestro.relay.plist"
  # Unload+remove a legacy launchd plist if present.
  if [ -f "$plist_dir/sh.maestro.discord.plist" ]; then
    launchctl unload -w "$plist_dir/sh.maestro.discord.plist" 2>/dev/null || true
    rm -f "$plist_dir/sh.maestro.discord.plist"
    info "Removed legacy launchd plist sh.maestro.discord.plist"
  fi
  if [ -f "$plist_dir/sh.maestro.bridge.plist" ]; then
    launchctl unload -w "$plist_dir/sh.maestro.bridge.plist" 2>/dev/null || true
    rm -f "$plist_dir/sh.maestro.bridge.plist"
    info "Removed legacy launchd plist sh.maestro.bridge.plist"
  fi
  ok "Installed launchd plist → $plist_dir/sh.maestro.relay.plist"
  echo "    Load at login:  launchctl load -w $plist_dir/sh.maestro.relay.plist"
}

install_service() {
  case "$(detect_os)" in
    linux) install_service_linux ;;
    macos) install_service_macos ;;
  esac
}

main() {
  c_bold 'Maestro Relay installer'
  echo
  echo

  require_cmd curl
  require_cmd tar
  require_cmd sed
  check_node
  check_maestro_cli

  local tag
  tag="$(resolve_release)"
  info "Target release: ${tag}"

  RELEASE_TARBALL="$(mktemp)"
  trap 'rm -f "$RELEASE_TARBALL"' EXIT
  download_release "$tag" "$RELEASE_TARBALL"
  trap 'rollback_install' ERR
  install_release "$tag" "$RELEASE_TARBALL"
  install_deps
  trap - ERR
  install_ctl
  setup_voice
  write_config
  deploy_commands
  install_service

  echo
  ok "$(c_bold 'Install complete') — version $(c_green "$tag")"
  echo
  echo "  Start:  $(c_bold 'maestro-relay-ctl start')"
  echo "  Logs:   $(c_bold 'maestro-relay-ctl logs')"
  echo "  Config: $CONFIG_DIR/.env"
  echo
}

main "$@"
