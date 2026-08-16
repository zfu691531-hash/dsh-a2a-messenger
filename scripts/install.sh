#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
(
  cd "$project_dir"
  npm install
  npm link
)
printf '%s\n' 'Installed dsh-a2a. Run: dsh-a2a doctor'
