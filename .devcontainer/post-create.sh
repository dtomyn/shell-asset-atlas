#!/usr/bin/env bash
# Installs pipeline (Python, via uv) and web (Node) dependencies.
set -euo pipefail

cd "$(dirname "$0")/.."

command -v uv >/dev/null || pip install --user uv
export PATH="$HOME/.local/bin:$PATH"

echo "==> Python pipeline deps"
(cd pipeline && uv sync --extra dev)

echo "==> Web deps"
(cd web && npm ci)

echo "Done. Try:  (cd web && npm run dev)   or   (cd pipeline && uv run --extra dev pytest -q)"
