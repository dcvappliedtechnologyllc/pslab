#!/bin/bash
# Registers the pslab MCP server with Claude Desktop and (if available) Claude Code. Idempotent.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="$REPO/server/dist/index.js"
CONFIG="${PSLAB_DESKTOP_CONFIG:-$HOME/Library/Application Support/Claude/claude_desktop_config.json}"

# Claude Desktop does not inherit the shell's PATH, so register node by its absolute path.
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "node is not on PATH; install Node.js first." >&2
  exit 1
fi

python3 -I - "$CONFIG" "$ENTRY" "$NODE" <<'PY'
import json, os, sys, tempfile
path, entry, node = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = {}
if os.path.exists(path) and os.path.getsize(path) > 0:
    with open(path) as f:
        cfg = json.load(f)
want = {"command": node, "args": [entry]}
servers = cfg.setdefault("mcpServers", {})
if servers.get("pslab") == want:
    print("Claude Desktop: pslab already registered, no change.")
else:
    servers["pslab"] = want
    folder = os.path.dirname(path)
    os.makedirs(folder, exist_ok=True)
    # Write a temp file next to the config, then rename over it: a crash
    # mid-write never leaves a truncated config behind.
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".claude_desktop_config.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(cfg, f, indent=2)
            f.write("\n")
        if os.path.exists(path):
            os.chmod(tmp, os.stat(path).st_mode & 0o777)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    print("Claude Desktop: registered pslab in " + path)
PY

if command -v claude >/dev/null 2>&1; then
  claude mcp remove --scope user pslab >/dev/null 2>&1 || true
  claude mcp add --scope user pslab -- "$NODE" "$ENTRY"
  echo "Claude Code: registered pslab (user scope)."
else
  echo "Claude Code: 'claude' not on PATH, skipped."
fi
echo "Restart Claude Desktop to pick up the change. Build first with: npm run build -w server"
