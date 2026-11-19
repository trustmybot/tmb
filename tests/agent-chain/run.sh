#!/bin/sh
# Agent chain (Level 1): in a fresh git project set up with tmb, one Claude Code session has
# bro record an issue, and a new session must find it in the record at its start.
#   sh tests/agent-chain/run.sh
# TMB_BIN          the tmb to set up with (default: tmb on PATH)
# TMB_AGENT_MODEL  the model claude runs (default: haiku)
# Needs a logged-in claude (or CLAUDE_CODE_OAUTH_TOKEN). Exits 0 PASS, 1 FAIL, 2 when it cannot run.
set -u

here="$(cd "$(dirname "$0")" && pwd)"
# prompts/record.txt and prompts/resume.txt are bro-drafted from the Human's Level 1 criterion
# and wait for the Human's confirmation. Never edit them to make this test pass.
record_prompt="$(cat "${here}/prompts/record.txt")"
resume_prompt="$(cat "${here}/prompts/resume.txt")"
issue_title="Level 1 chain check"
tmb_bin="${TMB_BIN:-tmb}"
model="${TMB_AGENT_MODEL:-haiku}"

if ! command -v claude >/dev/null 2>&1; then
  echo "agent chain: claude (Claude Code) is not on PATH; install it and log in, then run this again." >&2
  exit 2
fi
if ! command -v "$tmb_bin" >/dev/null 2>&1; then
  echo "agent chain: tmb not found at '${tmb_bin}'; install it or set TMB_BIN." >&2
  exit 2
fi

project="$(mktemp -d "${TMPDIR:-/tmp}/tmb-agent-chain.XXXXXX")" || exit 2
logs="$(mktemp -d "${TMPDIR:-/tmp}/tmb-agent-chain-logs.XXXXXX")" || exit 2
trap 'rm -rf "$project"' EXIT

if ! (cd "$project" && git init -q && "$tmb_bin" setup); then
  echo "FAIL tmb setup failed in ${project}"
  exit 1
fi

# Runs one new claude session in the project with tmb's tools allowed; $1 is the prompt, $2 the log.
ask() {
  (cd "$project" && claude -p "$1" --model "$model" --allowedTools 'mcp__tmb__*') >"$2" 2>&1
}

show() {
  echo "--- $1 (saved to $2) ---"
  cat "$2"
  echo "--- end of $1 ---"
}

echo "Session 1, asking claude (${model}): ${record_prompt}"
ask "$record_prompt" "${logs}/record.log"
record_status=$?
show "session 1 answer" "${logs}/record.log"

echo "Session 2, asking claude (${model}): ${resume_prompt}"
ask "$resume_prompt" "${logs}/resume.log"
resume_status=$?
show "session 2 answer" "${logs}/resume.log"

if [ "$record_status" -ne 0 ]; then
  echo "FAIL session 1: claude exited ${record_status}"
  exit 1
fi
if ! (cd "$project" && "$tmb_bin" issue list --json) >"${logs}/issues.json" 2>&1; then
  echo "FAIL tmb issue list failed: $(cat "${logs}/issues.json")"
  exit 1
fi
if ! grep -Fq "\"title\": \"${issue_title}\"" "${logs}/issues.json"; then
  echo "FAIL session 1 recorded no issue titled '${issue_title}'; the record holds: $(cat "${logs}/issues.json")"
  exit 1
fi
if [ "$resume_status" -ne 0 ]; then
  echo "FAIL session 2: claude exited ${resume_status}"
  exit 1
fi
if ! grep -Fq "$issue_title" "${logs}/resume.log"; then
  echo "FAIL session 2's answer never names '${issue_title}'"
  exit 1
fi
echo "PASS session 1 recorded '${issue_title}' and session 2 found it"
