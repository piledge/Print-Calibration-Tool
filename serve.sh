#!/bin/sh
# The tool needs an HTTP server: ES modules and the WASM will not load over
# file:// (same-origin). No other dependencies.
cd "$(dirname "$0")" && exec python3 -m http.server "${1:-8080}"
