#!/usr/bin/env bash
# Start all Fifos services with pm2. Run from repo root: ./scripts/startup.sh
# Idempotent for cron (e.g. after reboot): quiet, and || true so "already running" doesn't stop the script.

abort() {
  echo $1
  exit
}

set -e
cd "$(dirname "$0")"
export PATH="$PATH:$HOME/bin"
[[ -f $HOME/bin/bun   ]] || abort "no ~/bin/bun"
[[ -f $HOME/bin/node  ]] || abort "no ~/bin/node"
[[ -f $HOME/bin/pm2   ]] || abort "no ~/bin/pm2"

pm2 start ./fifos.sh >/dev/null 2>&1 || true
