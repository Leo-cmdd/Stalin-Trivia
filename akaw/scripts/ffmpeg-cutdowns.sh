#!/usr/bin/env bash
# Cutdowns, poster and GIF from one master video, with FFmpeg only.
#   scripts/ffmpeg-cutdowns.sh <master.mp4> <out-dir> [lengths...]   (default lengths: 15 30 59)
# Use it as a step command for video variants, e.g. "command": "scripts/ffmpeg-cutdowns.sh {out}/master.mp4 {out}"
set -euo pipefail
in="$1"; out="$2"; shift 2
lengths=("${@:-15 30 59}"); [ $# -eq 0 ] && lengths=(15 30 59)
mkdir -p "$out"
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$in" | cut -d. -f1)
base=$(basename "${in%.*}")
for L in "${lengths[@]}"; do
  if [ "$dur" -lt "$L" ]; then echo "skip ${L}s: master is ${dur}s" >&2; continue; fi
  ffmpeg -y -loglevel error -i "$in" -t "$L" -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart "$out/${base}_${L}s.mp4"
done
ffmpeg -y -loglevel error -ss 1 -i "$in" -frames:v 1 "$out/${base}_poster.jpg"
ffmpeg -y -loglevel error -t 6 -i "$in" -vf "fps=12,scale=320:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" "$out/${base}.gif"
echo "{\"files\": [$(ls "$out"/${base}_*s.mp4 2>/dev/null | sed 's/.*/"&"/' | paste -sd,)]}" > "$out/result.json"
