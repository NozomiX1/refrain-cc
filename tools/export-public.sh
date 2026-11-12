#!/bin/sh
# Make the public copy of this repository: the tree committed at HEAD, the files that stay on the author's machine
# replaced by a one-line stub (so links to them still resolve), and one commit with no history: the history here
# holds every earlier version of those files. Pushing is left to the person.
# usage: REFRAIN_PUBLIC_EMAIL=<commit email> tools/export-public.sh <new dir> [more words that must not appear ...]
set -e
out=$1
[ -n "$out" ] && [ ! -e "$out" ] || { echo "usage: $0 <new dir> [words that must not appear ...]" >&2; exit 1; }
[ -n "$REFRAIN_PUBLIC_EMAIL" ] || { echo "set REFRAIN_PUBLIC_EMAIL: the public commit must not carry your own address" >&2; exit 1; }
shift
root=$(git rev-parse --show-toplevel)
mkdir -p "$out"
git -C "$root" archive HEAD | tar -x -C "$out"
for f in docs/log.md docs/assessment.md docs/archive/memory-plugin.md docs/archive/ai-native-game.md docs/research/transcript-annotation.md; do
  printf '%s\n' "这份文件只留在作者本机，不公开：里面是作者的个人情况或真实对话的内容。" > "$out/$f"
done
# Plans for the author's next project, not about this plugin; nothing public links to them.
rm "$out/docs/harness-kickoff.md" "$out/docs/research/h-harness-landscape.md"
# A home path or an email address other than the placeholders, or any word given, stops the export.
if grep -rnIE "/Users/[A-Za-z]|/home/[a-z]+/|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}" "$out" | grep -vE "/home/user/|user@example\.com|dev@example\.com|t@example\.com|noreply@anthropic\.com"; then
  echo "found the lines above; fix them before publishing" >&2; exit 1
fi
for w in "$@"; do
  if grep -rnIF -- "$w" "$out"; then echo "found \"$w\"; fix it before publishing" >&2; exit 1; fi
done
git -C "$out" init -q -b main
git -C "$out" add -A
git -C "$out" -c user.name=nozomi -c user.email="$REFRAIN_PUBLIC_EMAIL" commit -q -m "refrain: long-term memory for Claude Code"
echo "public copy in $out: $(git -C "$out" ls-files | wc -l | tr -d ' ') files, one commit"
