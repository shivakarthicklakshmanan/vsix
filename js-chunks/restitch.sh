#!/usr/bin/env bash
# restitch.sh — reassemble the split TypeScript compiler files from 500 KB chunks.
# Usage:  bash restitch.sh
# Output: _tsc.stitched.js and typescript.stitched.js in this folder.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

cat "$here"/_tsc/_tsc.js.part*        > "$here/_tsc.stitched.js"
cat "$here"/typescript/typescript.js.part* > "$here/typescript.stitched.js"

echo "Reassembled. SHA256:"
sha256sum "$here/_tsc.stitched.js" "$here/typescript.stitched.js"
echo "Compare with manifest.txt to confirm integrity."
