#!/bin/sh
set -eu

npm unlink -g dsh-a2a-messenger >/dev/null 2>&1 || true
printf '%s\n' 'Unlinked dsh-a2a-messenger. Local data was not deleted.'
