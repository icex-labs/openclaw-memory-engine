/**
 * Auto-capture: hook into message:received and message:sent events
 * to automatically extract and store facts in archival memory.
 *
 * No reliance on the agent calling tools — memory happens passively.
 */

import { appendRecord } from "./archival.js";
import { indexEmbedding } from "./embedding.js";
import { extractTriples, addTriple } from "./graph.js";
import { resolveWorkspace } from "./paths.js";

// Minimum message length to consider for fact extraction
const MIN_LENGTH = 20;

// Skip patterns — don't store these as facts
const SKIP_PATTERNS = [
  /^(hi|hello|hey|ok|thanks|good morning|good night|早|晚安|你好|嗯|好的|谢谢)/i,
  /^HEARTBEAT_OK$/,
  /^\//,  // slash commands
  /^(yes|no|yeah|nah|sure|maybe)$/i,
];

// High-value content patterns — always store these
const HIGH_VALUE_PATTERNS = [
  /\b(decided|decision|plan|scheduled|booked|bought|sold|paid|签|买|卖|预约|决定)\b/i,
  /\b(doctor|lawyer|immigration|IRCC|IBKR|account|password|address|phone|email)\b/i,
  /\b(remember|don't forget|提醒|记住|别忘)\b/i,
  /\$\d{2,}/,  // dollar amounts
  /\b\d{4}-\d{2}-\d{2}\b/,  // dates
];

// Entity inference (same as quality.js but lightweight)
const ENTITY_PATTERNS = [
  [/\b(IBKR|invest|portfolio|HELOC|mortgage|bank|\$\d{3,})/i, "finance"],
  [/\b(immigration|PR|IRCC|CBSA|visa|lawyer|律师)/i, "immigration"],
  [/\b(doctor|医生|hospital|health|medication|药)/i, "health"],
  [/\b(car|vehicle|Escalade|GX550|ES350|Tesla|tire|车)/i, "vehicles"],
  [/\b(school|homework|exam|swimming|lesson|学校|课)/i, "education"],
  [/\b(deploy|k3d|ArgoCD|kubectl|CI|cluster)/i, "infrastructure"],
  [/\b(quant|trading|backtest|signal|strategy)/i, "quant"],
];

function inferEntity(text) {
  for (const [pat, name] of ENTITY_PATTERNS) {
    if (pat.test(text)) return name;
  }
  return "conversation";
}

function shouldCapture(content) {
  if (!content || content.length < MIN_LENGTH) return false;
  if (SKIP_PATTERNS.some((p) => p.test(content.trim()))) return false;
  return true;
}

function isHighValue(content) {
  return HIGH_VALUE_PATTERNS.some((p) => p.test(content));
}

/**
 * Process an incoming or outgoing message and auto-store if valuable.
 */
export function captureMessage(ws, content, source = "auto-capture") {
  if (!shouldCapture(content)) return null;

  const importance = isHighValue(content) ? 7 : 4;
  const entity = inferEntity(content);

  // Trim very long messages to first 500 chars
  const trimmed = content.length > 500 ? content.slice(0, 497) + "..." : content;

  const record = appendRecord(ws, {
    content: trimmed,
    entity,
    tags: [source],
    importance,
  });

  // Background: index embedding + extract graph triples
  indexEmbedding(ws, record).catch(() => {});

  const triples = extractTriples(trimmed);
  for (const t of triples) {
    addTriple(ws, t.s, t.r, t.o, record.id);
  }

  return record;
}
