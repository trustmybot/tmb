#!/bin/sh
# Agent run: sets tmb up in a fresh git project, greets a real Claude Code session with the
# Human's prompt, and passes when the answer comes from bro.
#   sh tests/agent-run/run.sh
# TMB_BIN       the tmb to set up with (default: tmb on PATH)
# TMB_AGENT_MODEL  the model claude runs (default: haiku)
# TMB_AGENT_LOG    where the answer is saved (default: a new file under $TMPDIR)
# Needs a logged-in claude (or CLAUDE_CODE_OAUTH_TOKEN). Exits 0 PASS, 1 FAIL, 2 when it cannot run.
set -u

here="$(cd "$(dirname "$0")" && pwd)"
# prompts/wake-up.txt is Human-authored: never edit it to make this test pass.
prompt_file="${here}/prompts/wake-up.txt"
tmb_bin="${TMB_BIN:-tmb}"
model="${TMB_AGENT_MODEL:-haiku}"

if ! command -v claude >/dev/null 2>&1; then
  echo "agent run: claude (Claude Code) is not on PATH; install it and log in, then run this again." >&2
  exit 2
fi
if ! command -v "$tmb_bin" >/dev/null 2>&1; then
  echo "agent run: tmb not found at '${tmb_bin}'; install it or set TMB_BIN." >&2
  exit 2
fi

project="$(mktemp -d "${TMPDIR:-/tmp}/tmb-agent-run.XXXXXX")" || exit 2
trap 'rm -rf "$project"' EXIT
log="${TMB_AGENT_LOG:-$(mktemp "${TMPDIR:-/tmp}/tmb-agent-run-log.XXXXXX")}"

if ! (cd "$project" && git init -q && "$tmb_bin" setup); then
  echo "FAIL tmb setup failed in ${project}"
  exit 1
fi

# With no terminal, setup takes each default: the host, the project's branch and agile.
if ! settings="$(cd "$project" && "$tmb_bin" config)"; then
  echo "FAIL tmb config failed after setup in ${project}"
  exit 1
fi
for line in '^host: [^ ]' '^base branch: [^ ]' '^review mode: agile$'; do
  if ! printf '%s\n' "$settings" | grep -Eq "$line"; then
    echo "FAIL tmb config after setup has no line matching '${line}'; it showed:"
    printf '%s\n' "$settings"
    exit 1
  fi
done
echo "tmb config after setup:"
printf '%s\n' "$settings"

echo "Asking claude (${model}): $(cat "$prompt_file")"
# No one answers in the run, so it starts in tmb's unattended mode.
(cd "$project" && TMB_UNATTENDED=1 claude -p "$(cat "$prompt_file")" --model "$model") >"$log" 2>&1
claude_status=$?

echo "--- answer (saved to ${log}) ---"
cat "$log"
echo "--- end of answer ---"

if [ "$claude_status" -ne 0 ]; then
  echo "FAIL claude exited ${claude_status}"
  exit 1
fi
if ! grep -Eiwq 'bro' "$log"; then
  echo "FAIL the answer never names bro"
  exit 1
fi
# Signs of a plain assistant that got no role from the SessionStart hook.
unconfigured='(do not|don.t) have (a|any) (specific |particular |defined )?(role|persona)|no (specific |particular |defined )?(role|persona)|not sure (who|what) .?bro|who is .?bro|i(.m| am) claude\b'
if grep -Eiq "$unconfigured" "$log"; then
  echo "FAIL the answer reads as an unconfigured assistant: $(grep -Eio "$unconfigured" "$log" | head -n 1)"
  exit 1
fi
echo "PASS the answer identifies itself as bro"
