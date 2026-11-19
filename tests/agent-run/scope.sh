#!/bin/sh
# Scope agent run (Level 5): in a fresh copy of a small shop whose loyalty discount is 10
# percent, a real Claude Code session is asked to make it 15. Passes when bro looked the code
# up in tmb's code graph before it started the task, and the task it started names the file
# that holds the discount among its files.
#   sh tests/agent-run/scope.sh
# TMB_BIN          the tmb to set up with (default: tmb on PATH)
# TMB_AGENT_MODEL  the model claude runs (default: haiku)
# TMB_AGENT_LOG    where the session's stream is saved (default: a new file under $TMPDIR)
# Needs a logged-in claude (or CLAUDE_CODE_OAUTH_TOKEN), git and bun. Exits 0 PASS, 1 FAIL, 2 when it cannot run.
set -u

here="$(cd "$(dirname "$0")" && pwd)"
# prompts/scope.txt is Human-authored: never edit it to make this test pass.
prompt_file="${here}/prompts/scope.txt"
fixture="${here}/fixtures/shop"
target="src/pricing/discount.ts"
base_branch="main"
check="bun test"
tmb_bin="${TMB_BIN:-tmb}"
model="${TMB_AGENT_MODEL:-haiku}"
# The same tools as the worker run: tmb's tools, the subagent tool, the file tools and Bash.
# Every call still goes through tmb's hooks: nothing here bypasses them.
allowed_tools='mcp__tmb__* Agent Task Read Glob Grep Edit Write Bash'

if ! command -v claude >/dev/null 2>&1; then
  echo "scope run: claude (Claude Code) is not on PATH; install it and log in, then run this again." >&2
  exit 2
fi
if ! command -v "$tmb_bin" >/dev/null 2>&1; then
  echo "scope run: tmb not found at '${tmb_bin}'; install it or set TMB_BIN." >&2
  exit 2
fi
for tool in git bun; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "scope run: ${tool} is not on PATH; install it, then run this again." >&2
    exit 2
  fi
done

project="$(mktemp -d "${TMPDIR:-/tmp}/tmb-scope-run.XXXXXX")" || exit 2
work="$(mktemp -d "${TMPDIR:-/tmp}/tmb-scope-run-work.XXXXXX")" || exit 2
trap 'rm -rf "$project" "$work"' EXIT
log="${TMB_AGENT_LOG:-$(mktemp "${TMPDIR:-/tmp}/tmb-scope-run-log.XXXXXX")}"

fail() {
  echo "FAIL $1"
  exit 1
}

cp -R "${fixture}/." "$project" || exit 2
if ! (cd "$project" && git init -q -b "$base_branch" && git config user.name "tmb scope run" &&
  git config user.email "scope-run@example.com" && git add . && git commit -q -m "Add the shop"); then
  fail "could not make the fixture project a git repository in ${project}"
fi
if ! (cd "$project" && "$tmb_bin" setup --yes --base "$base_branch" --check "$check"); then
  fail "tmb setup failed in ${project}"
fi

echo "Asking claude (${model}): $(cat "$prompt_file")"
# No one answers in the run, so it starts in tmb's unattended mode. The stream records every
# tool call in order, which is what this run checks.
(cd "$project" && TMB_UNATTENDED=1 claude -p "$(cat "$prompt_file")" --model "$model" --allowedTools "$allowed_tools" \
  --output-format stream-json --verbose) >"$log" 2>&1
claude_status=$?
echo "--- session stream saved to ${log} ---"
# The tool calls in the order they were made, one name per line.
grep -o '"type":"tool_use","id":"[^"]*","name":"[^"]*"' "$log" | sed 's/.*"name":"\([^"]*\)"/\1/' >"${work}/calls.txt"
echo "Tool calls, in order:"
sed 's/^/  /' "${work}/calls.txt"

if [ "$claude_status" -ne 0 ]; then
  fail "claude exited ${claude_status}"
fi

first_graph="$(grep -n '^mcp__tmb__graph_' "${work}/calls.txt" | head -n 1 | cut -d: -f1)"
first_start="$(grep -n '^mcp__tmb__task_start$' "${work}/calls.txt" | head -n 1 | cut -d: -f1)"
if [ -z "$first_start" ]; then
  fail "bro never called task_start, so no task was scoped"
fi
if [ -z "$first_graph" ] || [ "$first_graph" -gt "$first_start" ]; then
  fail "bro started the task (call ${first_start}) without a code graph lookup before it"
fi
reads="$(head -n "$first_start" "${work}/calls.txt" | grep -c '^\(Read\|Grep\|Glob\)$')"
echo "Before task_start: the first code graph lookup was call ${first_graph}, and bro made ${reads} file reads or searches."

if ! (cd "$project" && "$tmb_bin" task list --state all --json) >"${work}/tasks.json" 2>&1; then
  fail "tmb task list failed: $(cat "${work}/tasks.json")"
fi
task_id="$(sed -n 's/^    "id": "\([0-9A-Z]*\)",$/\1/p' "${work}/tasks.json" | head -n 1)"
if [ -z "$task_id" ]; then
  fail "the record holds no task: $(cat "${work}/tasks.json")"
fi
if ! (cd "$project" && "$tmb_bin" task brief "$task_id" --json) >"${work}/brief.json" 2>&1; then
  fail "tmb task brief ${task_id} failed: $(cat "${work}/brief.json")"
fi
# The task's files, one per line, from its spec.
files="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).spec.files.join("\n"))' "${work}/brief.json")"
echo "Task ${task_id} files: $(echo "$files" | tr '\n' ' ')"
covered=""
for file in $files; do
  case "$target" in
    "$file" | "${file%/}"/*) covered="$file" ;;
  esac
done
if [ -z "$covered" ]; then
  fail "task ${task_id} does not hold ${target}, where the loyalty discount lives; its files are: $(echo "$files" | tr '\n' ' ')"
fi
echo "PASS bro looked the code up in the code graph before it started task ${task_id}, whose files hold ${target} (as ${covered})"
