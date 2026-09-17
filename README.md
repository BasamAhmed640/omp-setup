# omp-setup

Snapshot of my [omp (oh-my-pi)](https://omp.sh) agent setup, taken from
`%USERPROFILE%\.omp` on **2026-09-17**.

The omp binary itself is *not* included — install it with `bun install -g @oh-my-pi/omp`
(or `omp update`), then restore this snapshot.

## What's in here

| Path | What it is |
| --- | --- |
| `agent/config.yml` | Main omp config — model roles, theme (`dark-tokyo-night`), UI/display settings |
| `agent/config.yml.bak`, `agent/config.yml.pre-revert-backup` | Older config revisions kept around |
| `agent/models.yml` | Custom provider definitions — DeepSeek (`deepseek-flash`, `deepseek-v4-pro`) as an OpenAI-compatible endpoint. API key is read from the `DEEPSEEK_API_KEY` env var, so no secret is stored here |
| `agent/lsp.json` (+ `.bak`) | **The "tsp" / language servers** — rust-analyzer, clangd, typescript-language-server, tsc, pyright, ruff, biome |
| `agent/sessions/` | Full conversation history + per-session workspace files (`local/`), grouped by project path |
| `agent/blobs/` | Images pasted into sessions |
| `agent/history.db` | Prompt/session-title history (consistent snapshot, WAL checkpointed) |
| `agent/terminal-sessions/` | Saved terminal session metadata |
| `agent/agents/`, `agent/extensions/` | Empty right now; kept so custom agents/extensions have a home |
| `agent/last-changelog-version` | Last omp version whose changelog was shown |

## What's deliberately NOT in here

| Path | Why |
| --- | --- |
| `agent/agent.db` | Contains `auth_credentials` — provider logins/tokens. Re-login on the new machine instead |
| `agent/models.db` | Auto-fetched model catalog cache; `omp models refresh` rebuilds it |
| `.omp/cache`, `.omp/logs` | Generated caches and logs |
| `.omp/natives`, `.omp/run`, `.omp/puppeteer`, `.omp/gpu_cache.json` | Downloaded binaries / daemons / machine-specific caches (very large, not portable) |
| Any `*-shm` / `*-wal` SQLite sidecars | Merged into the `.db` snapshot instead |

No API keys or tokens are stored in this repo. `models.yml` references the
`DEEPSEEK_API_KEY` **environment variable name**, not the key itself.

## Restore

Back up your current setup first, then:

**PowerShell**

```powershell
.\restore.ps1
```

**Git Bash / WSL**

```bash
./restore.sh
```

Both scripts copy `agent/` into `~/.omp/agent/`. On Windows you'll likely need to
re-point the executable paths in `agent/lsp.json` (they reference
`C:\Users\basam\...`, e.g. rust-analyzer, clangd, pyright, ruff).

After restoring:

1. Set `DEEPSEEK_API_KEY` in your user environment (the provider entry in
   `models.yml` resolves it from there).
2. Log in to any other providers you use (`omp` → `/login`, or provider env vars).
3. Optionally `omp models refresh` to rebuild the model catalog cache.

## Re-snapshotting later

`./snapshot.sh` re-copies the current `~/.omp` state over this repo (same include/
exclude rules) and creates a commit. Add `--push` to push it.

## Private repo note

This snapshot was pushed as a **private** repo because `sessions/` contains full
conversation history. Keep it private, or scrub `agent/sessions/` before making
it public.
