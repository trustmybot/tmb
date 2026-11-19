#!/bin/sh
# Worker agent run (Level 3): in a fresh copy of a small bun project whose add returns the wrong
# sum, a real Claude Code session is asked to fix it. Passes when the record holds a task that
# was started and closed, which tmb allows only once its checks pass, and `bun test` passes at
# the commit that task closed at.
#   sh tests/agent-run/worker.sh
# TMB_BIN          the tmb to set up with (default: tmb on PATH)
# TMB_AGENT_MODEL  the model claude runs (default: haiku)
# TMB_AGENT_LOG    where the answer is saved (default: a new file under $TMPDIR)
# Needs a logged-in claude (or CLAUDE_CODE_OAUTH_TOKEN), git and bun. Exits 0 PASS, 1 FAIL, 2 when it cannot run.
set -u

here="$(cd "$(dirname "$0")" && pwd)"
# prompts/worker.txt is Human-authored: never edit it to make this test pass.
prompt_file="${here}/prompts/worker.txt"
fixture="${here}/fixtures/math"
base_branch="main"
check="bun test"
tmb_bin="${TMB_BIN:-tmb}"
model="${TMB_AGENT_MODEL:-haiku}"
# What the flow needs: tmb's tools, the subagent tool (Agent, or Task in older Claude Code), the
# file tools, and git and bun commands. Every call still goes through tmb's hooks.
allowed_tools='mcp__tmb__* Agent Task Read Glob Grep Edit Write Bash(git:*) Bash(bun:*)'

if ! command -v claude >/dev/null 2>&1; then
  echo "worker run: claude (Claude Code) is not on PATH; install it and log in, then run this again." >&2
  exit 2
fi
if ! command -v "$tmb_bin" >/dev/null 2>&1; then
  echo "worker run: tmb not found at '${tmb_bin}'; install it or set TMB_BIN." >&2
  exit 2
fi
for tool in git bun; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "worker run: ${tool} is not on PATH; install it, then run this again." >&2
    exit 2
  fi
done

project="$(mktemp -d "${TMPDIR:-/tmp}/tmb-worker-run.XXXXXX")" || exit 2
work="$(mktemp -d "${TMPDIR:-/tmp}/tmb-worker-run-work.XXXXXX")" || exit 2
trap 'rm -rf "$project" "$work"' EXIT
log="${TMB_AGENT_LOG:-$(mktemp "${TMPDIR:-/tmp}/tmb-worker-run-log.XXXXXX")}"

fail() {
  echo "FAIL $1"
  exit 1
}

show_answer() {
  echo "--- answer (saved to ${log}) ---"
  cat "$log"
  echo "--- end of answer ---"
}

cp -R "${fixture}/." "$project" || exit 2
# The identity lives in the project's own git config, which the task's worktree shares.
if ! (cd "$project" && git init -q -b "$base_branch" && git config user.name "tmb worker run" &&
  git config user.email "worker-run@tmb.invalid" && git add . && git commit -q -m "Add the math project"); then
  fail "could not make the fixture project a git repository in ${project}"
fi
if (cd "$project" && bun test) >"${work}/base.log" 2>&1; then
  fail "the fixture's tests already pass before any fix, so this run would prove nothing: $(cat "${work}/base.log")"
fi
if ! (cd "$project" && "$tmb_bin" setup --yes --base "$base_branch" --check "$check"); then
  fail "tmb setup failed in ${project}"
fi

echo "Asking claude (${model}): $(cat "$prompt_file")"
# No one answers in the run, so it starts in tmb's unattended mode.
(cd "$project" && TMB_UNATTENDED=1 claude -p "$(cat "$prompt_file")" --model "$model" --allowedTools "$allowed_tools") >"$log" 2>&1
claude_status=$?
show_answer

if [ "$claude_status" -ne 0 ]; then
  fail "claude exited ${claude_status}"
fi

# The text value of one of the task's own fields, which sit at two spaces in `task brief --json`;
# empty when the field is null.
brief_field() {
  sed -n 's/^  "'"$1"'": "\([^"]*\)",\{0,1\}$/\1/p' "$2" | head -n 1
}

if ! (cd "$project" && "$tmb_bin" task list --state all --json) >"${work}/tasks.json" 2>&1; then
  fail "tmb task list failed: $(cat "${work}/tasks.json")"
fi
task_ids="$(sed -n 's/^    "id": "\([0-9A-Z]*\)",$/\1/p' "${work}/tasks.json")"
if [ -z "$task_ids" ]; then
  fail "the record holds no task, so no task was started; the answer is above"
fi

closed=""
for id in $task_ids; do
  if ! (cd "$project" && "$tmb_bin" task brief "$id" --json) >"${work}/brief.json" 2>&1; then
    fail "tmb task brief ${id} failed: $(cat "${work}/brief.json")"
  fi
  if [ "$(brief_field state "${work}/brief.json")" = "closed" ]; then
    closed="$id"
    commit="$(brief_field commitSha "${work}/brief.json")"
    break
  fi
done
if [ -z "$closed" ]; then
  fail "a task was started but none closed, so its checks never passed at close; the record holds: $(cat "${work}/tasks.json")"
fi
if [ -z "$commit" ]; then
  fail "task ${closed} is closed but records no commit: $(cat "${work}/brief.json")"
fi
echo "Task ${closed} closed at commit ${commit}."

mkdir "${work}/at-commit" || exit 2
if ! (cd "$project" && git archive "$commit" | tar -x -C "${work}/at-commit"); then
  fail "could not check out commit ${commit} of task ${closed}"
fi
if ! (cd "${work}/at-commit" && bun test) >"${work}/at-commit.log" 2>&1; then
  echo "--- bun test at ${commit} ---"
  cat "${work}/at-commit.log"
  fail "bun test fails at commit ${commit}, the commit task ${closed} closed at"
fi
echo "PASS task ${closed} was started and closed with its checks passing, and bun test passes at its commit ${commit}"
