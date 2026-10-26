#!/usr/bin/env bash
# Symlink this checkout into a Claude Code skills directory so the agent can load SKILL.md.
# Usage: ./install.sh [skills-dir]   (default: $CLAUDE_CONFIG_DIR/skills or ~/.claude/skills)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dir="${1:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills}"
mkdir -p "$dir"
target="$dir/lightningcss-review"
if [ -e "$target" ] && [ ! -L "$target" ]; then
  echo "refusing to replace $target (not a symlink)" >&2
  exit 1
fi
ln -sfn "$here" "$target"
echo "linked $target -> $here"
echo "next: $here/bin/lcr doctor && $here/bin/lcr setup"
