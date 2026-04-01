# @icex-labs/openclaw-memory-engine

MemGPT-style hierarchical memory plugin for [OpenClaw](https://openclaw.ai).

## What it does

Gives your OpenClaw agent 4 memory tools:

| Tool | Description |
|------|-------------|
| `core_memory_read` | Read the core memory block (~500 tokens, always small) |
| `core_memory_replace` | Atomically update a field in core memory (dot-path notation) |
| `archival_insert` | Store a fact/memory in archival storage (unlimited, tagged) |
| `archival_search` | Keyword search over archival with recency boost |

## Architecture

```
┌─────────────────────────────────┐
│       Agent Context Window      │
│                                 │
│  core_memory_read() → core.json │  ← ~500 tokens
│                                 │
│  archival_search(query) ────────│──→ archival.jsonl
│  archival_insert(fact)  ────────│──→ archival.jsonl
│  core_memory_replace(k, v) ─────│──→ core.json
└─────────────────────────────────┘
```

**Core Memory** (`memory/core.json`): Small structured block with user identity, relationship dynamics, preferences, and current focus. Always loaded, kept under 3KB. The agent updates it atomically.

**Archival Memory** (`memory/archival.jsonl`): Unlimited append-only storage for facts, decisions, events, and details. Tagged with entity names and categories for retrieval. Keyword search with recency boost.

## Install

```bash
# From npm
openclaw plugins install @icex-labs/openclaw-memory-engine

# Or manually
git clone https://github.com/icex-labs/openclaw-memory-engine.git ~/.openclaw/extensions/memory-engine
```

## Configure

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

### Config options

| Option | Default | Description |
|--------|---------|-------------|
| `workspace` | Auto-resolved | Path to workspace directory |
| `coreSizeLimit` | `3072` | Max bytes for core.json |
| `archivalSearchTopK` | `5` | Default results for archival_search |

## Usage

Teach your agent to use the memory tools by adding instructions to your system prompt (AGENTS.md, SOUL.md, etc.):

```markdown
## Every Session
1. Call `core_memory_read` to load your identity and context
2. When you learn something important → `archival_insert`
3. When you need to recall details → `archival_search`
4. When facts change → `core_memory_replace`
```

### Core memory structure

```json
{
  "_meta": { "version": 1, "updated_at": "..." },
  "user": { "name": "...", "location": "...", "language": "..." },
  "relationship": { "dynamic": "...", "trust": "...", "boundaries": "..." },
  "preferences": { "...": "..." },
  "current_focus": ["project A", "project B"]
}
```

### Archival record format

```jsonl
{"id":"arch-1234-abc","ts":"2026-04-01T00:00:00Z","content":"fact or memory","entity":"person_or_thing","tags":["category"]}
```

## How search works

`archival_search` uses keyword matching with:
- **Term frequency**: counts how many query terms appear in each record
- **Exact phrase bonus**: +3 for full phrase match
- **Recency boost**: newer records get a 0-1 score bonus (decays over 1 year)

For production use with large archival stores (10K+ records), consider pairing with OpenClaw's built-in `memorySearch` (embedding-based) for semantic retrieval.

## License

MIT
