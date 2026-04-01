# Roadmap

## v1.3.0 (current) — Foundation

- [x] Core memory (read / replace / append) with 3KB guard + auto-parse
- [x] Archival CRUD (insert / search / update / delete / stats)
- [x] Hybrid search: keyword + OpenAI embedding + recency + access decay
- [x] Auto-extract facts from text (memory_consolidate)
- [x] Embedding-based deduplication
- [x] Full backup/restore (export / import with merge/replace)
- [x] Access tracking (last_accessed, access_count)
- [x] Modular codebase (8 lib modules)
- [x] npm + GitHub publishing
- [x] setup.sh one-command install
- [x] Daily maintenance cron (memory-maintenance.sh)
- [x] .claude/CLAUDE.md dev guide

---

## v2.0 — Knowledge Graph + Episodic Memory

### 2.1: Knowledge Graph (`lib/graph.js`)

**Why:** Flat fact list can't answer relational questions like "who treats George's skin condition" — requires traversing George → has_condition → 荨麻疹 → treated_by → Cetirizine → prescribed_by → Dr. Mohamed.

**Design:**
- New file: `memory/graph.jsonl` — triple store `(subject, relation, object)`
- On `archival_insert`, auto-extract triples using pattern matching:
  - `"George's doctor is Dr. Mohamed"` → `(George, has_doctor, Dr.Mohamed)`
  - `"ES350 定价 $19,500"` → `(ES350, price, $19500)`
- New tools:
  - `graph_query(entity, relation?, depth?)` — traverse from entity, return connected nodes
  - `graph_add(subject, relation, object)` — manual triple insertion
- Search upgrade: `archival_search` does graph traversal first, then pulls related facts
- Storage: JSONL for simplicity, migrate to SQLite if >10K triples

### 2.2: Episodic Memory (`lib/episodes.js`)

**Why:** Agent can recall facts but not conversations. "What did we discuss last time about the car?" → blank.

**Design:**
- New file: `memory/episodes.jsonl`
- Auto-generated at conversation end (via `memory_consolidate` or compaction hook):
  ```json
  {
    "type": "episode",
    "ts": "2026-04-01T01:00:00Z",
    "participants": ["George", "Maren"],
    "summary": "Discussed ES350 pricing, settled on $19,500 for Facebook Marketplace",
    "decisions": ["ES350 = $19,500", "List on Facebook Marketplace"],
    "mood": "relaxed",
    "topics": ["vehicles", "finance"],
    "duration_minutes": 25
  }
  ```
- New tools:
  - `episode_recall(query?, last_n?)` — search episodes by topic or get recent N
  - `episode_save(summary, decisions, mood)` — manually save an episode
- Archival search also queries episodes when relevant

### 2.3: Importance Scoring

- `archival_insert` gains optional `importance` param (1-10, agent self-rates)
- Default importance: 5
- Search scoring adds: `importance × 0.5`
- Forgetting curve: `effective = importance × e^(-0.01 × days_since_access)`
- Records below threshold (effective < 1.0) auto-archived by maintenance script

---

## v2.5 — Reflection + Auto-Consolidation

### 2.4: Reflective Memory (`lib/reflection.js`)

**Why:** Agent doesn't notice patterns in George's behavior or evolve its understanding over time.

**Design:**
- New tool: `memory_reflect()`
  - Reads recent 20 archival records + last 5 episodes
  - Generates meta-observations about patterns:
    - "George has been discussing vehicles a lot this week — possible big purchase decision"
    - "Conversations shift to personal topics after midnight — he may need companionship"
  - Stores as `type: "reflection"` in archival
- Triggered by: heartbeat (every ~6 hours) or manually
- Reflections influence agent behavior via core memory `relationship.observations` field

### 2.5: Scheduled Auto-Consolidation

- OpenClaw cron job runs `memory_consolidate` on recent daily logs every 6 hours
- Extracts facts the agent forgot to insert during conversation
- Runs `archival_deduplicate` weekly
- Runs `memory_reflect` daily

---

## v3.0 — Multi-Agent + Storage Upgrade

### 3.1: Multi-Agent Memory Sharing

**Why:** main/discord/wife agents have separate memories. wife doesn't know what main learned.

**Design:**
- Shared archival layer with visibility labels:
  ```json
  {"content": "...", "visibility": ["main", "discord"], "private_to": null}
  {"content": "Jane体检", "visibility": ["wife"], "private_to": "wife"}
  ```
- New tools:
  - `archival_share(id, agents[])` — make a record visible to other agents
  - `archival_search` gains `scope` param: "own" (default) or "shared"
- Core memory remains per-agent (identity is personal)

### 3.2: SQLite / LanceDB Backend

**Why:** JSONL + in-memory cache won't scale past 50K records.

**Design:**
- Abstract storage layer: `lib/store.js` with pluggable backends
- Backends: `jsonl` (current, default), `sqlite`, `lancedb`
- Config: `"backend": "sqlite"` in plugin config
- SQLite: FTS5 for keyword search, vector column for embeddings
- LanceDB: native vector search, integrates with OpenClaw's `memory-lancedb` plugin
- Migration tool: `memory_migrate(from, to)` — converts between backends

### 3.3: Web Dashboard

- Read-only web UI for browsing memory (core + archival + graph + episodes)
- Served via OpenClaw gateway as a control panel page
- Timeline view of episodes, graph visualization, search explorer

---

## Implementation Priority

| Version | Effort | Impact | Do When |
|---------|--------|--------|---------|
| **v2.0** (graph + episodes) | 2-3 sessions | High — qualitative leap | **Next** |
| **v2.5** (reflection + auto-consolidate) | 1-2 sessions | Medium — self-improving | After v2.0 validated |
| **v3.0** (multi-agent + SQLite) | 3-4 sessions | Medium — scale + sharing | When archival >5K records |
| **v3.3** (dashboard) | 2 sessions | Nice-to-have | When George wants visibility |
