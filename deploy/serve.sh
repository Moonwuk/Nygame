#!/usr/bin/env bash
# deploy/serve.sh — one command to (re)build and (re)start the Void Dominion
# prototype server on a VPS, in a detached tmux session that survives SSH logout.
#
#   bash deploy/serve.sh            # pull (if a token is set) + install + (re)start
#
# Config (optional): copy deploy/server.env.example → deploy/server.env and set
#   PORT       — the port to serve on (default 8788; use 80 to drop the :port).
#   GIT_TOKEN  — a GitHub token, so this script can `git pull` updates for you.
# server.env is gitignored, so your token never gets committed.
set -euo pipefail
cd "$(dirname "$0")/.."  # repo root, regardless of where this is called from

# Load optional config.
if [ -f deploy/server.env ]; then
  set -a            # export everything sourced
  . deploy/server.env
  set +a
fi
# Strip CR/LF so a file saved with Windows line endings (scp/paste) doesn't leave a
# trailing \r that corrupts the port or silently breaks the token'd git pull.
strip() { printf '%s' "${1//[$'\r\n']/}"; }
PORT="$(strip "${PORT:-8788}")"
# Bind address. Default 0.0.0.0 (LAN/quick path). Behind a TLS reverse-proxy (Caddy,
# HTTPS-2.1) set HOST=127.0.0.1 so the plain port isn't reachable from the internet.
HOST="$(strip "${HOST:-0.0.0.0}")"
SESSION="$(strip "${SESSION:-void}")"
GIT_TOKEN="$(strip "${GIT_TOKEN:-}")"

# Pull the latest code if a token is configured (non-fatal — fall back to local).
# The token is fed through GIT_ASKPASS (an env var the helper reads), never put in
# the git URL/argv, so it can't be read from `ps` / /proc/<pid>/cmdline.
if [ -n "$GIT_TOKEN" ]; then
  branch="$(git rev-parse --abbrev-ref HEAD)"
  echo "→ pulling latest ($branch)…"
  askpass="$(mktemp)"
  printf '#!/bin/sh\nexec printf "%%s" "$GIT_TOKEN"\n' >"$askpass"
  chmod +x "$askpass"
  GIT_TOKEN="$GIT_TOKEN" GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 \
    git pull "https://x-access-token@github.com/Moonwuk/Nygame.git" "$branch" \
    || echo "  (pull failed — using the local checkout)"
  rm -f "$askpass"
else
  # No token set — pull via the existing origin. This is the RECOMMENDED setup:
  # point origin at a read-only SSH deploy key (git remote set-url origin
  # git@github.com:Moonwuk/Nygame.git) so the box holds no reusable secret at all.
  # Non-fatal: if there's no credential/remote, just serve the local checkout.
  echo "→ pulling latest…"
  git pull --ff-only 2>/dev/null || echo "  (pull skipped — serving the local checkout)"
fi

echo "→ installing dependencies…"
pnpm install

# (Re)start: kill any old session, then launch `pnpm host` (builds the HTML + runs
# the server on 0.0.0.0) detached so it keeps running after you log out.
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" "PORT=$PORT HOST=$HOST pnpm host"

# `tmux new-session -d` returns 0 the instant the session starts — it says nothing
# about whether the server actually bound. Poll /health so we report the truth.
printf '→ waiting for the server to come up'
up=""
for _ in $(seq 1 30); do
  if command -v curl >/dev/null 2>&1 && curl -fsS "http://localhost:$PORT/health" >/dev/null 2>&1; then
    up=1
    break
  fi
  printf '.'
  sleep 1
done
echo

if [ -n "$up" ]; then
  cat <<EOF

✓ Server up in tmux session "$SESSION" on port $PORT.
    logs   : tmux attach -t $SESSION      (detach: Ctrl-b then d)
    health : curl -sS http://localhost:$PORT/health
    share  : http://<this-server-public-ip>:$PORT/   → Connect → Azure (p1) / Crimson (p2)

EOF
else
  cat <<EOF

✗ Server did NOT answer http://localhost:$PORT/health within 30s.
    see why : tmux attach -t $SESSION   (if "no such session", it crashed on start)
    common  : port already in use (set PORT=…), or PORT<1024 without root.
EOF
  exit 1
fi
