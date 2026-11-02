#!/bin/bash
# Links the interior-photo-edit skill into ~/.claude/skills. Idempotent.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/skills/interior-photo-edit"
DEST_DIR="$HOME/.claude/skills"

mkdir -p "$DEST_DIR"
ln -sfn "$SRC" "$DEST_DIR/interior-photo-edit"
echo "Linked $DEST_DIR/interior-photo-edit -> $SRC"
