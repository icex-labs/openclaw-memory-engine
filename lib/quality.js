/**
 * Data quality engine: re-classify entities, re-rate importance,
 * extract missing graph triples, generate episodes from summaries.
 */

import { loadArchival, rewriteArchival } from "./archival.js";
import { addTriple, extractTriples, loadGraph } from "./graph.js";
import { saveEpisode, loadEpisodes } from "./episodes.js";

// ═══════════════════════════════════════════════════════════════════
// Extended entity patterns (much richer than consolidate.js)
// ═══════════════════════════════════════════════════════════════════

const ENTITY_PATTERNS = [
  // People / family
  [/\b(wife|husband|spouse|老婆|老公|太太|丈夫|妻子)\b/i, "family"],
  [/\b(son|daughter|child|kid|儿子|女儿|孩子)\b/i, "family"],
  [/\b(mom|dad|mother|father|parent|妈|爸|父母)\b/i, "family"],

  // Finance
  [/\b(IBKR|Interactive Brokers|broker|brokerage)\b/i, "finance"],
  [/\b(TFSA|RRSP|RESP|401k|IRA|pension)\b/i, "finance"],
  [/\b(invest|portfolio|NAV|stock|ETF|QQQ|VOO|dividend)\b/i, "finance"],
  [/\b(HELOC|mortgage|loan|credit|debt|利率|rate)\b/i, "finance"],
  [/\b(bank|RBC|TD|BMO|Scotiabank|CIBC)\b/i, "finance"],
  [/\b(budget|expense|income|salary|payment|pay|报税|tax)\b/i, "finance"],
  [/\b(accountant|bookkeep|会计)\b/i, "finance"],
  [/\b(\$\d|CAD|USD|万|千)\b/i, "finance"],

  // Immigration / legal
  [/\b(immigration|immigrant|PR|permanent resident|移民)\b/i, "immigration"],
  [/\b(IRCC|CBSA|ATIP|NSIRA|Mandamus|IMM-)\b/i, "immigration"],
  [/\b(visa|work permit|签证|工签)\b/i, "immigration"],
  [/\b(lawyer|attorney|paralegal|律师|法律)\b/i, "legal"],
  [/\b(petition|complaint|CHRC|tribunal|court|案)\b/i, "legal"],

  // Health
  [/\b(doctor|physician|GP|医生|主治|Dr\.)\b/i, "health"],
  [/\b(hospital|clinic|medical|诊所|医院)\b/i, "health"],
  [/\b(medication|medicine|drug|pill|tablet|药|处方)\b/i, "health"],
  [/\b(cetirizine|urticaria|荨麻疹|allergy|过敏)\b/i, "health"],
  [/\b(health|symptom|diagnosis|体检|检查|screening)\b/i, "health"],
  [/\b(dental|dentist|vision|eye|牙|眼)\b/i, "health"],

  // Vehicles
  [/\b(car|vehicle|SUV|sedan|truck|van|minivan|车)\b/i, "vehicles"],
  [/\b(Tesla|Toyota|Lexus|BMW|Mercedes|Cadillac|Honda|Audi)\b/i, "vehicles"],
  [/\b(Escalade|GX550|ES350|Sienna|Model [3SXY])\b/i, "vehicles"],
  [/\b(tire|tyre|PPF|wrap|oil change|maintenance|保养|轮胎)\b/i, "vehicles"],
  [/\b(insurance|保险|Desjardins|policy)\b/i, "vehicles"],

  // Infrastructure / DevOps
  [/\b(k3d|k3s|k8s|kubernetes|cluster|pod|deploy)\b/i, "infrastructure"],
  [/\b(ArgoCD|Helm|kubectl|GitOps|CI|CD|pipeline)\b/i, "infrastructure"],
  [/\b(Docker|container|image|registry|GHCR)\b/i, "infrastructure"],
  [/\b(U9|prod|production|staging|dev cluster)\b/i, "infrastructure"],
  [/\b(SOPS|secret|encrypt|cert|SSL|TLS)\b/i, "infrastructure"],

  // OpenClaw / AI
  [/\b(OpenClaw|openclaw|gateway|plugin|hook)\b/i, "openclaw"],
  [/\b(agent|session|compaction|memory|embedding)\b/i, "openclaw"],
  [/\b(LLM|Claude|Anthropic|GPT|OpenAI|AI|token)\b/i, "ai"],
  [/\b(prompt|context window|model|inference)\b/i, "ai"],

  // Quant / trading
  [/\b(quant|quantitative|backtest|backtesting)\b/i, "quant"],
  [/\b(trading|trade|signal|strategy|turtle|海龟)\b/i, "quant"],
  [/\b(Sharpe|drawdown|回撤|年化|annualized)\b/i, "quant"],
  [/\b(paper trading|live trading|order|position)\b/i, "quant"],

  // Messaging
  [/\b(Telegram|Discord|WhatsApp|Slack|bot|channel)\b/i, "messaging"],

  // Property / home
  [/\b(house|home|condo|apartment|property|房|租)\b/i, "property"],
  [/\b(NAS|Synology|backup|Time Machine)\b/i, "property"],
  [/\b(lawn|garden|yard|snow|草坪|铲雪)\b/i, "property"],

  // Education / kids
  [/\b(school|class|homework|exam|test|学校|作业)\b/i, "education"],
  [/\b(kindergarten|grade|teacher|老师)\b/i, "education"],
  [/\b(swimming|skating|skiing|hockey|lesson|课)\b/i, "education"],
  [/\b(Science Fair|concert|recital|表演)\b/i, "education"],

  // Projects / SaaS
  [/\b(icex|SaaS|MVP|startup|product|launch)\b/i, "project"],
  [/\b(ESP32|Arduino|IoT|hardware|sensor)\b/i, "project"],

  // Shopping / daily
  [/\b(Costco|Amazon|Walmart|shopping|购物|买)\b/i, "shopping"],
  [/\b(flight|airline|Air Canada|travel|trip|机票|飞)\b/i, "travel"],
  [/\b(restaurant|food|meal|dinner|lunch|吃|饭)\b/i, "daily"],
];

// ═══════════════════════════════════════════════════════════════════
// Importance rules
// ═══════════════════════════════════════════════════════════════════

const IMPORTANCE_RULES = [
  // High (8-9): critical life matters
  { match: /\b(immigration|PR|IRCC|CBSA|Mandamus|visa|NSIRA|CHRC|petition|lawsuit|court)\b/i, importance: 9 },
  { match: /\b(IBKR|NAV|portfolio|invest|\$\d{4,}|万|HELOC|mortgage)\b/i, importance: 8 },
  { match: /\b(doctor|hospital|medication|diagnosis|surgery|health insurance|AHCIP)\b/i, importance: 8 },
  { match: /\b(lawyer|attorney|legal|律师)\b/i, importance: 8 },
  { match: /\b(永远不要|NEVER|CRITICAL|严禁|必须|MUST)\b/i, importance: 9 },
  { match: /\b(VIN|policy number|case number|account number|IMM-)\b/i, importance: 8 },

  // Medium-high (7): important but not critical
  { match: /\b(ArgoCD|GitOps|k3d|U9|prod|deploy|CI)\b/i, importance: 6 },
  { match: /\b(quant|backtest|trading|signal|Sharpe)\b/i, importance: 7 },
  { match: /\b(GX550|Escalade|ES350|car insurance)\b/i, importance: 6 },
  { match: /\b(OpenClaw|gateway|plugin|config)\b/i, importance: 6 },
  { match: /\b(icex|SaaS|MVP|ESP32)\b/i, importance: 6 },

  // Low (3): ephemeral
  { match: /\b(swimming lesson|concert|recital|playdate)\b/i, importance: 3 },
  { match: /\b(weather|天气)\b/i, importance: 2 },
  { match: /\b(heartbeat|HEARTBEAT_OK|session start|daily log)\b/i, importance: 2 },
  { match: /\b(good morning|good night|早上好|晚安)\b/i, importance: 2 },
];

function inferImportance(content, currentImportance) {
  // Only re-rate if currently at default (5)
  if (currentImportance !== 5) return currentImportance;

  for (const rule of IMPORTANCE_RULES) {
    if (rule.match.test(content)) return rule.importance;
  }
  return 5; // keep default if no rule matches
}

function inferEntity(content, currentEntity) {
  // Only re-classify if currently "general" or empty
  if (currentEntity && currentEntity !== "general") return currentEntity;

  for (const [pattern, entity] of ENTITY_PATTERNS) {
    if (pattern.test(content)) return entity;
  }
  return currentEntity || "general";
}

// ═══════════════════════════════════════════════════════════════════
// Quality pass
// ═══════════════════════════════════════════════════════════════════

/**
 * Run a full quality pass over archival records.
 * @returns {{ reclassified, rerated, triplesAdded, episodesGenerated }}
 */
export function runQualityPass(ws, options = {}) {
  const records = loadArchival(ws);
  const existingGraph = loadGraph(ws);
  const existingTripleSet = new Set(
    existingGraph.map((t) => `${t.s}|${t.r}|${t.o}`.toLowerCase()),
  );

  let reclassified = 0;
  let rerated = 0;
  let triplesAdded = 0;

  for (const record of records) {
    // 1. Re-classify entity
    const newEntity = inferEntity(record.content, record.entity);
    if (newEntity !== record.entity) {
      record.entity = newEntity;
      reclassified++;
    }

    // 2. Re-rate importance
    const newImportance = inferImportance(record.content, record.importance ?? 5);
    if (newImportance !== (record.importance ?? 5)) {
      record.importance = newImportance;
      rerated++;
    }

    // 3. Extract graph triples
    if (!options.skipGraph) {
      const triples = extractTriples(record.content);
      for (const t of triples) {
        const key = `${t.s}|${t.r}|${t.o}`.toLowerCase();
        if (!existingTripleSet.has(key)) {
          const added = addTriple(ws, t.s, t.r, t.o, record.id);
          if (added) {
            existingTripleSet.add(key);
            triplesAdded++;
          }
        }
      }
    }
  }

  // Save updated records
  if (reclassified > 0 || rerated > 0) {
    rewriteArchival(ws, records);
  }

  // 4. Generate episodes from weekly summaries (if episodes are sparse)
  let episodesGenerated = 0;
  if (!options.skipEpisodes) {
    episodesGenerated = generateEpisodesFromRecords(ws, records);
  }

  return { reclassified, rerated, triplesAdded, episodesGenerated, total: records.length };
}

/**
 * Generate episode summaries from clusters of records on the same day.
 */
function generateEpisodesFromRecords(ws, records) {
  const episodes = loadEpisodes(ws);
  const existingDates = new Set(episodes.map((e) => e.ts?.slice(0, 10)));

  // Group records by date
  const byDate = {};
  for (const r of records) {
    if (!r.ts) continue;
    const date = r.ts.slice(0, 10);
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(r);
  }

  let generated = 0;
  for (const [date, dayRecords] of Object.entries(byDate)) {
    // Skip if episode already exists for this date, or too few records
    if (existingDates.has(date) || dayRecords.length < 3) continue;

    // Aggregate topics and entities
    const topics = [...new Set(dayRecords.map((r) => r.entity).filter((e) => e && e !== "general"))];
    const topContent = dayRecords
      .sort((a, b) => (b.importance || 5) - (a.importance || 5))
      .slice(0, 5)
      .map((r) => r.content.slice(0, 80))
      .join("; ");

    saveEpisode(ws, {
      summary: `${date}: ${topContent}`,
      decisions: [],
      mood: "",
      topics: topics.slice(0, 5),
      participants: [],
      source: "quality-pass",
    });
    generated++;
  }

  return generated;
}

/**
 * Format quality pass results into a report.
 */
export function formatQualityReport(result) {
  const lines = [
    `📊 Memory Quality Pass Complete`,
    ``,
    `  Records scanned: ${result.total}`,
    `  Entities re-classified: ${result.reclassified}`,
    `  Importance re-rated: ${result.rerated}`,
    `  Graph triples extracted: ${result.triplesAdded}`,
    `  Episodes generated: ${result.episodesGenerated}`,
  ];

  if (result.reclassified === 0 && result.rerated === 0 && result.triplesAdded === 0 && result.episodesGenerated === 0) {
    lines.push(``, `  All data is already high quality. Nothing to fix.`);
  }

  return lines.join("\n");
}
