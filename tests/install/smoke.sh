#!/bin/sh
# Install smoke test: runs the published installer into a throwaway HOME, then checks the
# installed binary end to end. Never touches the real HOME.
#   sh tests/install/smoke.sh [channel] [expected-version]
# channel defaults to dev; with an expected version, `tmb --version` must report it.
set -u

channel="${1:-${TMB_CHANNEL:-dev}}"
expected_version="${2:-${TMB_EXPECTED_VERSION:-}}"
installer_url="https://github.com/trustmybot/tmb-releases/releases/download/${channel}/install.sh"

failures=0
pass() { echo "PASS $*"; }
fail() {
  echo "FAIL $*"
  failures=$((failures + 1))
}
finish() {
  if [ "$failures" -eq 0 ]; then
    echo "install smoke: all checks passed"
    exit 0
  fi
  echo "install smoke: ${failures} check(s) failed" >&2
  exit 1
}

work="$(mktemp -d "${TMPDIR:-/tmp}/tmb-smoke.XXXXXX")" || {
  echo "FAIL could not make a temp dir"
  exit 1
}
trap 'rm -rf "$work"' EXIT
home="${work}/home"
project="${work}/project"
mkdir -p "$home" "$project"
tmb="${home}/.local/bin/tmb"

# Downloaded to a file and run from there, so a download failure is told apart from an install failure.
if curl -fsSL "$installer_url" -o "${work}/install.sh"; then
  pass "download installer from ${installer_url}"
else
  fail "download installer from ${installer_url}"
  finish
fi

# TMB_NO_MODIFY_PATH keeps the installer away from shell profiles; ZDOTDIR would point zsh's outside the temp HOME.
if env -u ZDOTDIR HOME="$home" TMB_CHANNEL="$channel" TMB_NO_MODIFY_PATH=1 sh "${work}/install.sh" >"${work}/install.log" 2>&1 &&
  [ -x "$tmb" ]; then
  pass "installer put tmb at \$HOME/.local/bin/tmb"
else
  sed 's/^/  | /' "${work}/install.log"
  fail "installer put tmb at \$HOME/.local/bin/tmb"
  finish
fi

version_line="$(HOME="$home" "$tmb" --version 2>&1)"
version_status=$?
installed_version="$(echo "$version_line" | awk '{ print $2 }')"
if [ "$version_status" -ne 0 ]; then
  fail "tmb --version exited ${version_status}: ${version_line}"
elif [ -n "$expected_version" ] && [ "$installed_version" != "$expected_version" ]; then
  fail "tmb --version: expected ${expected_version}, got '${version_line}'"
else
  pass "tmb --version: ${version_line}"
fi

if (cd "$project" && HOME="$home" git init -q && HOME="$home" "$tmb" setup >"${work}/setup.log" 2>&1) &&
  grep -q 'hook session-start' "${project}/.claude/settings.local.json" 2>/dev/null; then
  pass "tmb setup wired the SessionStart hook in a fresh git repo"
else
  sed 's/^/  | /' "${work}/setup.log" 2>/dev/null
  fail "tmb setup wired the SessionStart hook in a fresh git repo"
fi

hook_output="$(cd "$project" && echo '{}' | HOME="$home" "$tmb" hook session-start 2>"${work}/hook.err")"
if command -v python3 >/dev/null 2>&1; then
  hook_check="$(printf '%s' "$hook_output" | python3 -c '
import json, sys
try:
    out = json.load(sys.stdin)["hookSpecificOutput"]
except Exception as error:
    print("output is not the hook JSON: %s" % error)
    sys.exit(0)
if out.get("hookEventName") != "SessionStart":
    print("hookEventName is %r, not SessionStart" % out.get("hookEventName"))
elif "You are bro" not in str(out.get("additionalContext", "")):
    print("additionalContext lacks \"You are bro\"")
')"
else
  # No JSON parser on this machine: match the compact JSON the hook prints.
  hook_check=""
  case "$hook_output" in
    *'"hookEventName":"SessionStart"'*) ;;
    *) hook_check="hookEventName is not SessionStart" ;;
  esac
  case "$hook_output" in
    *'"additionalContext":"'*'You are bro'*) ;;
    *) hook_check="${hook_check:+$hook_check; }additionalContext lacks \"You are bro\"" ;;
  esac
fi
if [ -z "$hook_check" ]; then
  pass "tmb hook session-start answers as bro"
else
  sed 's/^/  | /' "${work}/hook.err"
  fail "tmb hook session-start: ${hook_check}"
fi

finish
