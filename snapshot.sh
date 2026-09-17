#!/usr/bin/env bash
# Re-snapshot the live ~/.omp config into this repo.
#   ./snapshot.sh          -> copy + commit
#   ./snapshot.sh --push   -> copy + commit + push
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${OMP_AGENT_DIR:-$HOME/.omp/agent}"
DEST="$REPO_DIR/agent"

[ -d "$SRC" ] || { echo "No omp agent dir at $SRC"; exit 1; }

mkdir -p "$DEST"/{agents,extensions}

for f in config.yml config.yml.bak config.yml.pre-revert-backup models.yml \
         lsp.json lsp.json.bak last-changelog-version; do
  [ -f "$SRC/$f" ] && cp -p "$SRC/$f" "$DEST/$f"
done

for d in agents extensions sessions blobs terminal-sessions; do
  [ -d "$SRC/$d" ] || continue
  rm -rf "${DEST:?}/$d"
  cp -rp "$SRC/$d" "$DEST/"
done

# Freeze the live SQLite DB into a consistent snapshot
if [ -f "$SRC/history.db" ]; then
  rm -f "$DEST/history.db"
  sqlite3 "$SRC/history.db" ".backup '$(cygpath -m "$DEST/history.db" 2>/dev/null || echo "$DEST/history.db")'"
fi

touch "$DEST/agents/.gitkeep" "$DEST/extensions/.gitkeep"

cd "$REPO_DIR"
git add -A
if git diff --cached --quiet; then
  echo "No changes to snapshot."
else
  git commit -m "snapshot: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Committed."
fi

if [ "${1:-}" = "--push" ]; then
  git push
fi
