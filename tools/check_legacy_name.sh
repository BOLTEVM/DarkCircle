#!/usr/bin/env bash
# check_legacy_name.sh -- fail if the retired product name appears in any tracked text file.
#
#   bash tools/check_legacy_name.sh
#
# The multi-sig vault app is DarkSafe. The pattern is assembled from two parts so that this
# file does not match itself.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

head_part="safe"
tail_part="buddy"

if git grep -n -I -i -E "${head_part}[-_ .]?${tail_part}" -- .; then
  echo "check_legacy_name: the retired product name is back; the suite brand is DarkSafe" >&2
  exit 1
fi
echo "check_legacy_name: clean"
