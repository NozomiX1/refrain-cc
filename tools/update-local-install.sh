#!/bin/sh
# Install refrain in a local project, or refresh it there, from this repository's last commit. CC copies a directory
# marketplace into its plugin cache, working tree and all (experiments/*/raw holds real data), so the marketplace
# points at a clean `git archive` of HEAD instead, never at the working directory. `claude plugin update` goes by the
# version number, which does not move between commits, so this reinstalls. A project seeing refrain for the first
# time has nothing to uninstall and has not declared the marketplace yet.
# usage: tools/update-local-install.sh <project dir>   (installs with --scope local)
set -e
project=$1
[ -d "$project" ] || { echo "usage: $0 <project dir>" >&2; exit 1; }
src="$HOME/.claude/plugin-src/refrain"
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
rm -rf "$src" && mkdir -p "$src"
git -C "$root" archive HEAD | tar -x -C "$src"
cd "$project"
claude plugin uninstall refrain@refrain --scope local 2>/dev/null || true
claude plugin uninstall refrain-timer@refrain --scope local 2>/dev/null || true
rm -rf "$HOME/.claude/plugins/cache/refrain"
claude plugin marketplace update refrain 2>/dev/null || claude plugin marketplace add "$src" --scope local
claude plugin install refrain@refrain --scope local
echo "installed $(git -C "$root" rev-parse --short HEAD); takes effect in the next session (or /reload-plugins)"
