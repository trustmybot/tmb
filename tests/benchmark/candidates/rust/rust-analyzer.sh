#!/bin/sh
# Writes rust-analyzer's SCIP index of a cargo workspace, every feature on.
#   rust-analyzer.sh <repo> <out.scip> <target dir>
set -eu
CONFIG=$(mktemp)
echo '{"cargo":{"features":"all"}}' > "$CONFIG"
cd "$1"
CARGO_TARGET_DIR="$3" rust-analyzer scip . --output "$2" --config-path "$CONFIG"
rm -f "$CONFIG"
