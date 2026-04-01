# @icex-labs/openclaw-memory-engine

> Persistent, structured memory for AI agents — inspired by MemGPT.

[![npm](https://img.shields.io/npm/v/@icex-labs/openclaw-memory-engine)](https://www.npmjs.com/package/@icex-labs/openclaw-memory-engine)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An [OpenClaw](https://openclaw.ai) plugin that gives your agent 19 tools to manage its own memory — what to remember, what to recall, what to forget, and what patterns to notice.

---

## The Problem

OpenClaw agents wake up fresh every session. Without persistent memory, they forget who you are, what you discussed, and what matters to you. Stuffing everything into a system prompt bloats the context window and degrades quality.

## The Solution

Five-layer memory architecture inspired by [MemGPT/Letta](https://github.com/cpacker/MemGPT):

1. **Core Memory** (~500 tokens) — identity, relationship, preferences. Always loaded.
2. **Archival Memory** (unlimited) — facts with importance scoring. Hybrid semantic search.
3. **Knowledge Graph** — entity relations. "Who is my doctor?" → graph traversal.
4. **Episodic Memory** — conversation summaries. "What did we discuss last time?"
5. **Reflective Memory** — behavioral pattern analysis. "What topics dominate this week?"

The agent manages all five layers autonomously using 19 purpose-built tools.

---

## Install

```bash
openclaw plugins install @icex-labs/openclaw-memory-engine
bash ~/.openclaw/extensions/memory-engine/setup.sh
openclaw gateway restart
```

### What setup.sh does

1. **Interactive core memory setup** — prompts for name, location, role, relationship dynamic
2. **Legacy data migration** — detects existing MEMORY.md / daily logs and imports them into archival (with dedup)
3. **Platform scheduler** — installs daily maintenance (macOS LaunchAgent / Linux systemd / Windows schtasks)
4. **Config patching** — enables plugin in `openclaw.json`
5. **Agent instructions** — patches AGENTS.md with memory tool guide
6. **Cron registration** — 4 automated jobs (reflection, consolidation, dedup, dashboard)
7. **Embedding backfill** — on next gateway restart, missing embeddings are auto-computed in background

`--non-interactive` flag available for scripted installs.

---

## Architecture

### Memory Layers

```
┌──────────────────────────────────────────────────────────────────┐
│                       Agent Context Window                       │
│                                                                   │
│  ┌─ Layer 1: Core Memory ─────────────────────────────────────┐  │
│  │  core_memory_read() → core.json (~500 tokens)              │  │
│  │  Identity, relationship, preferences, current_focus         │  │
│  │  Agent reads on session start, updates atomically           │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─ Layer 2: Archival Memory ─────────────────────────────────┐  │
│  │  archival_insert(fact, entity, tags, importance)            │  │
│  │  archival_search(query) → hybrid 5-signal ranking          │  │
│  │  Unlimited JSONL. Each record: content + entity + tags +   │  │
│  │  importance (1-10) + access tracking + embedding vector     │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─ Layer 3: Knowledge Graph ─────────────────────────────────┐  │
│  │  graph_query(entity, relation?, depth?)                     │  │
│  │  Triple store: (subject, relation, object)                  │  │
│  │  Auto-extracted from archival_insert content                │  │
│  │  "who is my doctor?" → User→has_doctor→Dr. Smith            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─ Layer 4: Episodic Memory ─────────────────────────────────┐  │
│  │  episode_save(summary, decisions, mood, topics)             │  │
│  │  episode_recall(query) → hybrid search over conversations   │  │
│  │  "what did we discuss about the car?" → full context        │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─ Layer 5: Reflective Memory ───────────────────────────────┐  │
│  │  memory_reflect(window_days) → pattern analysis report      │  │
│  │  Topic trends, time distribution, mood shifts,              │  │
│  │  neglected entities, forgetting candidates                  │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
User says something important
    │
    ▼
archival_insert(content, entity, tags, importance)
    │
    ├──→ archival.jsonl (append fact)
    ├──→ graph.jsonl (auto-extract relations)
    └──→ embeddings cache (background, async)

User asks a question
    │
    ▼
archival_search(query)
    │
    ├──→ Keyword matching (2× weight per term)
    ├──→ Embedding cosine similarity (5× weight)
    ├──→ Recency boost (0-1, decays over 1 year)
    ├──→ Access frequency boost (0-0.5)
    └──→ Importance × forgetting curve (0.5× weight)

End of conversation
    │
    ▼
episode_save(summary, decisions, mood)
    │
    └──→ episodes.jsonl + embedding

Gateway restart
    │
    ▼
Auto-detect missing embeddings across ALL workspaces
    │
    └──→ Batch backfill (100/batch, 200ms rate limit, crash-safe)
```

### Multi-Agent Isolation

```
openclaw.json
  agents:
    ├── main  → workspace/          ← Agent A's memory (2700+ records)
    ├── wife  → workspace-wife/     ← Agent B's memory (300+ records)
    └── discord → workspace/        ← Shares Agent A's memory

Plugin uses ToolFactory pattern:
  ctx.sessionKey = "agent:wife:telegram:..."
                         ↓
  extractAgentId() → "wife"
                         ↓
  openclaw.json lookup → workspace-wife/
                         ↓
  All 19 tools bound to correct workspace via closure
```

Each agent's tools are bound to its own workspace at registration time. No cross-contamination. Privacy flag `"sharing": false` available for multi-user setups.

---

## Tools (19)

### Core Memory — Identity (3)

| Tool | Description |
|------|-------------|
| `core_memory_read` | Load identity block. Call every session start. |
| `core_memory_replace` | Update a field by dot-path (e.g., `user.location`). Auto-parses JSON strings. 3KB hard limit. |
| `core_memory_append` | Append to an array field (e.g., `current_focus`). |

### Archival Memory — Facts (5)

| Tool | Description |
|------|-------------|
| `archival_insert` | Store a fact with entity, tags, and importance (1-10). Auto-extracts knowledge graph triples. Embedding computed in background. |
| `archival_search` | Hybrid 5-signal search: keyword + semantic + recency + access + importance. |
| `archival_update` | Correct an existing record by ID. Re-indexes embedding. |
| `archival_delete` | Remove an outdated record. Cleans embedding cache. |
| `archival_stats` | Record count, entity/tag distribution, embedding coverage, storage size. |

### Knowledge Graph — Relations (2)

| Tool | Description |
|------|-------------|
| `graph_query` | Traverse from entity with depth control. Answers relational questions. |
| `graph_add` | Manually add a relation triple `(subject, relation, object)`. |

Auto-extraction patterns on `archival_insert`: has_doctor, lives_in, has_condition, treated_by, owns, works_at, attends, price, has_lawyer, spouse, has_child.

### Episodic Memory — Conversations (2)

| Tool | Description |
|------|-------------|
| `episode_save` | Save conversation summary with decisions, mood, topics, participants. |
| `episode_recall` | Search past conversations by topic/keyword, or get recent N. Hybrid search with embedding. |

### Intelligence (3)

| Tool | Description |
|------|-------------|
| `memory_reflect` | Statistical analysis: topic frequency, time-of-day distribution, mood trend, importance distribution, neglected entities, forgetting candidates. Configurable window (7/14/30 days). |
| `archival_deduplicate` | Find near-duplicates via embedding cosine similarity (≥0.92 threshold). Preview or auto-remove. |
| `memory_consolidate` | Extract structured facts from text blocks. Sentence-level splitting (Chinese + English), generic entity inference, keyword dedup against existing records. |

### Backup & Admin (4)

| Tool | Description |
|------|-------------|
| `memory_export` | Full snapshot: core + archival + embeddings → single JSON file. Versioned format. |
| `memory_import` | Restore from snapshot. `merge` (add missing) or `replace` (overwrite) mode. |
| `memory_migrate` | Migrate from JSONL to SQLite with FTS5 full-text search. Preserves JSONL as backup. |
| `memory_dashboard` | Generate self-contained HTML dashboard: facts (searchable), graph, episodes, core memory, reflection report. Dark theme. |

---

## Search Scoring

`archival_search` combines five signals:

| Signal | Weight | Description |
|--------|--------|-------------|
| Keyword | 2× per term | Term presence in content + entity + tags |
| Semantic | 5× | Cosine similarity via OpenAI `text-embedding-3-small` (512 dimensions) |
| Recency | 0–1 | Linear decay over 1 year from creation date |
| Access | 0–0.5 | Boost for recently accessed records (decays over 180 days) |
| Importance | 0.5× | Forgetting curve: `importance × e^(-0.01 × days_since_access)` |

Falls back to keyword-only if no OpenAI key is configured — no errors, just reduced quality. Cost with embeddings: ~$0.001/session for search, ~$0.02/1M tokens for batch indexing.

---

## Self-Healing

The plugin automatically detects and fixes issues on gateway restart:

| Issue | Auto-fix |
|-------|----------|
| Missing embeddings after migration | Batch backfill across all workspaces (100/batch, rate limited) |
| Core memory value serialized as JSON string | Auto-parse on `core_memory_replace` |
| Near-duplicate facts accumulating | Weekly `archival_deduplicate` cron |
| Daily logs piling up | Daily `memory-maintenance.sh` merges 7-day-old logs into weekly summaries |
| Stale `current_focus` items | Agent prompted to update via `memory_reflect` analysis |

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
| `workspace` | Auto-resolved per agent | Override workspace directory |
| `coreSizeLimit` | `3072` (3KB) | Max core.json size |
| `sharing` | `true` | Cross-agent memory sharing. Set `false` for multi-user privacy. |

Semantic search requires `OPENAI_API_KEY` in environment (optional — graceful degradation).

---

## Automated Maintenance

### Cron Jobs (registered by setup.sh)

| Schedule | Job | Description |
|----------|-----|-------------|
| Daily 9:00am | `memory-reflect-daily` | Analyze patterns, store observations |
| Every 6h | `memory-consolidate-6h` | Extract missed facts from daily logs |
| Weekly Sunday 4am | `memory-dedup-weekly` | Clean near-duplicate records |
| Daily 9:30am | `memory-dashboard-daily` | Refresh browsable HTML dashboard |

### File Maintenance (daily 3am)

| Action | Trigger | Description |
|--------|---------|-------------|
| Size check | MEMORY.md >4KB | Warn alert |
| Size check | MEMORY.md >5KB | Critical alert |
| Log merge | Daily logs >7 days old | Merge into weekly summaries |
| Archive | Weekly summaries >60 days | Move to archive/ |
| Topic check | Topic file >8KB | Warn alert |

Alerts written to `memory/maintenance-alerts.json`, checked by agent during heartbeats.

---

## Storage Files

| File | Purpose | Growth | Format |
|------|---------|--------|--------|
| `memory/core.json` | Identity block | Fixed ~1-3KB | JSON |
| `memory/archival.jsonl` | Fact storage | Grows with usage | JSONL |
| `memory/graph.jsonl` | Knowledge graph | Grows with relations | JSONL |
| `memory/episodes.jsonl` | Conversation summaries | Grows per conversation | JSONL |
| `memory/archival.embeddings.json` | Embedding vectors | ~2KB per record | JSON |
| `memory/memory.sqlite` | SQLite index (optional) | After `memory_migrate` | SQLite |
| `memory/dashboard.html` | Browsable report | Regenerated daily | HTML |
| `memory/maintenance-alerts.json` | Health alerts | Regenerated daily | JSON |

---

## Project Structure

```
memory-engine/
├── index.js                  # Plugin entry — 19 tools via ToolFactory pattern
├── lib/
│   ├── paths.js              # Constants, multi-workspace resolution, agent mapping
│   ├── core.js               # Core memory CRUD + dot-path + auto-parse
│   ├── archival.js           # JSONL storage + in-memory cache
│   ├── embedding.js          # OpenAI embedding API + cache + batch backfill
│   ├── search.js             # Hybrid 5-signal search with forgetting curve
│   ├── graph.js              # Knowledge graph: triple store + traversal + auto-extract
│   ├── episodes.js           # Episodic memory: save + hybrid recall
│   ├── reflection.js         # Statistical pattern analysis (8 dimensions)
│   ├── consolidate.js        # Text → structured facts (sentence split + entity inference)
│   ├── dedup.js              # Embedding cosine similarity deduplication
│   ├── backup.js             # Export / import with format versioning
│   ├── store-sqlite.js       # SQLite backend with FTS5 + WAL mode
│   └── dashboard.js          # Self-contained HTML dashboard generator
├── extras/
│   ├── memory-maintenance.sh # Daily file cleanup script
│   ├── migrate-legacy.mjs    # Standalone legacy data migration tool
│   └── auto-consolidation-crons.json
├── setup.sh                  # One-command install (interactive, cross-platform)
├── .claude/CLAUDE.md         # Development guide for Claude Code
├── ROADMAP.md                # Planned features
├── openclaw.plugin.json      # Plugin manifest with config schema
└── package.json
```

---

## Migrating from File-Based Memory

If you already have MEMORY.md and daily log files, `setup.sh` handles migration automatically:

```
📦 Found 15 legacy memory files.
   Migrate into archival memory? [Y/n]: Y
  MEMORY.md: +87 facts
  2026-03-28.md: +42 facts
  2026-03-30.md: +29 facts
✅ Migration complete: 158 facts imported, 3 skipped
```

Manual migration: `node ~/.openclaw/extensions/memory-engine/extras/migrate-legacy.mjs [workspace_path]`

After migration, embeddings are auto-computed on next gateway restart (no manual step needed).

---

## Platforms

| Platform | Maintenance Scheduler | Status |
|----------|----------------------|--------|
| macOS | LaunchAgent | Full support |
| Linux | systemd user timer | Full support |
| Windows | schtasks | Guided setup |

---

## Roadmap

See [ROADMAP.md](ROADMAP.md) for details.

- [x] Core memory with size guard + auto-parse
- [x] Archival CRUD + hybrid 5-signal search
- [x] Knowledge graph with auto-extraction
- [x] Episodic memory with conversation recall
- [x] Importance scoring + forgetting curves
- [x] Behavioral reflection + auto-consolidation
- [x] SQLite backend (FTS5) + HTML dashboard
- [x] Multi-workspace isolation (ToolFactory pattern)
- [x] Legacy data migration + embedding auto-backfill
- [x] Cross-platform support (macOS / Linux / Windows)
- [ ] LanceDB vector-native backend
- [ ] Memory importance auto-rating via LLM
- [ ] Web dashboard served via gateway HTTP route

---

## License

MIT

Built for [OpenClaw](https://openclaw.ai). Inspired by [MemGPT/Letta](https://github.com/cpacker/MemGPT).
