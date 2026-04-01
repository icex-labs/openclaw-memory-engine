# @icex-labs/openclaw-memory-engine

MemGPT-style hierarchical memory plugin for [OpenClaw](https://openclaw.ai).

Gives your agent persistent, structured memory that survives session restarts — without bloating the context window.

## Quick Start

```bash
# Clone
git clone git@github.com:icex-labs/openclaw-memory-engine.git ~/.openclaw/extensions/memory-engine

# Run setup (does everything: config, templates, maintenance cron, agent instructions)
bash ~/.openclaw/extensions/memory-engine/setup.sh

# Edit core memory with your info
nano ~/.openclaw/workspace/memory/core.json

# Restart gateway
openclaw gateway restart
```

That's it. Your agent now has 4 memory tools and will use them automatically.

## What it does

| Tool | Description |
|------|-------------|
| `core_memory_read` | Read the core memory block (~500 tokens, always small) |
| `core_memory_replace` | Atomically update a field using dot-path (e.g., `user.location`) |
| `archival_insert` | Store a fact/memory with entity + tags (unlimited, append-only) |
| `archival_search` | Keyword search over archival with recency boost |

## Architecture

```
┌───────────────────────────────────────┐
│         Agent Context Window          │
│                                       │
│  core_memory_read() ─→ core.json      │  ← ~500 tokens, loaded on demand
│                                       │
│  archival_search(query) ──────────────│──→ archival.jsonl (unlimited)
│  archival_insert(fact)  ──────────────│──→ archival.jsonl
│  core_memory_replace(key, val) ───────│──→ core.json (3KB limit)
└───────────────────────────────────────┘
```

**Core Memory** (`memory/core.json`): Small structured block — user identity, relationship, preferences, current focus. The agent reads it at session start and updates it atomically when facts change. Hard limit 3KB to prevent bloat.

**Archival Memory** (`memory/archival.jsonl`): Unlimited append-only storage. Every record has `content`, `entity`, and `tags`. The agent stores facts, decisions, events, and conversation summaries here. Search uses keyword matching with recency boost.

## What `setup.sh` does

The setup script automates everything:

1. Creates `memory/core.json` template (if not exists)
2. Creates empty `memory/archival.jsonl` (if not exists)
3. Installs `memory-maintenance.sh` to workspace scripts
4. Creates a LaunchAgent for daily 3am maintenance (macOS)
5. Adds `memory-engine` to `openclaw.json` plugin config
6. Patches `AGENTS.md` with memory tool instructions

After setup, the agent knows:
- Call `core_memory_read` at every session start
- Use `archival_insert` when learning something important
- Use `archival_search` before answering factual questions
- Keep core memory small, move details to archival

## Manual Install (without setup.sh)

### 1. Enable plugin

Add to `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["memory-engine"],
    "entries": {
      "memory-engine": {
        "enabled": true,
        "config": {
          "workspace": "/path/to/workspace"
        }
      }
    }
  }
}
```

### 2. Create core.json

```json
{
  "_meta": { "version": 1, "updated_at": "...", "description": "Core memory block" },
  "user": { "name": "Your Name", "location": "...", "language": "..." },
  "relationship": { "dynamic": "...", "trust": "...", "boundaries": "..." },
  "preferences": {},
  "current_focus": ["project A", "project B"]
}
```

### 3. Add agent instructions

Add to your AGENTS.md or system prompt:

```markdown
## Every Session
1. Call `core_memory_read` to load your identity
2. When you learn something → `archival_insert`
3. When you need details → `archival_search`
4. When facts change → `core_memory_replace`
```

## Config options

| Option | Default | Description |
|--------|---------|-------------|
| `workspace` | Auto-resolved | Path to workspace directory |
| `coreSizeLimit` | `3072` (3KB) | Max bytes for core.json |
| `archivalSearchTopK` | `5` | Default results for archival_search |

## Maintenance

The included `memory-maintenance.sh` script (installed by setup.sh) runs daily and:

- Checks core.json size (warns >4KB, alerts >5KB)
- Merges daily logs older than 7 days into weekly summaries
- Archives weekly summaries older than 60 days
- Monitors topic file sizes
- Writes alerts to `memory/maintenance-alerts.json`

## Data format

### Core memory

```json
{
  "_meta": { "version": 1, "updated_at": "2026-04-01T00:00:00Z" },
  "user": { "name": "...", "location": "..." },
  "current_focus": ["item1", "item2"]
}
```

### Archival records (JSONL)

```jsonl
{"id":"arch-1712000000-abc","ts":"2026-04-01T00:00:00Z","content":"The fact to remember","entity":"person_or_thing","tags":["category","topic"]}
```

## Migrating from file-based memory

If you currently use a large MEMORY.md:

1. Keep a slim MEMORY.md with just topic file pointers (~80 lines max)
2. Move detailed facts to `archival.jsonl` using `archival_insert`
3. Move identity/relationship info to `core.json`
4. Move operational rules to AGENTS.md

## Roadmap

- [ ] Embedding-based semantic search (using OpenClaw's memorySearch)
- [ ] Archival deduplication and fact merging
- [ ] `archival_delete` / `archival_update` tools
- [ ] Export/import for backup and migration
- [ ] ClawHub publishing

## License

MIT
