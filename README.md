# @icex-labs/openclaw-memory-engine

> Your agent remembers everything. Automatically.

[![npm](https://img.shields.io/npm/v/@icex-labs/openclaw-memory-engine)](https://www.npmjs.com/package/@icex-labs/openclaw-memory-engine)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An [OpenClaw](https://openclaw.ai) plugin that gives your agent persistent, structured memory. Every conversation is automatically captured — the agent doesn't need to do anything. No "let me save that" messages, no manual tool calls. Memory just happens.

---

## The Problem

OpenClaw agents wake up fresh every session. They forget who you are, what you discussed, and what matters to you.

Previous solutions required the agent to manually call memory tools — but agents forget to do that too.

## The Solution

**Passive memory capture via hooks** + five-layer architecture inspired by [MemGPT/Letta](https://github.com/cpacker/MemGPT):

1. **Auto-Capture Hooks** — every message in/out is automatically analyzed and stored. Zero agent effort.
2. **Core Memory** (~500 tokens) — identity, relationship, preferences. Always loaded.
3. **Archival Memory** (unlimited) — facts with importance scoring. Hybrid semantic search.
4. **Knowledge Graph** — entity relations, auto-extracted. "Who is my doctor?" → graph traversal.
5. **Episodic Memory** — conversation summaries. "What did we discuss last time?"
6. **Reflective Memory** — behavioral pattern analysis. Topic trends, mood shifts.

The agent doesn't say "I'll remember that." It just remembers.

---

## Install

```bash
openclaw plugins install @icex-labs/openclaw-memory-engine
bash ~/.openclaw/extensions/memory-engine/setup.sh
openclaw gateway restart
```

### What setup.sh does

1. **Interactive core memory setup** — prompts for name, location, role, relationship
2. **Legacy data migration** — detects existing MEMORY.md / daily logs, imports into archival with dedup
3. **Data quality pass** — re-classifies entities, re-rates importance, extracts graph triples
4. **Platform scheduler** — daily maintenance (macOS LaunchAgent / Linux systemd / Windows schtasks)
5. **Config + agent instructions** — patches `openclaw.json` and `AGENTS.md`
6. **Cron registration** — 4 automated jobs (reflection, consolidation, dedup, dashboard)
7. **Embedding backfill** — on next restart, missing embeddings auto-computed in background

`--non-interactive` flag available for scripted installs.

---

## How It Works

### Passive Capture (Hooks)

```
User sends message on Telegram/Discord/WhatsApp
    │
    ├─→ Hook: message:received
    │     Content ≥ 20 chars? Not a greeting? Not already stored?
    │     → Auto-store in archival (entity inferred, importance scored)
    │     → Auto-extract knowledge graph triples
    │     → Embedding computed in background
    │
    ├─→ Agent processes and replies
    │
    └─→ Hook: message:sent
          Reply ≥ 50 chars? Not duplicate (60s window)?
          → Auto-store agent reply

No tool calls needed. No "I'll remember that." Just memory.
```

### Dedup Safety

- **60-second content hash** — prevents duplicate captures from streaming/retry events
- **Keyword overlap check** — if agent already stored the same fact via manual `archival_insert`, hook skips it
- **Result:** exactly one copy of each fact, regardless of who stores it first

### Multi-Agent Isolation

```
Session key "agent:wife:telegram:..." → workspace-wife/
Session key "agent:main:telegram:..." → workspace/

Each agent's hooks + tools operate on their own workspace.
Zero cross-contamination. Automatic.
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                       Agent Context Window                       │
│                                                                   │
│  ┌─ Passive: Auto-Capture Hooks ──────────────────────────────┐  │
│  │  message:received → analyze → store fact + graph + embed    │  │
│  │  message:sent     → analyze → store reply (deduped)         │  │
│  │  No agent action needed. Runs on every conversation.        │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─ Layer 1: Core Memory ─────────────────────────────────────┐  │
│  │  core_memory_read() → core.json (~500 tokens)              │  │
│  │  Identity, relationship, preferences, current_focus         │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─ Layer 2: Archival Memory ─────────────────────────────────┐  │
│  │  archival_search(query) → hybrid 5-signal ranking          │  │
│  │  Unlimited JSONL. Auto-populated by hooks.                  │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─ Layer 3: Knowledge Graph ─────────────────────────────────┐  │
│  │  graph_query(entity) → traverse relations                   │  │
│  │  Auto-extracted from every captured message.                │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─ Layer 4: Episodic Memory ─────────────────────────────────┐  │
│  │  episode_save / episode_recall                              │  │
│  │  Conversation summaries with decisions, mood, topics.       │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─ Layer 5: Reflective Memory ───────────────────────────────┐  │
│  │  memory_reflect → pattern analysis report                   │  │
│  │  Topic trends, time distribution, mood shifts.              │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Tools (20) + Hooks (2)

### Hooks (Passive — No Agent Action)

| Hook | Trigger | What it does |
|------|---------|-------------|
| `memory-engine-capture-received` | Every incoming message | Auto-stores facts, infers entity + importance, extracts graph triples |
| `memory-engine-capture-sent` | Every agent reply | Auto-stores replies (deduped, 60s window) |

### Core Memory (3 tools)

| Tool | Description |
|------|-------------|
| `core_memory_read` | Load identity block. Call every session start. |
| `core_memory_replace` | Update field by dot-path. Auto-parses JSON strings. 3KB limit. |
| `core_memory_append` | Append to array field. |

### Archival Memory (5 tools)

| Tool | Description |
|------|-------------|
| `archival_insert` | Manually store a fact (only needed for non-conversation sources). |
| `archival_search` | Hybrid 5-signal search: keyword + semantic + recency + access + importance. |
| `archival_update` | Correct an existing record. |
| `archival_delete` | Remove outdated record. |
| `archival_stats` | Record count, entity/tag distribution, embedding coverage. |

### Knowledge Graph (2 tools)

| Tool | Description |
|------|-------------|
| `graph_query` | Traverse entity relations with depth control. |
| `graph_add` | Manually add a relation triple. |

### Episodic Memory (2 tools)

| Tool | Description |
|------|-------------|
| `episode_save` | Save conversation summary with decisions, mood, topics. |
| `episode_recall` | Search past conversations by topic or get recent N. |

### Intelligence (4 tools)

| Tool | Description |
|------|-------------|
| `memory_reflect` | Analyze behavioral patterns over configurable time window. |
| `archival_deduplicate` | Find/remove near-duplicates via embedding cosine similarity. |
| `memory_consolidate` | Extract structured facts from text blocks. |
| `memory_quality` | Re-classify entities, re-rate importance, extract missing graph triples. |

### Backup & Admin (4 tools)

| Tool | Description |
|------|-------------|
| `memory_export` | Full snapshot → JSON file. |
| `memory_import` | Restore with merge or replace mode. |
| `memory_migrate` | JSONL → SQLite with FTS5. |
| `memory_dashboard` | Generate browsable HTML dashboard. |

---

## Search Scoring

`archival_search` combines five signals:

| Signal | Weight | Description |
|--------|--------|-------------|
| Keyword | 2× per term | Term presence in content + entity + tags |
| Semantic | 5× | Cosine similarity via OpenAI `text-embedding-3-small` (512d) |
| Recency | 0–1 | Linear decay over 1 year |
| Access | 0–0.5 | Boost for recently accessed records |
| Importance | 0.5× | Forgetting curve: `importance × e^(-0.01 × days)` |

Falls back to keyword-only without OpenAI key. Cost: ~$0.001/session.

---

## Classification (v5.0)

Entity and importance classification is **embedding-based** — no hardcoded keywords, works with any language.

```
With OPENAI_API_KEY (recommended):
  15 entity anchors (health, finance, immigration, legal, vehicles, ...)
  4 importance anchors (critical / high / medium / low)
  Anchor embeddings computed once, cached to classifier-anchors.json
  → Language-agnostic: Japanese, French, Korean, Chinese, English all work

Without OPENAI_API_KEY (fallback):
  Format-based heuristics:
    $amounts → finance (importance 7)
    URLs/code → technology
    Dates → importance 6
    Short messages → low importance
    Long messages → high importance
  → Basic but functional, no API cost
```

Real results on 2,751 records:

| Metric | Before (regex v4) | After (embedding v5) |
|--------|-------------------|---------------------|
| "general" entities | 45% | **29%** |
| flat importance=5 | 71% | **39%** |
| Languages supported | English + Chinese | **any** |
| Hardcoded keywords | 100+ | **zero** |

---

## Self-Healing

| Issue | Auto-fix |
|-------|----------|
| Missing embeddings | Batch backfill on restart (all workspaces) |
| Agent forgets to save | Hooks capture everything passively |
| Duplicate facts | 60s dedup + keyword overlap + weekly cron |
| Flat importance scores | Embedding-based re-rating via `memory_quality` |
| General entity labels | Embedding-based re-classification via `memory_quality` |
| No API key | Format-based fallback classifier (basic but functional) |

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

| Schedule | Job | Description |
|----------|-----|-------------|
| Every 6h | Consolidate | Extract missed facts from daily logs |
| Daily 9am | Reflect | Analyze patterns, store observations |
| Daily 9:30am | Dashboard | Refresh browsable HTML report |
| Weekly Sunday | Dedup | Clean near-duplicate records |
| Daily 3am | File cleanup | Merge old logs, archive old summaries |

Per-agent crons auto-registered for agents with separate workspaces.

---

## Project Structure

```
memory-engine/
├── index.js                  # Plugin entry: 20 tools + 2 hooks (ToolFactory pattern)
├── lib/
│   ├── paths.js              # Constants, multi-workspace resolution
│   ├── core.js               # Core memory CRUD + auto-parse
│   ├── archival.js           # JSONL storage + in-memory cache
│   ├── embedding.js          # OpenAI embedding API + cache + batch backfill
│   ├── search.js             # Hybrid 5-signal search with forgetting curve
│   ├── graph.js              # Knowledge graph: triples + traversal + auto-extract
│   ├── episodes.js           # Episodic memory: save + recall
│   ├── reflection.js         # Statistical pattern analysis
│   ├── consolidate.js        # Text → facts extraction
│   ├── dedup.js              # Embedding similarity dedup
│   ├── backup.js             # Export / import
│   ├── store-sqlite.js       # SQLite backend (FTS5)
│   ├── dashboard.js          # HTML dashboard generator
│   ├── classifier.js          # Embedding-based entity + importance classification
│   ├── quality.js             # Data quality pass (uses classifier)
│   └── auto-capture.js        # Passive hooks: message → archival (uses classifier)
├── extras/
│   ├── memory-maintenance.sh
│   ├── migrate-legacy.mjs
│   └── auto-consolidation-crons.json
├── setup.sh
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
