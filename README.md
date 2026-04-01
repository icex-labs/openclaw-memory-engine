# @icex-labs/openclaw-memory-engine

> Give your AI agent a brain that survives restarts.

[![npm](https://img.shields.io/npm/v/@icex-labs/openclaw-memory-engine)](https://www.npmjs.com/package/@icex-labs/openclaw-memory-engine)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A [MemGPT](https://github.com/cpacker/MemGPT)-inspired memory plugin for [OpenClaw](https://openclaw.ai). Your agent gets 12 tools to manage its own memory — what to remember, what to recall, what to forget.

**The problem:** OpenClaw agents wake up fresh every session. Without persistent memory, they forget who you are.

**The fix:** Two-tier memory architecture:
- **Core Memory** (~500 tokens) — identity, relationship, preferences. Always loaded.
- **Archival Memory** (unlimited) — facts, decisions, events. Retrieved on demand via hybrid semantic search.

The agent manages both tiers autonomously using purpose-built tools.

---

## Install

```bash
git clone git@github.com:icex-labs/openclaw-memory-engine.git ~/.openclaw/extensions/memory-engine
bash ~/.openclaw/extensions/memory-engine/setup.sh
nano ~/.openclaw/workspace/memory/core.json   # fill in your info
openclaw gateway restart
```

Or from npm:
```bash
npm install -g @icex-labs/openclaw-memory-engine
```

`setup.sh` handles everything: enables the plugin in `openclaw.json`, creates template files, installs the daily maintenance cron, and patches your agent's instructions.

---

## How It Works

```
┌──────────────────────────────────────────────────────┐
│                 Agent Context Window                  │
│                                                       │
│   Session start → core_memory_read()                  │
│                   └─→ core.json (~500 tokens)         │
│                                                       │
│   "Where does Alice's doctor work?"                  │
│   → archival_search("doctor")                         │
│     └─→ keyword match + embedding similarity          │
│         + recency boost + access frequency             │
│         → "Dr. Smith, City Medical..."    │
│                                                       │
│   Alice says something new                           │
│   → archival_insert(fact, entity, tags)               │
│     └─→ archival.jsonl + background embedding         │
│                                                       │
│   End of conversation                                 │
│   → memory_consolidate(summary)                       │
│     └─→ split sentences → infer entities → dedup      │
│         → batch insert                                │
└──────────────────────────────────────────────────────┘
```

---

## Tools (12)

### Core Memory — Your Identity

| Tool | What it does |
|------|-------------|
| `core_memory_read` | Load the identity block. Call every session start. |
| `core_memory_replace` | Update a field by dot-path (`user.location`, `current_focus`). Auto-parses JSON strings. 3KB hard limit. |
| `core_memory_append` | Append to an array field (`current_focus`). Creates array if needed. |

Core memory lives in `memory/core.json`:

```json
{
  "user": { "name": "Alice", "location": "New York", "language": "bilingual" },
  "relationship": { "dynamic": "intimate companion", "trust": "deep" },
  "preferences": { "config_rule": "don't touch openclaw.json" },
  "current_focus": ["quant trading", "immigration case"]
}
```

### Archival Memory — Your Long-Term Storage

| Tool | What it does |
|------|-------------|
| `archival_insert` | Store a fact. Tags it with `entity` + `tags`. Computes embedding in background. |
| `archival_search` | Hybrid search: keyword (2×) + semantic similarity (5×) + recency (0-1) + access decay (0-0.5). |
| `archival_update` | Correct an existing record by ID. Re-indexes embedding. |
| `archival_delete` | Remove an outdated record. Cleans up embedding cache. |
| `archival_stats` | Dashboard: record count, embedding coverage, entity/tag distribution, storage size. |

Each record in `memory/archival.jsonl`:

```json
{"id":"arch-17120-abc","ts":"2026-04-01","content":"Alice's doctor is Dr. Smith","entity":"Alice","tags":["health"],"access_count":3}
```

### Maintenance — Keep It Clean

| Tool | What it does |
|------|-------------|
| `archival_deduplicate` | Find near-duplicates via embedding cosine similarity (≥0.92). Preview or auto-remove. |
| `memory_consolidate` | Extract facts from text blocks. Splits by sentence (中文/English), infers entity, deduplicates, batch inserts. |

### Backup — Never Lose Your Memory

| Tool | What it does |
|------|-------------|
| `memory_export` | Snapshot core + archival + embeddings → single JSON file. |
| `memory_import` | Restore from snapshot. `merge` (add missing) or `replace` (overwrite all). |

---

## Search Quality

`archival_search` uses four signals:

| Signal | Weight | How |
|--------|--------|-----|
| Keyword | 2× per term | Term presence in content + entity + tags |
| Semantic | 5× | Cosine similarity via OpenAI `text-embedding-3-small` (512d) |
| Recency | 0–1 | Linear decay over 1 year |
| Access | 0–0.5 | Boost for recently accessed records |

Embeddings are computed on insert and cached in `archival.embeddings.json`. If no OpenAI key is available, search falls back to keyword-only — no errors, just lower quality.

**Cost:** ~$0.02 per 1M tokens with `text-embedding-3-small`. A typical session with 10 inserts + 5 searches costs < $0.001.

---

## Configuration

```json
// openclaw.json
{
  "plugins": {
    "allow": ["memory-engine"],
    "entries": {
      "memory-engine": {
        "enabled": true,
        "config": {
          "workspace": "/path/to/workspace",
          "coreSizeLimit": 3072
        }
      }
    }
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `workspace` | Auto-resolved | Workspace directory path |
| `coreSizeLimit` | `3072` (3KB) | Max bytes for core.json |

**Requires:** `OPENAI_API_KEY` in environment for semantic search. Without it, keyword search still works.

---

## Agent Instructions

Add to your `AGENTS.md` or system prompt (done automatically by `setup.sh`):

```markdown
## Every Session
1. Call `core_memory_read` — load your identity
2. When you learn something important → `archival_insert`
3. When you need details → `archival_search` before guessing
4. When facts change → `core_memory_replace`
5. End of conversation → `memory_consolidate` with key points
```

---

## Daily Maintenance

`extras/memory-maintenance.sh` runs daily at 3am (installed as a LaunchAgent by `setup.sh`):

- Checks core.json size (warns >4KB, critical >5KB)
- Merges 7-day-old daily logs into weekly summaries
- Archives 60-day-old weekly summaries
- Alerts written to `memory/maintenance-alerts.json`

---

## Backup & Migration

```bash
# Export
openclaw agent -m "memory_export"
# → memory/export-2026-04-01.json

# Import on new machine
openclaw agent -m "memory_import input_path='path/to/export.json' mode='replace'"
```

---

## Project Structure

```
memory-engine/
├── index.js              # Plugin entry — tool registration only (250 lines)
├── lib/
│   ├── paths.js          # Constants + path resolution
│   ├── core.js           # Core memory CRUD + dot-path + auto-parse
│   ├── archival.js       # Archival JSONL CRUD + in-memory cache
│   ├── embedding.js      # OpenAI embedding API + file cache
│   ├── search.js         # Hybrid four-signal search
│   ├── consolidate.js    # Text → structured facts extraction
│   ├── dedup.js          # Embedding similarity dedup
│   └── backup.js         # Export/import
├── extras/
│   └── memory-maintenance.sh
├── setup.sh              # One-command install
├── .claude/CLAUDE.md     # Dev guide for Claude Code
├── package.json
├── openclaw.plugin.json
└── README.md
```

---

## Roadmap

- [x] Core memory with size guard and auto-parse
- [x] Archival CRUD with in-memory index
- [x] Hybrid search (keyword + embedding + recency + access decay)
- [x] Auto-extract facts from text
- [x] Embedding-based deduplication
- [x] Full backup/restore
- [x] Modular codebase (8 focused modules)
- [ ] LanceDB / SQLite backend for 50K+ records
- [ ] Cross-agent memory sharing
- [ ] Scheduled auto-consolidation via OpenClaw cron
- [ ] Memory importance scoring (agent rates memories 1-10)
- [ ] Forgetting curve — auto-archive unaccessed memories after N days
- [ ] ClawHub publishing
- [ ] Web dashboard for memory browsing

---

## License

MIT

---

Built for [OpenClaw](https://openclaw.ai). Inspired by [MemGPT/Letta](https://github.com/cpacker/MemGPT).
