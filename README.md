# @icex-labs/openclaw-memory-engine

> Persistent, structured memory for AI agents — inspired by MemGPT.

[![npm](https://img.shields.io/npm/v/@icex-labs/openclaw-memory-engine)](https://www.npmjs.com/package/@icex-labs/openclaw-memory-engine)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An [OpenClaw](https://openclaw.ai) plugin that gives your agent 19 tools to manage its own memory — what to remember, what to recall, what to forget, and what patterns to notice.

---

## The Problem

OpenClaw agents wake up fresh every session. Without persistent memory, they forget who you are, what you discussed, and what matters to you. Stuffing everything into a system prompt bloats the context window and degrades quality.

## The Solution

Two-tier memory inspired by [MemGPT/Letta](https://github.com/cpacker/MemGPT):

- **Core Memory** (~500 tokens) — user identity, relationship, preferences. Always loaded.
- **Archival Memory** (unlimited) — facts, decisions, events. Retrieved on demand via hybrid semantic search.

Plus: knowledge graph, episodic memory, behavioral reflection, importance scoring with forgetting curves, deduplication, SQLite backend, and a browsable HTML dashboard.

The agent manages all of this autonomously.

---

## Install

```bash
openclaw plugins install @icex-labs/openclaw-memory-engine
bash ~/.openclaw/extensions/memory-engine/setup.sh
openclaw gateway restart
```

`setup.sh` handles everything:
- Interactive core memory setup (prompts for your name, location, role, etc.)
- Configures `openclaw.json`
- Installs daily maintenance scheduler (macOS LaunchAgent / Linux systemd / Windows schtasks)
- Patches agent instructions (AGENTS.md)
- Registers 4 automated cron jobs (reflection, consolidation, dedup, dashboard)
- `--non-interactive` flag available for scripted installs

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                   Agent Context Window                    │
│                                                           │
│   core_memory_read() ──→ core.json (~500 tokens)          │
│                                                           │
│   archival_search("query") ──→ archival.jsonl (unlimited)  │
│     keyword (2×) + embedding (5×) + recency + decay        │
│                                                           │
│   graph_query("entity") ──→ graph.jsonl (relations)        │
│     "who is my doctor?" → traverse knowledge graph         │
│                                                           │
│   episode_recall("topic") ──→ episodes.jsonl               │
│     "what did we discuss last time?" → conversation recall  │
│                                                           │
│   memory_reflect() ──→ behavioral pattern analysis         │
│   memory_dashboard() ──→ browsable HTML report             │
│   memory_export() ──→ full backup for migration            │
└──────────────────────────────────────────────────────────┘
```

### Multi-Agent Support

Each agent automatically gets its own memory based on its configured workspace. Uses OpenClaw's session key to resolve the correct workspace at tool registration time — zero configuration needed.

Privacy flag: `"sharing": false` in plugin config for multi-user setups.

---

## Tools (19)

### Core Memory — Identity

| Tool | Description |
|------|-------------|
| `core_memory_read` | Load identity block. Call every session start. |
| `core_memory_replace` | Update a field by dot-path (e.g., `user.location`). Auto-parses JSON strings. 3KB hard limit. |
| `core_memory_append` | Append to an array field (e.g., `current_focus`). |

### Archival Memory — Facts

| Tool | Description |
|------|-------------|
| `archival_insert` | Store a fact with entity, tags, and importance (1-10). Auto-extracts knowledge graph triples. |
| `archival_search` | Hybrid search: keyword + semantic + recency + access decay + importance. |
| `archival_update` | Correct an existing record by ID. |
| `archival_delete` | Remove an outdated record. |
| `archival_stats` | Record count, entity/tag distribution, embedding coverage, storage size. |

### Knowledge Graph — Relations

| Tool | Description |
|------|-------------|
| `graph_query` | Traverse from entity with depth control. |
| `graph_add` | Manually add a relation triple. |

### Episodic Memory — Conversations

| Tool | Description |
|------|-------------|
| `episode_save` | Save conversation summary, decisions, mood, topics. |
| `episode_recall` | Search past conversations by topic or get recent N. |

### Intelligence

| Tool | Description |
|------|-------------|
| `memory_reflect` | Analyze behavioral patterns: topic trends, time distribution, mood shifts, forgetting candidates. |
| `archival_deduplicate` | Find and remove near-duplicates via embedding cosine similarity. |
| `memory_consolidate` | Extract structured facts from text. Sentence-level splitting (Chinese + English), entity inference, dedup. |

### Backup & Admin

| Tool | Description |
|------|-------------|
| `memory_export` | Full snapshot: core + archival + embeddings → JSON file. |
| `memory_import` | Restore from snapshot. Merge or replace mode. |
| `memory_migrate` | Migrate from JSONL to SQLite with FTS5 full-text search. |
| `memory_dashboard` | Generate self-contained HTML dashboard. |

---

## Search Scoring

`archival_search` combines five signals:

| Signal | Weight | Description |
|--------|--------|-------------|
| Keyword | 2× per term | Term presence in content + entity + tags |
| Semantic | 5× | Cosine similarity via OpenAI `text-embedding-3-small` (512d) |
| Recency | 0–1 | Linear decay over 1 year |
| Access | 0–0.5 | Boost for recently accessed records |
| Importance | 0.5× | Weighted by forgetting curve: `importance × e^(-0.01 × days)` |

Falls back to keyword-only if no OpenAI key is configured. Cost with embeddings: ~$0.001/session.

---

## Configuration

```json
{
  "plugins": {
    "allow": ["memory-engine"],
    "entries": {
      "memory-engine": {
        "enabled": true,
        "config": {
          "coreSizeLimit": 3072,
          "sharing": false
        }
      }
    }
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `workspace` | Auto-resolved | Override workspace directory |
| `coreSizeLimit` | `3072` (3KB) | Max core.json size |
| `sharing` | `true` | Cross-agent memory sharing. Set `false` for multi-user privacy. |

Semantic search requires `OPENAI_API_KEY` in environment (optional).

---

## Automated Maintenance

| Schedule | Job | What it does |
|----------|-----|-------------|
| Daily 9:00am | Reflection | Analyze memory patterns, store observations |
| Every 6h | Consolidation | Extract missed facts from daily logs |
| Weekly Sunday | Deduplication | Clean near-duplicate records |
| Daily 9:30am | Dashboard | Refresh browsable HTML report |
| Daily 3:00am | File cleanup | Merge old logs into weekly summaries, archive old summaries |

---

## Project Structure

```
memory-engine/
├── index.js                # Plugin entry — 19 tools (factory pattern)
├── lib/
│   ├── paths.js            # Constants, workspace resolution
│   ├── core.js             # Core memory CRUD + auto-parse
│   ├── archival.js         # JSONL storage + in-memory cache
│   ├── embedding.js        # OpenAI embedding API + cache
│   ├── search.js           # Hybrid 5-signal search
│   ├── graph.js            # Knowledge graph: triples + traversal
│   ├── episodes.js         # Episodic memory: save + recall
│   ├── reflection.js       # Statistical pattern analysis
│   ├── consolidate.js      # Text → facts extraction
│   ├── dedup.js            # Embedding similarity dedup
│   ├── backup.js           # Export / import
│   ├── store-sqlite.js     # SQLite backend (FTS5)
│   └── dashboard.js        # HTML dashboard generator
├── extras/
│   ├── memory-maintenance.sh
│   └── auto-consolidation-crons.json
├── setup.sh                # One-command install
├── .claude/CLAUDE.md       # Dev guide
├── ROADMAP.md
├── openclaw.plugin.json
└── package.json
```

## Platforms

| Platform | Scheduler | Status |
|----------|----------|--------|
| macOS | LaunchAgent | Full support |
| Linux | systemd timer | Full support |
| Windows | schtasks | Guided setup |

---

## License

MIT — Built for [OpenClaw](https://openclaw.ai). Inspired by [MemGPT/Letta](https://github.com/cpacker/MemGPT).
