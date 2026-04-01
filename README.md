# @icex-labs/openclaw-memory-engine

> MemGPT-style hierarchical memory for [OpenClaw](https://openclaw.ai) agents — persistent identity, unlimited fact storage, hybrid semantic search, and automatic maintenance.

[![npm version](https://img.shields.io/npm/v/@icex-labs/openclaw-memory-engine)](https://www.npmjs.com/package/@icex-labs/openclaw-memory-engine)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## Why

OpenClaw agents wake up fresh every session. Without a memory system, they forget who you are, what you talked about, and what matters to you. Stuffing everything into a giant `MEMORY.md` file bloats the context window and degrades response quality.

**Memory Engine** solves this with a two-tier architecture inspired by [MemGPT/Letta](https://github.com/cpacker/MemGPT):

- **Core Memory** (~500 tokens) — always loaded, contains identity and current focus
- **Archival Memory** (unlimited) — stores facts, decisions, events; retrieved on demand via hybrid search

The agent decides what to remember, what to recall, and what to forget — using 12 purpose-built tools.

---

## Quick Start

```bash
# Install
git clone git@github.com:icex-labs/openclaw-memory-engine.git ~/.openclaw/extensions/memory-engine

# One-command setup (config, templates, maintenance cron, agent instructions)
bash ~/.openclaw/extensions/memory-engine/setup.sh

# Edit core memory with your info
nano ~/.openclaw/workspace/memory/core.json

# Restart
openclaw gateway restart
```

Or install from npm:

```bash
npm install -g @icex-labs/openclaw-memory-engine
```

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Agent Context Window                │
│                                                  │
│   core_memory_read() ──→ core.json (~500 tok)    │
│                                                  │
│   archival_search("query") ─┐                    │
│   archival_insert(fact)     │                    │
│   memory_consolidate(text)  │   archival.jsonl   │
│   archival_update(id, ...)  ├──→ (unlimited)     │
│   archival_delete(id)       │   + embeddings     │
│   archival_deduplicate()    ┘                    │
│                                                  │
│   memory_export() ──→ backup.json                │
│   memory_import(file) ←── backup.json            │
└─────────────────────────────────────────────────┘
```

### Core Memory

A small JSON file (`memory/core.json`) with structured fields:

```json
{
  "_meta": { "version": 1, "updated_at": "..." },
  "user": { "name": "...", "location": "...", "language": "..." },
  "relationship": { "dynamic": "...", "trust": "...", "boundaries": "..." },
  "preferences": { "...": "..." },
  "current_focus": ["project A", "project B"]
}
```

- **Always small** — hard limit of 3KB (configurable)
- **Agent-managed** — the agent reads it at session start and updates it when facts change
- **Auto-parse safety** — if the LLM passes `"[\"a\",\"b\"]"` as a string, it auto-parses to `["a","b"]`

### Archival Memory

An append-only JSONL file (`memory/archival.jsonl`) with tagged records:

```jsonl
{"id":"arch-17120-abc","ts":"2026-04-01T00:00:00Z","content":"George's doctor is Dr. Mohamed, Parsons Medical Centre, Edmonton","entity":"George","tags":["health","doctor"],"last_accessed":"2026-04-01T01:00:00Z","access_count":3}
```

- **Unlimited storage** — grows as the agent learns
- **Tagged** — every record has `entity` and `tags` for structured retrieval
- **Access-tracked** — `last_accessed` and `access_count` enable decay-based ranking

### Hybrid Search

`archival_search` combines three signals:

| Signal | Weight | Description |
|--------|--------|-------------|
| **Keyword match** | 2× per term | Term frequency in content + entity + tags |
| **Semantic similarity** | 5× | Cosine similarity via OpenAI `text-embedding-3-small` |
| **Recency** | 0-1 | Newer records rank higher (decays over 1 year) |
| **Access frequency** | 0-0.5 | Recently accessed records get a boost |

Embeddings are computed in the background on `archival_insert` and cached in `archival.embeddings.json`. Search falls back to keyword-only if no API key is available.

---

## Tools Reference (12)

### Core Memory

| Tool | Description |
|------|-------------|
| `core_memory_read` | Read the entire core memory block. Call at every session start. |
| `core_memory_replace` | Update a field using dot-path notation (e.g., `user.location`). Values are auto-parsed from JSON strings. Enforces 3KB size limit. |
| `core_memory_append` | Append an item to an array field (e.g., `current_focus`). Creates the array if it doesn't exist. |

### Archival Memory

| Tool | Description |
|------|-------------|
| `archival_insert` | Store a fact with entity + tags. Embedding computed in background. |
| `archival_search` | Hybrid search: keywords + semantic + recency + access decay. Returns top-K results. |
| `archival_update` | Update an existing record by ID (correct wrong facts). Re-indexes embedding. |
| `archival_delete` | Delete a record by ID (remove outdated info). Cleans up embedding. |
| `archival_stats` | Overview: total records, embedding coverage, entity/tag distribution, storage size. |

### Maintenance

| Tool | Description |
|------|-------------|
| `archival_deduplicate` | Scan for near-duplicate records using embedding cosine similarity (threshold: 0.92). Preview mode by default; pass `apply=true` to remove duplicates. |
| `memory_consolidate` | Extract structured facts from a text block (conversation summary, daily log). Splits by sentence boundaries (supports Chinese and English), infers entity from content, deduplicates against existing records. |

### Backup & Migration

| Tool | Description |
|------|-------------|
| `memory_export` | Export core + archival + embeddings to a single JSON file. Use for backups or migrating between machines. |
| `memory_import` | Import from an export file. `merge` mode adds missing records; `replace` mode overwrites everything. |

---

## Configuration

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

| Option | Default | Description |
|--------|---------|-------------|
| `workspace` | Auto-resolved from env | Path to workspace directory |
| `coreSizeLimit` | `3072` (3KB) | Maximum bytes for core.json |
| `archivalSearchTopK` | `5` | Default number of search results |

### Embedding Requirements

Hybrid semantic search requires an OpenAI API key in the environment:

```bash
export OPENAI_API_KEY=sk-...
```

Uses `text-embedding-3-small` with 512 dimensions (~$0.02 per 1M tokens). If no key is available, search falls back to keyword-only mode — no errors, just reduced quality.

---

## Agent Setup

The plugin registers tools, but the agent needs instructions on **when** to use them. Add to your `AGENTS.md` or system prompt:

```markdown
## Every Session
1. Call `core_memory_read` — load your identity and context
2. Read today's daily log for recent events

## Memory Rules
- George tells you something important → `archival_insert` immediately
- Need to recall details → `archival_search` before answering
- Facts change → `core_memory_replace`
- End of conversation → `memory_consolidate` with a summary
- "Mental notes" don't survive restarts. If it matters, store it.
```

`setup.sh` automatically patches `AGENTS.md` with these instructions.

---

## Automated Maintenance

The included `extras/memory-maintenance.sh` script (installed by `setup.sh`) runs daily via LaunchAgent and:

- Checks core.json size (warns >4KB, alerts >5KB)
- Merges daily logs older than 7 days into weekly summaries
- Archives weekly summaries older than 60 days
- Monitors topic file sizes (warns >8KB)
- Writes alerts to `memory/maintenance-alerts.json`

Add a heartbeat check so the agent self-monitors:

```markdown
### Heartbeat: Memory Health
Check `memory/maintenance-alerts.json` — if non-empty:
- `critical` → notify owner immediately
- `warn` → try to fix (trim files, move content to archival)
```

---

## Migrating from File-Based Memory

If you currently use a large `MEMORY.md`:

1. **Slim down MEMORY.md** to ~80 lines (identity + current focus only)
2. **Run `memory_consolidate`** on the old MEMORY.md content to extract facts into archival
3. **Move identity info** to `core.json`
4. **Move operational rules** to `AGENTS.md` (they don't belong in memory)
5. **Move reference data** to `memory/topics/*.md` files (indexed by OpenClaw's memorySearch)

---

## Backup & Restore

```bash
# Export everything
openclaw agent -m "memory_export"
# → creates memory/export-2026-04-01.json

# On new machine, after installing the plugin:
openclaw agent -m "memory_import input_path='memory/export-2026-04-01.json' mode='replace'"
```

Export format is versioned (`openclaw-memory-engine` format tag) for forward compatibility.

---

## Storage Details

| File | Purpose | Growth |
|------|---------|--------|
| `memory/core.json` | Identity block | Fixed (~1-3KB) |
| `memory/archival.jsonl` | Fact storage | Grows with usage |
| `memory/archival.embeddings.json` | Embedding cache | ~2KB per record |
| `memory/export-*.json` | Backups | Snapshot size |

For stores exceeding 50K records, consider enabling OpenClaw's built-in `memory-lancedb` plugin for vector-native storage.

---

## Roadmap

- [x] Core memory (read/replace/append)
- [x] Archival storage (insert/search/update/delete)
- [x] Hybrid search (keyword + embedding + recency + access decay)
- [x] Auto-extract facts from text (memory_consolidate)
- [x] Deduplication via embedding similarity
- [x] Full backup/restore (export/import)
- [x] Access tracking and decay scoring
- [ ] LanceDB backend for 50K+ record stores
- [ ] Cross-agent memory sharing
- [ ] Scheduled consolidation via OpenClaw cron
- [ ] ClawHub publishing

---

## License

MIT

---

Built with [OpenClaw](https://openclaw.ai) plugin SDK. Inspired by [MemGPT](https://github.com/cpacker/MemGPT).
