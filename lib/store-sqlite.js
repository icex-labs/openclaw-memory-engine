/**
 * SQLite storage backend with FTS5 full-text search.
 *
 * Schema:
 *   archival: id, ts, content, entity, tags (JSON), importance, last_accessed, access_count, source, updated_at
 *   archival_fts: FTS5 virtual table on (content, entity, tags_text)
 *   graph: id, subject, relation, object, ts, source
 *   episodes: id, ts, summary, decisions (JSON), mood, topics (JSON), participants (JSON), duration_minutes
 *   episodes_fts: FTS5 on (summary, decisions_text, topics_text)
 *   embeddings: record_id, vector (BLOB)
 *   meta: key, value
 */

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";

const DB_FILENAME = "memory.sqlite";

/** Per-workspace database handles. */
const handles = new Map();

function dbPath(ws) { return join(ws, "memory", DB_FILENAME); }

function getDb(ws) {
  if (handles.has(ws)) return handles.get(ws);
  mkdirSync(join(ws, "memory"), { recursive: true });
  const db = new DatabaseSync(dbPath(ws));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  initSchema(db);
  handles.set(ws, db);
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS archival (
      id TEXT PRIMARY KEY,
      ts TEXT,
      content TEXT NOT NULL,
      entity TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      importance INTEGER DEFAULT 5,
      last_accessed TEXT,
      access_count INTEGER DEFAULT 0,
      source TEXT DEFAULT '',
      updated_at TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS archival_fts USING fts5(
      content, entity, tags_text, content='archival', content_rowid='rowid'
    );
    CREATE TRIGGER IF NOT EXISTS archival_ai AFTER INSERT ON archival BEGIN
      INSERT INTO archival_fts(rowid, content, entity, tags_text)
      VALUES (new.rowid, new.content, new.entity, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS archival_ad AFTER DELETE ON archival BEGIN
      INSERT INTO archival_fts(archival_fts, rowid, content, entity, tags_text)
      VALUES ('delete', old.rowid, old.content, old.entity, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS archival_au AFTER UPDATE ON archival BEGIN
      INSERT INTO archival_fts(archival_fts, rowid, content, entity, tags_text)
      VALUES ('delete', old.rowid, old.content, old.entity, old.tags);
      INSERT INTO archival_fts(rowid, content, entity, tags_text)
      VALUES (new.rowid, new.content, new.entity, new.tags);
    END;

    CREATE TABLE IF NOT EXISTS graph (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      relation TEXT NOT NULL,
      object TEXT NOT NULL,
      ts TEXT,
      source TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_graph_subject ON graph(subject COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_graph_object ON graph(object COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      ts TEXT,
      summary TEXT NOT NULL,
      decisions TEXT DEFAULT '[]',
      mood TEXT DEFAULT '',
      topics TEXT DEFAULT '[]',
      participants TEXT DEFAULT '[]',
      duration_minutes INTEGER
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
      summary, decisions_text, topics_text, content='episodes', content_rowid='rowid'
    );
    CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
      INSERT INTO episodes_fts(rowid, summary, decisions_text, topics_text)
      VALUES (new.rowid, new.summary, new.decisions, new.topics);
    END;

    CREATE TABLE IF NOT EXISTS embeddings (
      record_id TEXT PRIMARY KEY,
      vector BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Set schema version
  const stmt = db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', '1')");
  stmt.run();
}

// ═══════════════════════════════════════════════════════════════════
// Archival operations
// ═══════════════════════════════════════════════════════════════════

export function sqliteLoadArchival(ws) {
  const db = getDb(ws);
  const rows = db.prepare("SELECT * FROM archival ORDER BY ts ASC").all();
  return rows.map((r) => ({
    ...r,
    tags: JSON.parse(r.tags || "[]"),
  }));
}

export function sqliteAppendRecord(ws, entry) {
  const db = getDb(ws);
  const id = `arch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id,
    ts: new Date().toISOString(),
    content: entry.content,
    entity: entry.entity || "",
    tags: entry.tags || [],
    importance: entry.importance ?? 5,
    last_accessed: null,
    access_count: 0,
    source: entry.source || "",
    updated_at: null,
  };
  db.prepare(`
    INSERT INTO archival(id, ts, content, entity, tags, importance, last_accessed, access_count, source, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, record.ts, record.content, record.entity, JSON.stringify(record.tags),
    record.importance, record.last_accessed, record.access_count, record.source, record.updated_at);
  return record;
}

export function sqliteUpdateRecord(ws, id, updates) {
  const db = getDb(ws);
  const sets = [];
  const vals = [];
  if (updates.content !== undefined) { sets.push("content=?"); vals.push(updates.content); }
  if (updates.entity !== undefined) { sets.push("entity=?"); vals.push(updates.entity); }
  if (updates.tags !== undefined) { sets.push("tags=?"); vals.push(JSON.stringify(updates.tags)); }
  if (updates.importance !== undefined) { sets.push("importance=?"); vals.push(updates.importance); }
  if (updates.last_accessed !== undefined) { sets.push("last_accessed=?"); vals.push(updates.last_accessed); }
  if (updates.access_count !== undefined) { sets.push("access_count=?"); vals.push(updates.access_count); }
  sets.push("updated_at=?"); vals.push(new Date().toISOString());
  vals.push(id);
  db.prepare(`UPDATE archival SET ${sets.join(", ")} WHERE id=?`).run(...vals);
}

export function sqliteDeleteRecord(ws, id) {
  const db = getDb(ws);
  const row = db.prepare("SELECT content FROM archival WHERE id=?").get(id);
  if (!row) return null;
  db.prepare("DELETE FROM archival WHERE id=?").run(id);
  db.prepare("DELETE FROM embeddings WHERE record_id=?").run(id);
  return row.content;
}

/**
 * FTS5 keyword search + scoring.
 * @returns {Array<{ record, score }>}
 */
export function sqliteFtsSearch(ws, query, topK = 5) {
  const db = getDb(ws);
  try {
    const rows = db.prepare(`
      SELECT a.*, rank
      FROM archival_fts fts
      JOIN archival a ON a.rowid = fts.rowid
      WHERE archival_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, topK * 2); // over-fetch for re-ranking

    return rows.map((r) => ({
      record: { ...r, tags: JSON.parse(r.tags || "[]") },
      ftsScore: -r.rank, // FTS5 rank is negative (lower = better)
    }));
  } catch {
    // FTS5 query syntax error — fall back to LIKE
    const likeQuery = `%${query}%`;
    const rows = db.prepare(`
      SELECT * FROM archival
      WHERE content LIKE ? OR entity LIKE ?
      ORDER BY ts DESC
      LIMIT ?
    `).all(likeQuery, likeQuery, topK);
    return rows.map((r) => ({
      record: { ...r, tags: JSON.parse(r.tags || "[]") },
      ftsScore: 1,
    }));
  }
}

export function sqliteArchivalCount(ws) {
  const db = getDb(ws);
  return db.prepare("SELECT COUNT(*) as cnt FROM archival").get().cnt;
}

export function sqliteArchivalStats(ws) {
  const db = getDb(ws);
  const total = db.prepare("SELECT COUNT(*) as cnt FROM archival").get().cnt;
  const embCount = db.prepare("SELECT COUNT(*) as cnt FROM embeddings").get().cnt;
  const graphCount = db.prepare("SELECT COUNT(*) as cnt FROM graph").get().cnt;
  const episodeCount = db.prepare("SELECT COUNT(*) as cnt FROM episodes").get().cnt;

  const entities = db.prepare(`
    SELECT entity, COUNT(*) as cnt FROM archival
    WHERE entity != '' GROUP BY entity ORDER BY cnt DESC LIMIT 10
  `).all();

  return { total, embCount, graphCount, episodeCount, entities };
}

// ═══════════════════════════════════════════════════════════════════
// Graph operations
// ═══════════════════════════════════════════════════════════════════

export function sqliteAddTriple(ws, subject, relation, object, sourceId = null) {
  const db = getDb(ws);
  const existing = db.prepare(
    "SELECT id FROM graph WHERE subject=? COLLATE NOCASE AND relation=? COLLATE NOCASE AND object=? COLLATE NOCASE"
  ).get(subject, relation, object);
  if (existing) return null;

  const id = `tri-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare("INSERT INTO graph(id, subject, relation, object, ts, source) VALUES(?,?,?,?,?,?)")
    .run(id, subject, relation, object, new Date().toISOString(), sourceId);
  return { id, s: subject, r: relation, o: object };
}

export function sqliteQueryGraph(ws, entity, relation = null, depth = 2) {
  const db = getDb(ws);
  const results = [];
  const visited = new Set();

  function traverse(current, d, path) {
    if (d > depth) return;
    const key = `${current}:${d}`;
    if (visited.has(key)) return;
    visited.add(key);

    let rows;
    if (relation) {
      rows = db.prepare(
        "SELECT * FROM graph WHERE (subject=? COLLATE NOCASE OR object=? COLLATE NOCASE) AND relation=? COLLATE NOCASE"
      ).all(current, current, relation);
    } else {
      rows = db.prepare(
        "SELECT * FROM graph WHERE subject=? COLLATE NOCASE OR object=? COLLATE NOCASE"
      ).all(current, current);
    }

    for (const t of rows) {
      const isForward = t.subject.toLowerCase() === current.toLowerCase();
      const node = isForward ? t.object : t.subject;
      const dir = isForward ? `--${t.relation}-->` : `<--${t.relation}--`;
      results.push({ path: [...path, dir], node, triple: { id: t.id, s: t.subject, r: t.relation, o: t.object } });
      traverse(node, d + 1, [...path, dir, node]);
    }
  }

  traverse(entity, 1, [entity]);
  return results;
}

// ═══════════════════════════════════════════════════════════════════
// Episode operations
// ═══════════════════════════════════════════════════════════════════

export function sqliteSaveEpisode(ws, ep) {
  const db = getDb(ws);
  const id = `ep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`
    INSERT INTO episodes(id, ts, summary, decisions, mood, topics, participants, duration_minutes)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(id, new Date().toISOString(), ep.summary,
    JSON.stringify(ep.decisions || []), ep.mood || "",
    JSON.stringify(ep.topics || []), JSON.stringify(ep.participants || []),
    ep.duration_minutes || null);
  return { id, type: "episode", ts: new Date().toISOString(), ...ep };
}

export function sqliteSearchEpisodes(ws, query, lastN = 5) {
  const db = getDb(ws);
  if (!query) {
    const rows = db.prepare("SELECT * FROM episodes ORDER BY ts DESC LIMIT ?").all(lastN);
    return rows.map((r) => ({
      ...r, decisions: JSON.parse(r.decisions || "[]"),
      topics: JSON.parse(r.topics || "[]"), participants: JSON.parse(r.participants || "[]"),
    }));
  }
  try {
    const rows = db.prepare(`
      SELECT e.* FROM episodes_fts fts
      JOIN episodes e ON e.rowid = fts.rowid
      WHERE episodes_fts MATCH ?
      ORDER BY rank LIMIT ?
    `).all(query, lastN);
    return rows.map((r) => ({
      ...r, decisions: JSON.parse(r.decisions || "[]"),
      topics: JSON.parse(r.topics || "[]"), participants: JSON.parse(r.participants || "[]"),
    }));
  } catch {
    const rows = db.prepare("SELECT * FROM episodes WHERE summary LIKE ? ORDER BY ts DESC LIMIT ?")
      .all(`%${query}%`, lastN);
    return rows.map((r) => ({
      ...r, decisions: JSON.parse(r.decisions || "[]"),
      topics: JSON.parse(r.topics || "[]"), participants: JSON.parse(r.participants || "[]"),
    }));
  }
}

// ═══════════════════════════════════════════════════════════════════
// Embedding operations
// ═══════════════════════════════════════════════════════════════════

export function sqliteGetEmbedding(ws, recordId) {
  const db = getDb(ws);
  const row = db.prepare("SELECT vector FROM embeddings WHERE record_id=?").get(recordId);
  if (!row) return null;
  return Array.from(new Float32Array(row.vector.buffer));
}

export function sqliteSaveEmbedding(ws, recordId, vector) {
  const db = getDb(ws);
  const buf = Buffer.from(new Float32Array(vector).buffer);
  db.prepare("INSERT OR REPLACE INTO embeddings(record_id, vector) VALUES(?,?)").run(recordId, buf);
}

// ═══════════════════════════════════════════════════════════════════
// Migration: JSONL → SQLite
// ═══════════════════════════════════════════════════════════════════

export function migrateFromJsonl(ws) {
  const db = getDb(ws);
  const memDir = join(ws, "memory");
  let imported = { archival: 0, graph: 0, episodes: 0, embeddings: 0 };

  // Archival
  const archivalFile = join(memDir, "archival.jsonl");
  if (existsSync(archivalFile)) {
    const lines = readFileSync(archivalFile, "utf-8").trim().split("\n").filter(Boolean);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO archival(id, ts, content, entity, tags, importance, last_accessed, access_count, source, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        insert.run(r.id, r.ts, r.content, r.entity || "", JSON.stringify(r.tags || []),
          r.importance ?? 5, r.last_accessed, r.access_count || 0, r.source || "", r.updated_at || null);
        imported.archival++;
      } catch { /* skip bad lines */ }
    }
  }

  // Graph
  const graphFile = join(memDir, "graph.jsonl");
  if (existsSync(graphFile)) {
    const lines = readFileSync(graphFile, "utf-8").trim().split("\n").filter(Boolean);
    const insert = db.prepare("INSERT OR IGNORE INTO graph(id, subject, relation, object, ts, source) VALUES(?,?,?,?,?,?)");
    for (const line of lines) {
      try {
        const t = JSON.parse(line);
        insert.run(t.id, t.s, t.r, t.o, t.ts, t.source);
        imported.graph++;
      } catch { /* skip */ }
    }
  }

  // Episodes
  const epFile = join(memDir, "episodes.jsonl");
  if (existsSync(epFile)) {
    const lines = readFileSync(epFile, "utf-8").trim().split("\n").filter(Boolean);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO episodes(id, ts, summary, decisions, mood, topics, participants, duration_minutes)
      VALUES(?,?,?,?,?,?,?,?)
    `);
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        insert.run(e.id, e.ts, e.summary, JSON.stringify(e.decisions || []),
          e.mood || "", JSON.stringify(e.topics || []), JSON.stringify(e.participants || []),
          e.duration_minutes || null);
        imported.episodes++;
      } catch { /* skip */ }
    }
  }

  // Embeddings
  const embFile = join(memDir, "archival.embeddings.json");
  if (existsSync(embFile)) {
    try {
      const data = JSON.parse(readFileSync(embFile, "utf-8"));
      const insert = db.prepare("INSERT OR IGNORE INTO embeddings(record_id, vector) VALUES(?,?)");
      for (const [id, vec] of Object.entries(data)) {
        const buf = Buffer.from(new Float32Array(vec).buffer);
        insert.run(id, buf);
        imported.embeddings++;
      }
    } catch { /* skip */ }
  }

  return imported;
}

export { dbPath };
