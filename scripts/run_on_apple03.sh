#!/usr/bin/env bash
# Sync this repo to apple03 and build the .app there. Run from spark02.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="${REMOTE_HOST:-apple03}"
REMOTE_PATH="${REMOTE_PATH:-/Users/hasna/Workspace/hasna/opensource/open-notes}"

echo "==> rsync $REPO_ROOT -> $REMOTE_HOST:$REMOTE_PATH"
ssh "$REMOTE_HOST" "mkdir -p '$REMOTE_PATH'"
rsync -az --delete \
  --exclude '.git/' \
  --exclude '.build/' \
  --exclude 'dist/' \
  --exclude 'ai-sidecar/node_modules/' \
  "$REPO_ROOT/" "$REMOTE_HOST:$REMOTE_PATH/"

echo "==> building on $REMOTE_HOST"
ssh "$REMOTE_HOST" "cd '$REMOTE_PATH' && bash scripts/build_hasnanotes.sh"

echo ""
echo "Done. App built at $REMOTE_HOST:$REMOTE_PATH/dist/Hasna Notes.app"
