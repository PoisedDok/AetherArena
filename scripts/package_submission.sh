#!/bin/bash
# AetherArena submission packager for Moodle (see module hand-in: PDF + ZIP).
#
# Produces: <student_id>.zip with tracked source from HEAD, minus bulky paths, plus
# videos/*.mp4 from the working tree (MP4 may be untracked; we merge it). Submission
# helper scripts under scripts/ are only in the ZIP if committed like any other file.
# Strips videos/*.mov from the archive if they were ever committed.
# Under docs/, only docs/architecture/ is kept; all other docs paths are removed.
#
# Moodle limits (verify on your year's page): typically 100MB per uploaded file and a
# cap on total submission size (e.g. 230MB for PDF + ZIP combined). This script fails
# if the ZIP exceeds 100MB.
#
# Before packaging, run: ./scripts/compress_submission_videos.sh
#
# Usage: ./scripts/package_submission.sh <student_id>
# Example: ./scripts/package_submission.sh 9804750w

set -euo pipefail

MAX_ZIP_BYTES=$((100 * 1024 * 1024))

if [ -z "${1:-}" ]; then
  echo "Usage: ./scripts/package_submission.sh <student_id>"
  echo "Example: ./scripts/package_submission.sh 9804750w"
  exit 1
fi

STUDENT_ID="$1"
OUTPUT_FILE="${STUDENT_ID}.zip"

cd "$(dirname "$0")/.."

if ! command -v git &>/dev/null; then
  echo "Error: git is required to create the archive."
  exit 1
fi

echo "Packaging AetherArena source for submission as ${OUTPUT_FILE} ..."

git archive --format=zip HEAD -o "$OUTPUT_FILE"

echo "Removing bulky test data, samples, and large assets from archive ..."

zip -d "$OUTPUT_FILE" \
  "aether-backend/services/docling/tests/data/*" \
  "sample/*" \
  "aether-backend/services/perplexica/.assets/*" \
  > /dev/null 2>&1 || true

echo "Keeping only docs/architecture under docs/ ..."
while IFS= read -r p; do
  [[ -z "$p" ]] && continue
  if [[ "$p" == "docs/architecture" || "$p" == docs/architecture/* ]]; then
    continue
  fi
  if [[ "$p" == docs/* ]]; then
    zip -d "$OUTPUT_FILE" "$p" > /dev/null 2>&1 || true
  fi
done < <(unzip -Z1 "$OUTPUT_FILE" | grep '^docs/' || true)

# Never ship ProRes/large screen captures in the ZIP
zip -d "$OUTPUT_FILE" "videos/*.mov" > /dev/null 2>&1 || true

shopt -s nullglob
to_add=(videos/*.mp4)
[ -f videos/README.txt ] && to_add+=(videos/README.txt)
if [ "${#to_add[@]}" -gt 0 ]; then
  echo "Merging into archive: ${to_add[*]}"
  zip -u "$OUTPUT_FILE" "${to_add[@]}"
fi
if ! compgen -G "videos/*.mp4" > /dev/null; then
  echo "Warning: no videos/*.mp4 found. For the presentation component, run:"
  echo "  ./scripts/compress_submission_videos.sh"
fi

BYTES=$(wc -c < "$OUTPUT_FILE" | tr -d ' ')
MB=$(awk -v b="$BYTES" 'BEGIN { printf "%.2f", b/1024/1024 }')
echo "Archive size: ${MB} MB (${BYTES} bytes)"

if [ "$BYTES" -gt "$MAX_ZIP_BYTES" ]; then
  echo "Error: ${OUTPUT_FILE} exceeds 100MB (${BYTES} > ${MAX_ZIP_BYTES})."
  echo "Remove large assets, extend zip -d patterns in this script, or split per marker instructions."
  exit 1
fi

echo "OK: ${OUTPUT_FILE} is within the per-file limit. Ensure PDF + ZIP combined fits your Moodle total cap."
echo "Submit separately: ${STUDENT_ID}.pdf (dissertation) and ${OUTPUT_FILE} (this archive)."
