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
PORT="${PORT:-8788}"
SESSION="${SESSION:-void}"

# Pull the latest code if a token is configured (non-fatal — fall back to local).
if [ -n "${GIT_TOKEN:-}" ]; then
  branch="$(git rev-parse --abbrev-ref HEAD)"
  echo "→ pulling latest ($branch)…"
  git pull "https://${GIT_TOKEN}@github.com/Moonwuk/Nygame.git" "$branch" \
    || echo "  (pull failed — using the local checkout)"
fi

echo "→ installing dependencies…"
pnpm install

# (Re)start: kill any old session, then launch `pnpm host` (builds the HTML + runs
# the server on 0.0.0.0) detached so it keeps running after you log out.
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" "PORT=$PORT HOST=0.0.0.0 pnpm host"

cat <<EOF

✓ Server (re)starting in tmux session "$SESSION" on port $PORT.
    logs   : tmux attach -t $SESSION      (detach: Ctrl-b then d)
    health : curl -sS http://localhost:$PORT/health
    share  : http://<this-server-public-ip>:$PORT/   → Connect → Azure (p1) / Crimson (p2)

EOF
