#!/bin/sh
# Agent chain (Level 4): a feature branch collects tasks across sessions. In a fresh copy of a
# small bun project whose origin is a local bare repository, one Claude Code session asks for a
# subtract function and a new session asks for multiply too. Passes when the record holds exactly
# one feature branch with at least two closed tasks, that branch's tree exports both functions
# from the math module and passes `bun test`, origin holds the same tip, and no task branch is
# left. Every check reads the record and git, never the agents' answers.
#   sh tests/agent-chain/feature.sh
# TMB_BIN          the tmb to set up with (default: tmb on PATH)
# TMB_AGENT_MODEL  the model claude runs (default: haiku)
# Needs a logged-in claude (or CLAUDE_CODE_OAUTH_TOKEN), git and bun. Exits 0 PASS, 1 FAIL, 2 when it cannot run.
set -u

here="$(cd "$(dirname "$0")" && pwd)"
# prompts/feature-1.txt and prompts/feature-2.txt are Human-authored, in a user's words: never
# edit them to make this test pass.
first_prompt="$(cat "${here}/prompts/feature-1.txt")"
second_prompt="$(cat "${here}/prompts/feature-2.txt")"
fixture="${here}/../agent-run/fixtures/math"
base_branch="main"
check="bun test"
tmb_bin="${TMB_BIN:-tmb}"
model="${TMB_AGENT_MODEL:-haiku}"
# As in tests/agent-run/worker.sh: tmb's tools, the subagent tool (Agent, or Task in older Claude
# Code), the file tools, and Bash as a whole, since no one is there to approve a prompt. Every
# call still goes through tmb's hooks: nothing here bypasses them.
allowed_tools='mcp__tmb__* Agent Task Read Glob Grep Edit Write Bash'

if ! command -v claude >/dev/null 2>&1; then
  echo "feature chain: claude (Claude Code) is not on PATH; install it and log in, then run this again." >&2
  exit 2
fi
if ! command -v "$tmb_bin" >/dev/null 2>&1; then
  echo "feature chain: tmb not found at '${tmb_bin}'; install it or set TMB_BIN." >&2
  exit 2
fi
for tool in git bun; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "feature chain: ${tool} is not on PATH; install it, then run this again." >&2
    exit 2
  fi
done

scratch="$(mktemp -d "${TMPDIR:-/tmp}/tmb-feature-chain.XXXXXX")" || exit 2
logs="$(mktemp -d "${TMPDIR:-/tmp}/tmb-feature-chain-logs.XXXXXX")" || exit 2
trap 'rm -rf "$scratch"' EXIT
project="${scratch}/project"
origin="${scratch}/origin.git"
tree="${scratch}/feature-tree"

fail() {
  echo "FAIL $1"
  exit 1
}

show() {
  echo "--- $1 (saved to $2) ---"
  cat "$2"
  echo "--- end of $1 ---"
}

# Prints the value `script` computes from the JSON that `tmb ... --json` printed to the file $1.
# The script sees the parsed JSON as `data`.
json() {
  bun -e "const data = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); console.log($2)" "$1"
}

mkdir "$project" || exit 2
cp -R "${fixture}/." "$project" || exit 2
# The fixture's add is wrong on purpose for the worker run; this chain is about collecting
# features, so the project starts green and every red check comes from the agents' own work.
cat >"${project}/src/math.ts" <<'EOF'
export function add(a: number, b: number): number {
  return a + b;
}
EOF
# The identity lives in the project's own git config, which the tasks' worktrees share.
if ! (cd "$project" && git init -q -b "$base_branch" && git config user.name "tmb feature chain" &&
  git config user.email "feature-chain@example.com" && git add . && git commit -q -m "Add the math project"); then
  fail "could not make the fixture project a git repository in ${project}"
fi
if ! (git init -q --bare "$origin" && cd "$project" && git remote add origin "$origin" && git push -q origin "$base_branch"); then
  fail "could not give the project a local bare repository as origin at ${origin}"
fi
if ! (cd "$project" && bun test) >"${logs}/base.log" 2>&1; then
  fail "the project's tests fail before any work, so a refused close would prove nothing: $(cat "${logs}/base.log")"
fi
if ! (cd "$project" && "$tmb_bin" setup --yes --base "$base_branch" --check "$check"); then
  fail "tmb setup failed in ${project}"
fi

# Runs one new claude session in the project; $1 is the prompt, $2 the log. No one answers in
# the run, so it starts in tmb's unattended mode.
ask() {
  (cd "$project" && TMB_UNATTENDED=1 claude -p "$1" --model "$model" --allowedTools "$allowed_tools") >"$2" 2>&1
}

echo "Session 1, asking claude (${model}): ${first_prompt}"
ask "$first_prompt" "${logs}/session-1.log"
first_status=$?
show "session 1 answer" "${logs}/session-1.log"
echo "Session 2, asking claude (${model}): ${second_prompt}"
ask "$second_prompt" "${logs}/session-2.log"
second_status=$?
show "session 2 answer" "${logs}/session-2.log"

[ "$first_status" -eq 0 ] || fail "session 1: claude exited ${first_status}"
[ "$second_status" -eq 0 ] || fail "session 2: claude exited ${second_status}"

record() {
  if ! (cd "$project" && "$tmb_bin" "$@" --json) >"${logs}/$1.json" 2>&1; then
    fail "tmb $* failed: $(cat "${logs}/$1.json")"
  fi
}

record feature list
features="$(json "${logs}/feature.json" 'data.length')"
[ "$features" = "1" ] || fail "the record holds ${features} feature branches, not one: $(cat "${logs}/feature.json")"
feature="$(json "${logs}/feature.json" 'data[0].name')"

record task list --state all
closed="$(json "${logs}/task.json" "data.filter((task) => task.state === 'closed' && task.feature === '${feature}').length")"
[ "$closed" -ge 2 ] || fail "the feature branch ${feature} has ${closed} closed tasks, not at least two: $(cat "${logs}/task.json")"

tip="$(cd "$project" && git rev-parse --verify --quiet "refs/heads/${feature}")" || fail "git has no branch ${feature}"
echo "--- git log ${base_branch}..${feature} ---"
(cd "$project" && git log --format='%h %s' "${base_branch}..${feature}")
echo "--- end of git log ---"

mkdir "$tree" || exit 2
(cd "$project" && git archive "$tip" | tar -x -C "$tree") || fail "could not check out ${feature} at ${tip}"
cat >"${scratch}/exports.ts" <<EOF
import * as math from "${tree}/src/math.ts";
const subtract = (math as Record<string, unknown>).subtract;
const multiply = (math as Record<string, unknown>).multiply;
if (typeof subtract !== "function" || typeof multiply !== "function") {
  console.log("src/math.ts exports " + Object.keys(math).join(", "));
  process.exit(1);
}
if (subtract(7, 3) !== 4 || multiply(4, 3) !== 12) {
  console.log("subtract(7, 3) = " + subtract(7, 3) + ", multiply(4, 3) = " + multiply(4, 3));
  process.exit(1);
}
EOF
exports="$(bun "${scratch}/exports.ts" 2>&1)" || fail "${feature} at ${tip} does not export a working subtract and multiply from src/math.ts: ${exports}"
if ! (cd "$tree" && bun test) >"${logs}/feature-test.log" 2>&1; then
  show "bun test on ${feature}" "${logs}/feature-test.log"
  fail "bun test fails on ${feature} at ${tip}"
fi

pushed="$(git --git-dir="$origin" rev-parse --verify --quiet "refs/heads/${feature}")" || fail "origin has no branch ${feature}, so it was never pushed as a backup"
[ "$pushed" = "$tip" ] || fail "origin's ${feature} is at ${pushed}, but the local tip is ${tip}"

task_branches="$(cd "$project" && git branch --list 'tmb/*')"
[ -z "$task_branches" ] || fail "task branches remain: ${task_branches}"

echo "PASS one feature branch ${feature} at ${tip} collected ${closed} closed tasks across two sessions, exports subtract and multiply, passes bun test and is backed up on origin"
