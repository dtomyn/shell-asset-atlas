# Dev container

Open the repo in VS Code and run **Dev Containers: Reopen in Container**.

- Python 3.12 + [uv](https://docs.astral.sh/uv/) (installed by post-create), Node 22, GitHub CLI
- `post-create.sh` runs `uv sync --extra dev` in `pipeline/` and `npm ci` in `web/`
- Port 5173 is forwarded: `cd web && npm run dev`
- Tests: `cd pipeline && uv run --extra dev pytest -q`

The explainer film pipeline (`film/`) needs extra packages (playwright, TTS, ffmpeg) and is not set up here.
