#!/bin/bash
set -euo pipefail

ZIP="$1"
DEST="$2"
PARENT_PID="$3"
LABEL="$4"
WORK="$(dirname "$ZIP")"
LOG="$WORK/update.log"
STATUS="$WORK/status.txt"
exec >"$LOG" 2>&1

fail() { printf 'Update failed: %s\n' "$1" >"$STATUS"; exit 1; }
trap 'fail "See update.log in $WORK"' ERR

# The CEP process must exit before its installed extension can be replaced.
for ((i=0; i<600; i++)); do
  if ! kill -0 "$PARENT_PID" 2>/dev/null; then break; fi
  sleep 1
done
if kill -0 "$PARENT_PID" 2>/dev/null; then fail "Premiere was not closed within 10 minutes."; fi

EXPANDED="$WORK/expanded"
rm -rf "$EXPANDED"
mkdir -p "$EXPANDED"
ditto -x -k "$ZIP" "$EXPANDED"
SOURCE="$EXPANDED/ISTV-Reel-Tool-$LABEL/com.istv.reeltool"
test -f "$SOURCE/CSXS/manifest.xml" || fail "The release ZIP has no Premiere extension."
test -f "$SOURCE/js/main.js" || fail "The release ZIP has no panel code."

BACKUP="$WORK/previous-extension"
rm -rf "$BACKUP"
if test -d "$DEST"; then mv "$DEST" "$BACKUP"; fi
if ! cp -R "$SOURCE" "$DEST"; then
  rm -rf "$DEST"
  if test -d "$BACKUP"; then mv "$BACKUP" "$DEST"; fi
  fail "Could not copy the new extension; the previous version was restored."
fi
find "$DEST/vendor/ffmpeg" -type f \( -name ffmpeg -o -name ffprobe \) -exec chmod +x {} \; 2>/dev/null || true
xattr -dr com.apple.quarantine "$DEST" >/dev/null 2>&1 || true
printf 'Update installed. Reopen Premiere Pro.\n' >"$STATUS"
