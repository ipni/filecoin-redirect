#!/usr/bin/env bash
# smoke.sh <base-url> <cid>...
# Runs the redirect router's checks against a deployed or local Pages URL.
# A payload CID 302s to the provider's /ipfs/<cid>?format=car and a piece CID to
# /piece/<cid>. Exit 0 unless at least one check FAILs.
set -uo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: smoke.sh <base-url> <cid>..." >&2
  exit 2
fi

base="$1"
shift
base="${base%/}"

status_of() {
  curl -s -o /dev/null -w '%{http_code}' "$1" || true
}

redirect_of() {
  curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$1" || true
}

fails=0

# Non-CID input must be rejected with 400.
code="$(status_of "$base/retrieve/notacid")"
if [ "$code" = "400" ]; then
  echo "PASS notacid -> 400"
else
  echo "FAIL notacid -> $code (want 400)"
  fails=1
fi

for cid in "$@"; do
  out="$(redirect_of "$base/retrieve/$cid")"
  code="${out%% *}"
  loc="${out#* }"
  if [ -z "$loc" ]; then
    loc="-"
  fi
  case "$code" in
    302)
      echo "PASS $cid -> 302 Location: $loc"
      target_code="$(curl -s -m 10 -o /dev/null -r 0-0 -w '%{http_code}' -A 'Mozilla/5.0' "$loc" || true)"
      echo "INFO   target $loc -> $target_code"
      ;;
    404)
      echo "WARN $cid -> 404 (no provider indexed)"
      ;;
    *)
      echo "FAIL $cid -> $code"
      fails=1
      ;;
  esac
done

exit "$fails"
