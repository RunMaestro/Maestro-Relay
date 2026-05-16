#!/usr/bin/env bash
# Service wrapper for the Maestro Relay.
# Subcommands: start | stop | restart | status | logs | deploy | update | uninstall | version
#
# Backwards-compat: legacy MAESTRO_BRIDGE_* / MAESTRO_DISCORD_* env vars are accepted as fallback.
# A legacy install at ~/.local/share/maestro-bridge or ~/.local/share/maestro-discord is auto-detected when
# the new install dir doesn't exist.

set -euo pipefail

# Resolve install paths with MAESTRO_BRIDGE_* / MAESTRO_DISCORD_* fallback for back-compat.
INSTALL_DIR="${MAESTRO_RELAY_HOME:-${MAESTRO_BRIDGE_HOME:-${MAESTRO_DISCORD_HOME:-}}}"
if [ -z "$INSTALL_DIR" ]; then
  if [ -d "$HOME/.local/share/maestro-relay" ]; then
    INSTALL_DIR="$HOME/.local/share/maestro-relay"
  elif [ -d "$HOME/.local/share/maestro-bridge" ]; then
    INSTALL_DIR="$HOME/.local/share/maestro-bridge"
  elif [ -d "$HOME/.local/share/maestro-discord" ]; then
    INSTALL_DIR="$HOME/.local/share/maestro-discord"
  else
    INSTALL_DIR="$HOME/.local/share/maestro-relay"
  fi
fi

XDG_CONFIG_PARENT="${XDG_CONFIG_HOME:-$HOME/.config}"
if [ -d "$XDG_CONFIG_PARENT/maestro-relay" ]; then
  CONFIG_DIR="$XDG_CONFIG_PARENT/maestro-relay"
elif [ -d "$XDG_CONFIG_PARENT/maestro-bridge" ]; then
  CONFIG_DIR="$XDG_CONFIG_PARENT/maestro-bridge"
elif [ -d "$XDG_CONFIG_PARENT/maestro-discord" ]; then
  CONFIG_DIR="$XDG_CONFIG_PARENT/maestro-discord"
else
  CONFIG_DIR="$XDG_CONFIG_PARENT/maestro-relay"
fi

BIN_DIR="${MAESTRO_RELAY_BIN_DIR:-${MAESTRO_BRIDGE_BIN_DIR:-${MAESTRO_DISCORD_BIN_DIR:-$HOME/.local/bin}}}"
REPO="${MAESTRO_RELAY_REPO:-${MAESTRO_BRIDGE_REPO:-${MAESTRO_DISCORD_REPO:-RunMaestro/Maestro-Relay}}}"
SERVICE_NAME="maestro-relay"
LAUNCHD_LABEL="sh.maestro.relay"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
# Legacy names — used by uninstall to clean up after a v0.0.x install.
LEGACY_SERVICE_NAME="maestro-discord"
LEGACY_LAUNCHD_LABEL="sh.maestro.discord"
LEGACY_LAUNCHD_PLIST="$HOME/Library/LaunchAgents/${LEGACY_LAUNCHD_LABEL}.plist"

die() { printf '✗ %s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*"; }

detect_os() {
  case "$(uname -s)" in
    Linux)  echo linux ;;
    Darwin) echo macos ;;
    *)      echo unsupported ;;
  esac
}

usage() {
  cat <<'EOF'
maestro-relay-ctl — control the Maestro Relay service.
(Aliases: maestro-bridge-ctl and maestro-discord-ctl, preserved for back-compat.)

Usage:
  maestro-relay-ctl <command>

Commands:
  start       Start the relay service
  stop        Stop the relay service
  restart     Restart the relay service
  status      Show service status
  logs        Tail service logs (Ctrl+C to stop)
  deploy      Deploy chat commands for enabled providers (Discord slash commands, Telegram bot commands)
  update      Reinstall the latest release (preserves config)
  uninstall   Remove the relay, service files, and CLI symlinks
  version     Print installed version

Environment:
  MAESTRO_RELAY_HOME    Override install dir  (default: ~/.local/share/maestro-relay)
  XDG_CONFIG_HOME        Config dir parent     (default: ~/.config)
  MAESTRO_RELAY_MODULE   Installer-time module selection (currently: discord)
  MAESTRO_BRIDGE_HOME    Accepted as fallback for back-compat
  MAESTRO_DISCORD_HOME   Accepted as fallback for back-compat with v0.0.x
EOF
}

require_install() {
  [ -d "$INSTALL_DIR" ] || die "Not installed at $INSTALL_DIR. Run install.sh first."
}

cmd_start() {
  require_install
  case "$(detect_os)" in
    linux)
      systemctl --user start "$SERVICE_NAME"
      info "Started $SERVICE_NAME (systemd user)"
      ;;
    macos)
      [ -f "$LAUNCHD_PLIST" ] || die "Plist not installed: $LAUNCHD_PLIST"
      launchctl load -w "$LAUNCHD_PLIST" 2>/dev/null || launchctl start "$LAUNCHD_LABEL"
      info "Started $LAUNCHD_LABEL (launchd)"
      ;;
    *) die "Unsupported OS for service management" ;;
  esac
}

cmd_stop() {
  case "$(detect_os)" in
    linux)
      systemctl --user stop "$SERVICE_NAME" || true
      info "Stopped $SERVICE_NAME"
      ;;
    macos)
      launchctl unload -w "$LAUNCHD_PLIST" 2>/dev/null || launchctl stop "$LAUNCHD_LABEL" || true
      info "Stopped $LAUNCHD_LABEL"
      ;;
    *) die "Unsupported OS for service management" ;;
  esac
}

cmd_restart() {
  cmd_stop || true
  cmd_start
}

cmd_status() {
  case "$(detect_os)" in
    linux) systemctl --user status "$SERVICE_NAME" --no-pager || true ;;
    macos) launchctl list | grep -F "$LAUNCHD_LABEL" || echo "(not loaded)" ;;
    *) die "Unsupported OS for service management" ;;
  esac
}

cmd_logs() {
  case "$(detect_os)" in
    linux) journalctl --user -u "$SERVICE_NAME" -f --no-pager ;;
    macos)
      local log_file="$INSTALL_DIR/logs/maestro-relay.log"
      mkdir -p "$INSTALL_DIR/logs"
      [ -f "$log_file" ] || touch "$log_file"
      tail -f "$log_file"
      ;;
    *) die "Unsupported OS for log tailing" ;;
  esac
}

config_complete() {
  local file="$1" key value enabled_providers provider
  [ -f "$file" ] || return 1
  enabled_providers="$(sed -nE 's/^[[:space:]]*ENABLED_PROVIDERS[[:space:]]*=[[:space:]]*([^#[:space:]]+).*/\1/p' "$file" | head -n1)"
  enabled_providers="${enabled_providers#\"}"; enabled_providers="${enabled_providers%\"}"
  enabled_providers="${enabled_providers#\'}"; enabled_providers="${enabled_providers%\'}"
  [ -n "$enabled_providers" ] || enabled_providers="discord"
  # Validate every enabled provider's required env vars (split CSV), not just
  # the first match — ENABLED_PROVIDERS=discord,telegram must pass only when
  # both credential sets are present.
  local IFS=','
  local required_keys=""
  for provider in $enabled_providers; do
    provider="${provider// /}"
    case "$provider" in
      telegram)
        required_keys="$required_keys TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID TELEGRAM_AGENT_ID"
        ;;
      slack)
        required_keys="$required_keys SLACK_BOT_TOKEN SLACK_SIGNING_SECRET SLACK_TEAM_ID SLACK_APP_ID"
        ;;
      discord|'')
        required_keys="$required_keys DISCORD_BOT_TOKEN DISCORD_CLIENT_ID DISCORD_GUILD_ID"
        ;;
      *) return 1 ;;
    esac
  done
  unset IFS
  for key in $required_keys; do
    value="$(sed -nE "s/^${key}=([^#[:space:]]+).*/\1/p" "$file" | head -n1)"
    [ -n "$value" ] || return 1
    case "$value" in
      your_*) return 1 ;;
    esac
  done
  return 0
}

cmd_deploy() {
  require_install
  local env_file="$INSTALL_DIR/.env"
  [ -f "$env_file" ] || die "Config missing: $env_file"
  if ! config_complete "$env_file"; then
    die "Config at $env_file is incomplete or contains template values. Edit it before running deploy."
  fi
  (cd "$INSTALL_DIR" && npm run deploy-commands --silent)
}

cmd_update() {
  info "Re-running installer to pull the latest release"
  local tag config_parent
  tag="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n1)"
  [ -n "$tag" ] || die "Could not resolve latest release tag"
  config_parent="$(dirname "$CONFIG_DIR")"
  curl -fsSL "https://raw.githubusercontent.com/${REPO}/${tag}/install.sh" \
    | env \
        MAESTRO_RELAY_HOME="$INSTALL_DIR" \
        MAESTRO_RELAY_BIN_DIR="$BIN_DIR" \
        MAESTRO_RELAY_REPO="$REPO" \
        XDG_CONFIG_HOME="$config_parent" \
        bash
}

cmd_uninstall() {
  read -r -p "Remove $INSTALL_DIR, service files, and CLI symlinks? [y/N] " ans
  case "${ans:-n}" in
    y|Y|yes|YES) ;;
    *) info "Aborted"; exit 0 ;;
  esac
  cmd_stop || true
  case "$(detect_os)" in
    linux)
      systemctl --user disable --now "$SERVICE_NAME" 2>/dev/null || true
      rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${SERVICE_NAME}.service"
      # Clean up legacy unit if present.
      systemctl --user disable --now maestro-bridge 2>/dev/null || true
      rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/maestro-bridge.service"
      systemctl --user disable --now "$LEGACY_SERVICE_NAME" 2>/dev/null || true
      rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${LEGACY_SERVICE_NAME}.service"
      systemctl --user daemon-reload || true
      systemctl --user reset-failed "$SERVICE_NAME" 2>/dev/null || true
      systemctl --user reset-failed "$LEGACY_SERVICE_NAME" 2>/dev/null || true
      ;;
    macos)
      rm -f "$LAUNCHD_PLIST"
      [ -f "$HOME/Library/LaunchAgents/sh.maestro.bridge.plist" ] && {
        launchctl unload -w "$HOME/Library/LaunchAgents/sh.maestro.bridge.plist" 2>/dev/null || true
        rm -f "$HOME/Library/LaunchAgents/sh.maestro.bridge.plist"
      }
      [ -f "$LEGACY_LAUNCHD_PLIST" ] && {
        launchctl unload -w "$LEGACY_LAUNCHD_PLIST" 2>/dev/null || true
        rm -f "$LEGACY_LAUNCHD_PLIST"
      }
      ;;
  esac
  rm -rf "$INSTALL_DIR"
  rm -f "$BIN_DIR/maestro-relay-ctl"
  rm -f "$BIN_DIR/maestro-bridge-ctl"
  rm -f "$BIN_DIR/maestro-discord-ctl"
  info "Uninstalled. Config preserved at $CONFIG_DIR (delete manually if desired)."
}

cmd_version() {
  if [ -f "$INSTALL_DIR/.version" ]; then
    cat "$INSTALL_DIR/.version"
  else
    die "No version file at $INSTALL_DIR/.version"
  fi
}

main() {
  local sub="${1:-}"
  case "$sub" in
    start)     cmd_start ;;
    stop)      cmd_stop ;;
    restart)   cmd_restart ;;
    status)    cmd_status ;;
    logs)      cmd_logs ;;
    deploy)    cmd_deploy ;;
    update)    cmd_update ;;
    uninstall) cmd_uninstall ;;
    version)   cmd_version ;;
    -h|--help|help|"") usage ;;
    *)         usage; exit 2 ;;
  esac
}

main "$@"
