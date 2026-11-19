#!/bin/sh
# Reviewer agent run (Level 6): in a fresh copy of the small bun project, the Human lands a
# correct fix for add on the feature branch feat/fix-add through a task, then a real Claude Code
# session is asked to have the branch reviewed. Passes when the record holds a pass at the
# branch's tip from the reviewer, which tmb takes only from a reviewer run the host started.
#   sh tests/agent-run/reviewer.sh
# TMB_BIN          the tmb to set up with (default: tmb on PATH)
# TMB_AGENT_MODEL  the model claude runs (default: haiku)
# TMB_AGENT_LOG    where the answer is saved (default: a new file under $TMPDIR)
# Needs a logged-in claude (or CLAUDE_CODE_OAUTH_TOKEN), git and bun. Exits 0 PASS, 1 FAIL, 2 when it cannot run.
set -u

here="$(cd "$(dirname "$0")" && pwd)"
# prompts/reviewer.txt is Human-authored: never edit it to make this test pass.
prompt_file="${here}/prompts/reviewer.txt"
fixture="${here}/fixtures/math"
base_branch="main"
feature="feat/fix-add"
check="bun test"
tmb_bin="${TMB_BIN:-tmb}"
model="${TMB_AGENT_MODEL:-haiku}"
# As in worker.sh: tmb's tools, the subagent tool, the file tools and Bash; every call still goes through tmb's hooks.
allowed_tools='mcp__tmb__* Agent Task Read Glob Grep Edit Write Bash'

if ! command -v claude >/dev/null 2>&1; then
  echo "reviewer run: claude (Claude Code) is not on PATH; install it and log in, then run this again." >&2
  exit 2
fi
if ! command -v "$tmb_bin" >/dev/null 2>&1; then
  echo "reviewer run: tmb not found at '${tmb_bin}'; install it or set TMB_BIN." >&2
  exit 2
fi
for tool in git bun; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "reviewer run: ${tool} is not on PATH; install it, then run this again." >&2
    exit 2
  fi
done

project="$(mktemp -d "${TMPDIR:-/tmp}/tmb-reviewer-run.XXXXXX")" || exit 2
work="$(mktemp -d "${TMPDIR:-/tmp}/tmb-reviewer-run-work.XXXXXX")" || exit 2
trap 'rm -rf "$project" "$work"' EXIT
log="${TMB_AGENT_LOG:-$(mktemp "${TMPDIR:-/tmp}/tmb-reviewer-run-log.XXXXXX")}"

fail() {
  echo "FAIL $1"
  exit 1
}

# A text field at two spaces in a --json answer.
json_field() {
  sed -n 's/^  "'"$1"'": "\([^"]*\)",\{0,1\}$/\1/p' "$2" | head -n 1
}

cp -R "${fixture}/." "$project" || exit 2
# A bare origin that already holds the base branch, so the feature branch's backup push and the review have somewhere to go.
if ! (cd "$project" && git init -q -b "$base_branch" && git config user.name "tmb reviewer run" &&
  git config user.email "reviewer-run@example.com" && git add . && git commit -q -m "Add the math project" &&
  git init -q --bare "${work}/origin.git" && git remote add origin "${work}/origin.git" && git push -q origin "$base_branch"); then
  fail "could not make the fixture project a git repository with an origin in ${project}"
fi
if ! (cd "$project" && "$tmb_bin" setup --yes --base "$base_branch" --check "$check"); then
  fail "tmb setup failed in ${project}"
fi

# The Human lands the fix as a task on the feature branch, so there is a finished branch to review.
(cd "$project" && "$tmb_bin" issue create "add returns the wrong sum" --json) >"${work}/issue.json" 2>&1 || fail "tmb issue create failed: $(cat "${work}/issue.json")"
issue="$(json_field id "${work}/issue.json")"
(cd "$project" && "$tmb_bin" feature start "$feature") >"${work}/feature.log" 2>&1 || fail "tmb feature start failed: $(cat "${work}/feature.log")"
(cd "$project" && "$tmb_bin" task start "$issue" --kind code --intent "Make add return the sum" --file src/math.ts \
  --criterion "add(2, 3) is 5" --json) >"${work}/task.json" 2>&1 || fail "tmb task start failed: $(cat "${work}/task.json")"
task="$(json_field id "${work}/task.json")"
worktree="$(json_field worktree "${work}/task.json")"
[ -n "$task" ] && [ -d "$worktree" ] || fail "tmb task start gave no task or worktree: $(cat "${work}/task.json")"
sed 's/a - b/a + b/' "${worktree}/src/math.ts" >"${work}/math.ts" && cp "${work}/math.ts" "${worktree}/src/math.ts" || exit 2
(cd "$worktree" && git commit -q -am "Make add return the sum") || fail "could not commit the fix in ${worktree}"
(cd "$project" && "$tmb_bin" task close "$task") >"${work}/close.log" 2>&1 || fail "tmb task close failed: $(cat "${work}/close.log")"

echo "Asking claude (${model}): $(cat "$prompt_file")"
# No one answers in the run, so it starts in tmb's unattended mode.
(cd "$project" && TMB_UNATTENDED=1 claude -p "$(cat "$prompt_file")" --model "$model" --allowedTools "$allowed_tools") >"$log" 2>&1
claude_status=$?
echo "--- answer (saved to ${log}) ---"
cat "$log"
echo "--- end of answer ---"
if [ "$claude_status" -ne 0 ]; then
  fail "claude exited ${claude_status}"
fi

(cd "$project" && "$tmb_bin" feature brief "$feature") || fail "tmb feature brief ${feature} failed"
(cd "$project" && "$tmb_bin" feature brief "$feature" --json) >"${work}/brief.json" 2>&1 || fail "tmb feature brief --json failed: $(cat "${work}/brief.json")"
if [ "$(json_field coveredBy "${work}/brief.json")" != "review" ]; then
  fail "the record holds no reviewer's pass at the tip of ${feature}; the brief is above"
fi
echo "PASS the reviewer passed ${feature} at its tip $(json_field tip "${work}/brief.json")"
