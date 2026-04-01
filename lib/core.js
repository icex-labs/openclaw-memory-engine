/**
 * Core memory: small structured identity block (~500 tokens).
 * Stored as memory/core.json. Agent reads at session start, updates atomically.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { corePath } from "./paths.js";

const DEFAULT_CORE = {
  _meta: { version: 1, updated_at: "", description: "Core memory block." },
  user: {},
  relationship: {},
  preferences: {},
  current_focus: [],
};

export function readCore(ws) {
  const p = corePath(ws);
  if (!existsSync(p)) {
    mkdirSync(join(ws, "memory"), { recursive: true });
    const init = {
      ...DEFAULT_CORE,
      _meta: { ...DEFAULT_CORE._meta, updated_at: new Date().toISOString() },
    };
    writeFileSync(p, JSON.stringify(init, null, 2), "utf-8");
    return init;
  }
  return JSON.parse(readFileSync(p, "utf-8"));
}

export function writeCore(ws, data) {
  data._meta = data._meta || {};
  data._meta.updated_at = new Date().toISOString();
  writeFileSync(corePath(ws), JSON.stringify(data, null, 2), "utf-8");
}

/** Navigate a dot-path to read a value. */
export function dotGet(obj, path) {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Navigate a dot-path to set a value. Returns old value. */
export function dotSet(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === undefined) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  const old = cur[parts[parts.length - 1]];
  cur[parts[parts.length - 1]] = value;
  return old;
}

/**
 * Auto-parse: if value is a JSON string that looks like an array/object, parse it.
 * Fixes LLMs passing '["a","b"]' as a string instead of an actual array.
 */
export function autoParse(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
  ) {
    try { return JSON.parse(trimmed); } catch { /* keep as string */ }
  }
  return value;
}
