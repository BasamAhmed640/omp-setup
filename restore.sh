#!/usr/bin/env bash
# Restore an omp-setup snapshot into ~/.omp/agent (Git Bash / WSL).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${OMP_AGENT_DIR:-$HOME/.omp/agent}"

echo "Source repo : $REPO_DIR"
echo "Destination : $DEST"
echo

if [ -e "$DEST" ]; then
  read -r -p "$DEST already exists. Overwrite matching files? [y/N] " ans
  case "${ans:-N}" in
    [yY]*) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

mkdir -p "$DEST"

# Config + small files
for f in config.yml config.yml.bak config.yml.pre-revert-backup models.yml \
         lsp.json lsp.json.bak last-changelog-version history.db; do
  [ -f "$REPO_DIR/agent/$f" ] && cp -p "$REPO_DIR/agent/$f" "$DEST/$f"
done

# Directories (merge, don't delete anything already there)
for d in agents extensions sessions blobs terminal-sessions; do
  [ -d "$REPO_DIR/agent/$d" ] && cp -rp "$REPO_DIR/agent/$d" "$DEST/"
done

echo
echo "Restored into $DEST"
echo "Next steps:"
echo "  1. Set DEEPSEEK_API_KEY (models.yml reads it from the environment)."
echo "  2. Log in to your other providers."
echo "  3. Fix executable paths in lsp.json if this isn't the original machine."
