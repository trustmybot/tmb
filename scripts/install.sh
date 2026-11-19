#!/bin/sh
# Installs tmb from the public release repo. No login needed.
#   curl -fsSL https://github.com/trustmybot/tmb-releases/releases/download/dev/install.sh | sh
# TMB_CHANNEL picks the channel (default: dev).
set -eu

channel="${TMB_CHANNEL:-dev}"
base_url="https://github.com/trustmybot/tmb-releases/releases/download/${channel}"
bin_dir="${HOME}/.tmb/bin"

fail() {
  echo "tmb install: $*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported OS $(uname -s); on Windows use install.ps1" ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac

asset="tmb-${os}-${arch}"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail "need sha256sum or shasum to verify the download"
  fi
}

tmp="$(mktemp -d "${TMPDIR:-/tmp}/tmb-install.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading ${asset} from the ${channel} channel..."
curl -fsSL "${base_url}/${asset}" -o "${tmp}/${asset}" || fail "download of ${asset} failed"
curl -fsSL "${base_url}/SHA256SUMS" -o "${tmp}/SHA256SUMS" || fail "download of SHA256SUMS failed"

expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "${tmp}/SHA256SUMS")"
[ -n "$expected" ] || fail "no checksum for ${asset} in SHA256SUMS"
actual="$(sha256 "${tmp}/${asset}")"
[ "$expected" = "$actual" ] || fail "checksum mismatch for ${asset}: expected ${expected}, got ${actual}"

mkdir -p "$bin_dir"
mv "${tmp}/${asset}" "${bin_dir}/tmb"
chmod +x "${bin_dir}/tmb"

echo "Installed $("${bin_dir}/tmb" --version) to ${bin_dir}/tmb"
case ":${PATH}:" in
  *":${bin_dir}:"*) ;;
  *)
    echo "Add tmb to your PATH, e.g. in your shell profile:"
    echo "  export PATH=\"\$HOME/.tmb/bin:\$PATH\""
    ;;
esac
