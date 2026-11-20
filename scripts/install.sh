#!/bin/sh
# Installs tmb from the public release repo. No login needed.
#   curl -fsSL https://github.com/trustmybot/tmb-releases/releases/download/dev/install.sh | sh
# TMB_CHANNEL picks the channel: dev (default), rc or stable. Each channel installs under its
# own name, so they live side by side: tmb follows stable, tmb-rc rc and tmb-dev dev, and each
# updates itself from its own channel between sessions.
# TMB_INSTALL_VERSION=X.Y.Z (or X.Y.Z-rc.N) installs that one release as tmb-X.Y.Z instead,
# which never updates itself.
# TMB_NO_MODIFY_PATH=1 leaves shell profiles alone and prints the PATH line instead.
set -eu

# The channel installed when TMB_CHANNEL is unset. dev until a stable release exists; then
# change it to stable, here and in install.ps1.
default_channel=dev

channel="${TMB_CHANNEL:-$default_channel}"
pinned="${TMB_INSTALL_VERSION:-}"
releases_url="${TMB_RELEASES_URL:-https://github.com/trustmybot/tmb-releases}"
releases_api="${TMB_RELEASES_API:-https://api.github.com/repos/trustmybot/tmb-releases}"
bin_dir="${HOME}/.local/bin"

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

# dev is a rolling release and stable is the release marked latest; rc's newest tag is read
# from the public releases API, as tmb's own update check does.
case "$channel" in
  dev | rc | stable) ;;
  *) fail "unknown channel ${channel}; use dev, rc or stable" ;;
esac
if [ -n "$pinned" ]; then
  pinned="${pinned#v}"
  # dev is one rolling release, so only rc and stable releases can be pinned.
  printf '%s' "$pinned" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$' ||
    fail "cannot pin ${pinned}: name a stable X.Y.Z or rc X.Y.Z-rc.N release"
  name="tmb-${pinned}"
  label="release v${pinned}"
  channel=pinned
elif [ "$channel" = stable ]; then
  name="tmb"
  label="${channel} channel"
else
  name="tmb-${channel}"
  label="${channel} channel"
fi

case "$channel" in
  pinned) base_url="${releases_url}/releases/download/v${pinned}" ;;
  dev) base_url="${releases_url}/releases/download/dev" ;;
  stable) base_url="${releases_url}/releases/latest/download" ;;
  rc)
    releases="$(curl -fsSL "${releases_api}/releases?per_page=100")" || fail "could not read the rc releases from ${releases_api}"
    rc_tag="$(printf '%s' "$releases" | tr ',' '\n' |
      sed -n 's/.*"tag_name": *"\(v[0-9]*\.[0-9]*\.[0-9]*-rc\.[0-9]*\)".*/\1/p' |
      awk '{ split(substr($0, 2), n, /[.]|-rc[.]/); printf "%09d%09d%09d%09d %s\n", n[1], n[2], n[3], n[4], $0 }' |
      sort | tail -n 1 | cut -d ' ' -f 2)"
    [ -n "$rc_tag" ] || fail "the rc channel has no release yet"
    base_url="${releases_url}/releases/download/${rc_tag}"
    ;;
esac

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

echo "Downloading ${asset} from the ${label}..."
curl -fsSL "${base_url}/${asset}" -o "${tmp}/${asset}" || fail "download of ${asset} failed"
curl -fsSL "${base_url}/SHA256SUMS" -o "${tmp}/SHA256SUMS" || fail "download of SHA256SUMS failed"

expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "${tmp}/SHA256SUMS")"
[ -n "$expected" ] || fail "no checksum for ${asset} in SHA256SUMS"
actual="$(sha256 "${tmp}/${asset}")"
[ "$expected" = "$actual" ] || fail "checksum mismatch for ${asset}: expected ${expected}, got ${actual}"

mkdir -p "$bin_dir"
mv "${tmp}/${asset}" "${bin_dir}/${name}"
chmod +x "${bin_dir}/${name}"

installed="$("${bin_dir}/${name}" --version)"
if [ -n "$pinned" ] && [ "$(printf '%s' "$installed" | cut -d ' ' -f 2)" != "$pinned" ]; then
  rm -f "${bin_dir}/${name}"
  fail "release v${pinned} holds ${installed}, not ${pinned}"
fi
echo "Installed ${name} at ${bin_dir}/${name}: ${installed}"

# Before the channels had their own names, every channel installed as tmb. Such a tmb keeps
# following the channel it was on, and projects set up with it keep calling it.
if [ "$name" != tmb ] && [ -x "${bin_dir}/tmb" ]; then
  legacy_version="$("${bin_dir}/tmb" --version 2>/dev/null | cut -d ' ' -f 2)" || legacy_version=""
  case "$legacy_version" in
    *-dev.* | *-rc.*) echo "${bin_dir}/tmb is ${legacy_version}, installed before the channels had their own names; it keeps following its channel. Run ${name} init in a project to move it to ${name}." ;;
  esac
fi

legacy_dir="${HOME}/.tmb/bin"
if [ -e "${legacy_dir}/tmb" ]; then
  rm -f "${legacy_dir}/tmb"
  rmdir "$legacy_dir" 2>/dev/null || true
  rmdir "${HOME}/.tmb" 2>/dev/null || true
  echo "Removed the old ~/.tmb/bin/tmb. In projects set up with it, run ${name} init again."
fi

login_shell="$(basename "${SHELL:-sh}")"
case "$login_shell" in
  zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" ;;
  bash)
    if [ "$os" = darwin ]; then profile="${HOME}/.bash_profile"; else profile="${HOME}/.bashrc"; fi
    ;;
  fish) profile="${HOME}/.config/fish/config.fish" ;;
  *) profile="${HOME}/.profile" ;;
esac
if [ "$login_shell" = fish ]; then
  path_line='fish_add_path $HOME/.local/bin'
else
  path_line='export PATH="$HOME/.local/bin:$PATH"'
fi
path_marker='# Added by the tmb installer'

case ":${PATH}:" in
  *":${bin_dir}:"*) ;;
  *)
    if [ "${TMB_NO_MODIFY_PATH:-}" = 1 ]; then
      echo "Add ~/.local/bin to your PATH, e.g. in ${profile}:"
      echo "  ${path_line}"
    else
      if ! grep -qxF "$path_marker" "$profile" 2>/dev/null; then
        mkdir -p "$(dirname "$profile")"
        printf '\n%s\n%s\n' "$path_marker" "$path_line" >>"$profile"
      fi
      echo "Added ~/.local/bin to your PATH in ${profile}. Open a new terminal, or run: ${path_line}"
    fi
    ;;
esac

echo "Run ${name} init in a project, then start claude there."
