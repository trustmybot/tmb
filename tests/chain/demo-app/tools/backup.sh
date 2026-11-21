#!/usr/bin/env bash
# Copies the to-do file aside, with the date in its name.
set -euo pipefail

backup_file() {
  local source="$1"
  cp "$source" "${source}.$(date +%Y%m%d).bak"
}

main() {
  backup_file "${1:-todo.json}"
}

main "$@"
