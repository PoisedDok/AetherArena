#!/bin/bash
# Transcode Screen Recording masters in videos/*.mov to H.264/AAC MP4 for Moodle submission.
# Moodle hard limits: 100MB per file; keep .mov out of the ZIP (see package_submission.sh).
#
# Usage: ./scripts/compress_submission_videos.sh
# Requires: ffmpeg (brew install ffmpeg)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/videos"

if ! command -v ffmpeg &>/dev/null; then
  echo "Error: ffmpeg is required. Install with: brew install ffmpeg"
  exit 1
fi

shopt -s nullglob
movs=(*.mov)
if [ "${#movs[@]}" -eq 0 ]; then
  echo "No .mov files in videos/. Nothing to do."
  exit 0
fi

for f in "${movs[@]}"; do
  base="${f%.mov}"
  out="${base}.mp4"
  echo "Transcoding: $f -> $out"
  ffmpeg -y -hide_banner -loglevel error -i "$f" \
    -c:v libx264 -crf 32 -preset medium \
    -vf "scale='min(1280,iw)':-2" \
    -c:a aac -b:a 96k \
    -movflags +faststart \
    "$out"
  ls -lh "$f" "$out"
done

echo "Done. Commit or keep videos/*.mp4; exclude large videos/*.mov from submission (see .gitignore)."
