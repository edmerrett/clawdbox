#!/bin/bash
# Regenerate the explainer narration with Piper (offline neural TTS).
#   pip install piper-tts; voices from https://huggingface.co/rhasspy/piper-voices (en/en_GB/<name>/medium)
#   scripts/make-voice.sh path/to/en_GB-alan-medium.onnx
set -euo pipefail
MODEL="${1:?usage: make-voice.sh VOICE.onnx}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/docs/promo/voice"
mkdir -p "$OUT"
i=0
while IFS= read -r line; do
  printf '%s' "$line" | python3 -m piper -m "$MODEL" -f "$OUT/seg$i.wav" --length-scale 1.05 --sentence-silence 0.25
  ffmpeg -y -loglevel error -i "$OUT/seg$i.wav" -c:a aac -b:a 96k "$OUT/seg$i.m4a" && rm "$OUT/seg$i.wav"
  i=$((i + 1))
done < "$OUT/script.txt"
echo "wrote $i segments to $OUT (timing in timing.json)"
