/**
 * Reflective memory: statistical analysis over recent archival + episodes
 * to surface behavioral patterns, topic trends, and emotional shifts.
 *
 * This module does data analysis only — pattern interpretation is left
 * to the agent (which has LLM reasoning the plugin doesn't).
 */

import { loadArchival } from "./archival.js";
import { loadEpisodes } from "./episodes.js";
import { loadGraph } from "./graph.js";

/**
 * Analyze recent memory for patterns and trends.
 * @param {string} ws - workspace path
 * @param {number} [windowDays=7] - analysis window in days
 * @returns {object} structured analysis
 */
export function analyzePatterns(ws, windowDays = 7) {
  const allRecords = loadArchival(ws);
  const allEpisodes = loadEpisodes(ws);
  const graph = loadGraph(ws);

  const cutoff = Date.now() - windowDays * 86400000;

  const recentRecords = allRecords.filter(
    (r) => r.ts && new Date(r.ts).getTime() > cutoff,
  );
  const recentEpisodes = allEpisodes.filter(
    (e) => e.ts && new Date(e.ts).getTime() > cutoff,
  );

  // ─── 1. Topic frequency ───
  const topicCounts = {};
  for (const r of recentRecords) {
    for (const tag of r.tags || []) {
      topicCounts[tag] = (topicCounts[tag] || 0) + 1;
    }
    if (r.entity) {
      topicCounts[`entity:${r.entity}`] = (topicCounts[`entity:${r.entity}`] || 0) + 1;
    }
  }
  for (const ep of recentEpisodes) {
    for (const topic of ep.topics || []) {
      topicCounts[`episode:${topic}`] = (topicCounts[`episode:${topic}`] || 0) + 1;
    }
  }
  const topTopics = Object.entries(topicCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // ─── 2. Time-of-day distribution ───
  const hourBuckets = { morning: 0, afternoon: 0, evening: 0, night: 0 };
  for (const r of recentRecords) {
    if (!r.ts) continue;
    const hour = new Date(r.ts).getHours();
    if (hour >= 6 && hour < 12) hourBuckets.morning++;
    else if (hour >= 12 && hour < 18) hourBuckets.afternoon++;
    else if (hour >= 18 && hour < 23) hourBuckets.evening++;
    else hourBuckets.night++;
  }

  // ─── 3. Mood trend (from episodes) ───
  const moodCounts = {};
  for (const ep of recentEpisodes) {
    if (ep.mood) {
      moodCounts[ep.mood] = (moodCounts[ep.mood] || 0) + 1;
    }
  }

  // ─── 4. Importance distribution ───
  const importanceHigh = recentRecords.filter((r) => (r.importance || 5) >= 7).length;
  const importanceLow = recentRecords.filter((r) => (r.importance || 5) <= 3).length;
  const importanceMid = recentRecords.length - importanceHigh - importanceLow;

  // ─── 5. Decision velocity (from episodes) ───
  const totalDecisions = recentEpisodes.reduce(
    (sum, ep) => sum + (ep.decisions?.length || 0), 0,
  );

  // ─── 6. Graph growth ───
  const recentTriples = graph.filter(
    (t) => t.ts && new Date(t.ts).getTime() > cutoff,
  );

  // ─── 7. Neglected entities (in graph but not accessed recently) ───
  const graphEntities = new Set();
  for (const t of graph) {
    graphEntities.add(t.s);
    graphEntities.add(t.o);
  }
  const recentEntities = new Set();
  for (const r of recentRecords) {
    if (r.entity) recentEntities.add(r.entity);
  }
  const neglected = [...graphEntities].filter((e) => !recentEntities.has(e));

  // ─── 8. Forgetting candidates ───
  const forgettingCandidates = allRecords.filter((r) => {
    const importance = r.importance || 5;
    const daysSinceAccess = r.last_accessed
      ? (Date.now() - new Date(r.last_accessed).getTime()) / 86400000
      : (Date.now() - new Date(r.ts || Date.now()).getTime()) / 86400000;
    const effective = importance * Math.exp(-0.01 * daysSinceAccess);
    return effective < 1.0;
  });

  return {
    window_days: windowDays,
    period: {
      from: new Date(cutoff).toISOString().slice(0, 10),
      to: new Date().toISOString().slice(0, 10),
    },
    activity: {
      new_facts: recentRecords.length,
      new_episodes: recentEpisodes.length,
      new_graph_triples: recentTriples.length,
      total_decisions: totalDecisions,
    },
    top_topics: topTopics,
    time_distribution: hourBuckets,
    mood_trend: moodCounts,
    importance_distribution: {
      high: importanceHigh,
      medium: importanceMid,
      low: importanceLow,
    },
    health: {
      total_archival: allRecords.length,
      total_episodes: allEpisodes.length,
      total_graph: graph.length,
      neglected_entities: neglected.slice(0, 10),
      forgetting_candidates: forgettingCandidates.length,
    },
  };
}

/**
 * Format analysis into a human-readable report for the agent.
 */
export function formatReflection(analysis) {
  const lines = [
    `📊 Memory Reflection (${analysis.period.from} → ${analysis.period.to}, ${analysis.window_days}d window)`,
    ``,
    `Activity:`,
    `  New facts: ${analysis.activity.new_facts}`,
    `  New episodes: ${analysis.activity.new_episodes}`,
    `  New graph relations: ${analysis.activity.new_graph_triples}`,
    `  Decisions made: ${analysis.activity.total_decisions}`,
  ];

  if (analysis.top_topics.length > 0) {
    lines.push(``, `Top topics:`);
    for (const [topic, count] of analysis.top_topics) {
      lines.push(`  ${topic}: ${count}`);
    }
  }

  const td = analysis.time_distribution;
  const peakTime = Object.entries(td).sort((a, b) => b[1] - a[1])[0];
  if (peakTime && peakTime[1] > 0) {
    lines.push(``, `Time pattern: most active during ${peakTime[0]} (${peakTime[1]} events)`);
    lines.push(`  morning=${td.morning} afternoon=${td.afternoon} evening=${td.evening} night=${td.night}`);
  }

  if (Object.keys(analysis.mood_trend).length > 0) {
    lines.push(``, `Mood trend:`);
    for (const [mood, count] of Object.entries(analysis.mood_trend)) {
      lines.push(`  ${mood}: ${count}`);
    }
  }

  const imp = analysis.importance_distribution;
  lines.push(``, `Importance: high(≥7)=${imp.high} medium=${imp.medium} low(≤3)=${imp.low}`);

  if (analysis.health.neglected_entities.length > 0) {
    lines.push(``, `Neglected entities (in graph but no recent activity):`);
    lines.push(`  ${analysis.health.neglected_entities.join(", ")}`);
  }

  if (analysis.health.forgetting_candidates > 0) {
    lines.push(``, `⚠️ ${analysis.health.forgetting_candidates} facts below forgetting threshold — consider archival_deduplicate or cleanup`);
  }

  lines.push(``, `Totals: ${analysis.health.total_archival} facts, ${analysis.health.total_episodes} episodes, ${analysis.health.total_graph} graph triples`);

  return lines.join("\n");
}
