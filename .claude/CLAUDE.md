# openclaw-memory-engine — Developer Guide

## What This Is
MemGPT-style hierarchical memory plugin for OpenClaw. Gives agents persistent structured memory via 12 tools.

## Architecture

```
index.js          → Plugin entry, registers 12 tools via OpenClaw plugin SDK
lib/paths.js      → Constants + path resolution (workspace, core, archival, embeddings)
lib/core.js       → Core memory CRUD: readCore, writeCore, dotGet, dotSet, autoParse
lib/archival.js   → Archival JSONL CRUD: loadArchival, appendRecord, rewriteArchival (in-memory cache)
lib/embedding.js  → OpenAI embedding API: getEmbedding, cosineSimilarity, indexEmbedding (file cache)
lib/search.js     → hybridSearch: keyword(2×) + semantic(5×) + recency(0-1) + accessDecay(0-0.5)
lib/consolidate.js→ consolidateText: sentence splitting → entity inference → dedup → batch insert
lib/dedup.js      → findDuplicates (O(n²) cosine), applyDedup
lib/backup.js     → exportMemory / importMemory (replace/merge modes)
extras/           → memory-maintenance.sh (daily cron)
setup.sh          → One-command setup for new installs
```

## Key Conventions

- **ESM only** (`"type": "module"` in package.json). All imports use `.js` extension.
- **Plugin SDK**: `import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry"` — only works inside OpenClaw gateway runtime, not standalone Node.
- **Tool registration**: `api.registerTool({ name, description, parameters, execute })` — parameters must be JSON Schema. `execute` receives `(_id, params, ctx)`.
- **Context resolution**: `ctx?.config?.workspace` comes from `openclaw.json → plugins.entries.memory-engine.config.workspace`.
- **All tool responses** must return `{ content: [{ type: "text", text: "..." }] }`.

## Storage Files (all under `<workspace>/memory/`)

| File | Format | Purpose |
|------|--------|---------|
| `core.json` | JSON | Core identity block (~500 tokens, 3KB limit) |
| `archival.jsonl` | JSONL | Fact store (one JSON per line, append-only) |
| `archival.embeddings.json` | JSON | Embedding cache `{ recordId: float[512] }` |
| `export-*.json` | JSON | Backup snapshots |

## Testing

Cannot run `node index.js` standalone (needs OpenClaw plugin SDK in runtime). Test via:

```bash
# Restart gateway to reload plugin
launchctl bootout gui/$(id -u)/ai.openclaw.gateway
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.gateway.plist

# Test a specific tool
openclaw agent --agent main -m "archival_stats" --timeout 30

# Check for load errors
tail -20 ~/.openclaw/logs/gateway.err.log
```

## Rules

- **Never hardcode user-specific data in lib/**.  All user data goes in `core.json` or `archival.jsonl`.
- **core.json 3KB limit is enforced in code**. Don't bypass it.
- **Embedding API key**: read from `process.env.OPENAI_API_KEY`. Search gracefully degrades to keyword-only if missing.
- **In-memory cache**: `archival.js` and `embedding.js` both cache per workspace path. Cache invalidates on `rewriteArchival()`.
- **Publish**: `npm publish --access public` after bumping version in package.json. Also `git push origin main`.

## npm / GitHub

- **Package**: `@icex-labs/openclaw-memory-engine`
- **Repo**: `github.com/icex-labs/openclaw-memory-engine`
- **npm account**: `icex-dev` (token in `~/.npmrc`)
