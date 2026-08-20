#!/usr/bin/env bash
# Cross-compile the live-control ASI plugin for Windows x64.
#
# The result runs inside the game's Proton prefix alongside OptiScaler, so it is
# a Windows DLL regardless of what the plugin itself is built on. zig cc bundles
# the mingw-w64 headers and libraries, so no separate toolchain is needed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-$here/../bin/decky_optiscaler_live.asi}"

command -v zig >/dev/null || { echo "zig not found (brew install zig)" >&2; exit 1; }

python3 "$here/../scripts/generate_asi_layout.py" >/dev/null

zig cc \
  -target x86_64-windows-gnu \
  -shared \
  -O2 \
  -fno-exceptions \
  -std=c++17 \
  -Wall -Wextra -Wno-unused-parameter -Wno-cast-function-type \
  -I"$here" \
  -s \
  -o "$out" \
  "$here/live.cpp" \
  -lpsapi -lkernel32

# The linker also drops an import library and debug symbols next to the output;
# neither belongs in the shipped plugin.
outdir="$(cd "$(dirname "$out")" && pwd)"
rm -f "$outdir/live.lib" "$outdir/$(basename "${out%.*}").pdb" "$outdir/${out##*/}.lib"

echo "built $out ($(wc -c < "$out" | tr -d ' ') bytes)"
