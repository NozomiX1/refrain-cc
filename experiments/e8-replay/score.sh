#!/bin/sh
# Score one finished replay (E8): match against the key, then the fabrication check from e7.
# usage: score.sh <replay out dir>
set -e
cd "$(dirname "$0")"
d=$1
[ -f "$d/match.json" ] || node match.ts "$d" raw/key.json "$d/match.json"
[ -f "$d/facts.json" ] || node ../e7-scribe/facts.ts "$d" "$d/facts.json"
