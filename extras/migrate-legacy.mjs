#!/usr/bin/env node
/**
 * migrate-legacy.mjs — Import existing file-based memory into archival.jsonl
 *
 * Scans workspace for: MEMORY.md, memory/*.md, memory/weekly/*.md, memory/topics/*.md
 * Extracts facts, deduplicates, and appends to memory/archival.jsonl.
 *
 * Usage: node migrate-legacy.mjs [workspace_path]
 */

import { readFileSync, appendFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

const WS = process.argv[2] || process.env.OPENCLAW_WORKSPACE || join(process.env.HOME || "/tmp", ".openclaw", "workspace");
const ARCHIVAL = join(WS, "memory", "archival.jsonl");

console.log(`🧠 Legacy memory migration`);
console.log(`   Workspace: ${WS}`);
console.log(`   Archival:  ${ARCHIVAL}`);
console.log(``);

// Load existing archival for dedup
const existingContent = new Set();
if (existsSync(ARCHIVAL)) {
  for (const line of readFileSync(ARCHIVAL, "utf-8").trim().split("\n").filter(Boolean)) {
    try { existingContent.add(JSON.parse(line).content?.toLowerCase()); } catch {}
  }
}
console.log(`Existing archival: ${existingContent.size} records`);

// Generic entity inference (no personal data)
const ENTITY_PATTERNS = [
  [/\b(IBKR|Interactive Brokers|NAV|portfolio|投资|HELOC|mortgage|finance)/i, "finance"],
  [/\b(immigration|PR|IRCC|CBSA|visa|律师|lawyer|petition)/i, "immigration"],
  [/\b(quant|trading|backtest|signal|portfolio|Sharpe)/i, "trading"],
  [/\b(doctor|医生|hospital|health|medication|药|体检|clinic)/i, "health"],
  [/\b(car|vehicle|SUV|sedan|truck)\b/i, "vehicles"],
  [/\b(k3d|ArgoCD|Helm|kubectl|GitOps|cluster|deploy|CI|CD)/i, "infrastructure"],
  [/\b(OpenClaw|gateway|plugin|session|agent|memory|compaction)/i, "openclaw"],
  [/\b(Discord|Telegram|Slack|bot|channel)/i, "messaging"],
  [/\b(school|university|college|学校|education)/i, "education"],
  [/\b(house|home|property|rent|房)/i, "property"],
  [/\b(lawyer|legal|court|lawsuit|案|诉)/i, "legal"],
];

function inferEntity(text) {
  for (const [pat, name] of ENTITY_PATTERNS) {
    if (pat.test(text)) return name;
  }
  return "general";
}

function extractFacts(text) {
  const facts = [];
  for (const line of text.split(/\n/).map((l) => l.trim()).filter(Boolean)) {
    if (line.startsWith("#") || line.length < 15) continue;
    if (/^(##|===|---|\*\*\*|```|>|\|)/.test(line)) continue;
    const sentences = line.split(/(?<=[。.！!？?；;])\s*/).filter(Boolean);
    for (const s of sentences) {
      const clean = s.replace(/^[-*•]\s*/, "").replace(/^\d+\.\s*/, "").trim();
      if (clean.length >= 15 && clean.length <= 500) facts.push(clean);
    }
  }
  return facts;
}

// Collect all legacy files
const files = [];

// MEMORY.md
const memoryMd = join(WS, "MEMORY.md");
if (existsSync(memoryMd)) files.push({ path: memoryMd, tag: "long-term" });

// memory/*.md (daily logs)
const memDir = join(WS, "memory");
if (existsSync(memDir)) {
  for (const f of readdirSync(memDir).filter((f) => /\.md$/.test(f) && f !== ".abstract")) {
    files.push({ path: join(memDir, f), tag: "daily" });
  }
}

// memory/weekly/*.md
const weeklyDir = join(WS, "memory", "weekly");
if (existsSync(weeklyDir)) {
  for (const f of readdirSync(weeklyDir).filter((f) => f.endsWith(".md"))) {
    files.push({ path: join(weeklyDir, f), tag: "weekly" });
  }
}

// memory/topics/*.md
const topicDir = join(WS, "memory", "topics");
if (existsSync(topicDir)) {
  for (const f of readdirSync(topicDir).filter((f) => f.endsWith(".md"))) {
    files.push({ path: join(topicDir, f), tag: "topic" });
  }
}

if (files.length === 0) {
  console.log("\nNo legacy memory files found. Nothing to migrate.");
  process.exit(0);
}

console.log(`Found ${files.length} files to scan\n`);

let inserted = 0;
let skipped = 0;

for (const { path, tag } of files) {
  const content = readFileSync(path, "utf-8");
  const facts = extractFacts(content);
  let fileInserted = 0;

  for (const fact of facts) {
    const factLower = fact.toLowerCase();

    // Exact dedup
    if (existingContent.has(factLower)) {
      skipped++;
      continue;
    }

    // Keyword overlap dedup (>75% overlap = skip)
    let isDupe = false;
    const factWords = new Set(factLower.split(/\s+/).filter((w) => w.length > 2));
    if (factWords.size > 0) {
      for (const ex of existingContent) {
        const exWords = new Set(ex.split(/\s+/).filter((w) => w.length > 2));
        let overlap = 0;
        for (const w of factWords) {
          if (exWords.has(w)) overlap++;
        }
        if (overlap / factWords.size > 0.75) {
          isDupe = true;
          break;
        }
      }
    }
    if (isDupe) {
      skipped++;
      continue;
    }

    const record = {
      id: `arch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      last_accessed: null,
      access_count: 0,
      importance: 5,
      content: fact,
      entity: inferEntity(fact),
      tags: [tag],
      source: "migration",
    };

    appendFileSync(ARCHIVAL, JSON.stringify(record) + "\n", "utf-8");
    existingContent.add(factLower);
    inserted++;
    fileInserted++;
  }

  if (fileInserted > 0) console.log(`  ${basename(path)}: +${fileInserted} facts`);
}

console.log(`\n✅ Migration complete: ${inserted} facts imported, ${skipped} skipped (duplicates)`);
console.log(`Total archival: ${existingContent.size} records`);
