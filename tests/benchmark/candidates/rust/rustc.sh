#!/bin/sh
# Asks rustc for every call and every function of a cargo workspace, through the rustc-calls
# driver (rustc-calls/), as cargo's RUSTC_WORKSPACE_WRAPPER: only the workspace's own crates are
# analysed, every target and feature. Needs the nightly whose rustc-dev the driver was built
# against, the repo's dependencies fetched (cargo fetch), and the driver built:
#   (cd rustc-calls && CARGO_TARGET_DIR=<dir> cargo +nightly build --release)
#
#   rustc.sh <repo> <out dir> <target dir> <driver binary>
set -eu
SYS=$(rustup run nightly rustc --print sysroot)
rm -rf "$2"; mkdir -p "$2"
cd "$1"
DYLD_LIBRARY_PATH="$SYS/lib" LD_LIBRARY_PATH="$SYS/lib" RUSTC_CALLS_OUT="$2" RUSTC_WORKSPACE_WRAPPER="$4" CARGO_TARGET_DIR="$3" \
  cargo +nightly check --workspace --all-targets --all-features --offline
