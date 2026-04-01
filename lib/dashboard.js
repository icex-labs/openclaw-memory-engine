/**
 * Dashboard: generates a self-contained HTML file for browsing memory.
 * Timeline view, graph visualization, search explorer, stats.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readCore } from "./core.js";
import { loadArchival } from "./archival.js";
import { loadGraph } from "./graph.js";
import { loadEpisodes } from "./episodes.js";
import { loadEmbeddingCache } from "./embedding.js";
import { analyzePatterns } from "./reflection.js";

/**
 * Generate a self-contained HTML dashboard file.
 * @returns {string} output path
 */
export function generateDashboard(ws, outputPath = null) {
  const outPath = outputPath || join(ws, "memory", "dashboard.html");

  const core = readCore(ws);
  const archival = loadArchival(ws);
  const graph = loadGraph(ws);
  const episodes = loadEpisodes(ws);
  const embCache = loadEmbeddingCache(ws);
  const reflection = analyzePatterns(ws, 30);

  const embCount = Object.keys(embCache).length;

  // Build data for the HTML
  const data = {
    generatedAt: new Date().toISOString(),
    core,
    stats: {
      archival: archival.length,
      graph: graph.length,
      episodes: episodes.length,
      embeddings: embCount,
    },
    reflection,
    // Limit data size for HTML
    recentArchival: archival.slice(-50).reverse(),
    recentEpisodes: episodes.slice(-20).reverse(),
    graphTriples: graph.slice(-100),
    entities: [...new Set([
      ...archival.map((r) => r.entity).filter(Boolean),
      ...graph.map((t) => t.s),
      ...graph.map((t) => t.o),
    ])].sort(),
  };

  const html = renderHtml(data);
  writeFileSync(outPath, html, "utf-8");
  return outPath;
}

function renderHtml(data) {
  const coreJson = JSON.stringify(data.core, null, 2);
  const archivalJson = JSON.stringify(data.recentArchival);
  const episodesJson = JSON.stringify(data.recentEpisodes);
  const graphJson = JSON.stringify(data.graphTriples);
  const reflectionJson = JSON.stringify(data.reflection);
  const entitiesJson = JSON.stringify(data.entities);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Memory Engine Dashboard</title>
<style>
  :root { --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #c9d1d9; --accent: #58a6ff; --green: #3fb950; --yellow: #d29922; --red: #f85149; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); padding: 20px; max-width: 1200px; margin: 0 auto; }
  h1 { color: var(--accent); margin-bottom: 8px; font-size: 24px; }
  h2 { color: var(--accent); margin: 24px 0 12px; font-size: 18px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
  h3 { color: var(--text); margin: 16px 0 8px; font-size: 15px; }
  .subtitle { color: #8b949e; font-size: 13px; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; text-align: center; }
  .stat-num { font-size: 28px; font-weight: 700; color: var(--accent); }
  .stat-label { font-size: 12px; color: #8b949e; margin-top: 4px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 12px; }
  .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .card-date { color: #8b949e; font-size: 12px; }
  .card-entity { background: var(--accent); color: #000; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .card-content { font-size: 14px; line-height: 1.5; }
  .tag { display: inline-block; background: #21262d; border: 1px solid var(--border); color: #8b949e; padding: 1px 6px; border-radius: 4px; font-size: 11px; margin: 2px; }
  .importance { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .importance.high { background: var(--red); }
  .importance.mid { background: var(--yellow); }
  .importance.low { background: var(--green); }
  .triple { font-family: monospace; font-size: 13px; padding: 6px 0; border-bottom: 1px solid var(--border); }
  .triple:last-child { border-bottom: none; }
  .episode { border-left: 3px solid var(--accent); padding-left: 12px; margin-bottom: 16px; }
  .episode-mood { color: var(--yellow); font-size: 12px; }
  .episode-decisions { color: var(--green); font-size: 13px; margin-top: 4px; }
  pre { background: #0d1117; border: 1px solid var(--border); border-radius: 6px; padding: 12px; overflow-x: auto; font-size: 12px; color: var(--green); }
  .tabs { display: flex; gap: 0; margin-bottom: 0; border-bottom: 1px solid var(--border); }
  .tab { padding: 8px 16px; cursor: pointer; color: #8b949e; border-bottom: 2px solid transparent; font-size: 14px; }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .tab-content { display: none; padding-top: 16px; }
  .tab-content.active { display: block; }
  .search-box { width: 100%; padding: 8px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 14px; margin-bottom: 12px; }
  .bar { display: inline-block; height: 16px; background: var(--accent); border-radius: 2px; margin-right: 4px; vertical-align: middle; }
</style>
</head>
<body>

<h1>Memory Engine Dashboard</h1>
<div class="subtitle">Generated: ${data.generatedAt.slice(0, 19).replace("T", " ")} UTC</div>

<div class="grid">
  <div class="stat-card"><div class="stat-num">${data.stats.archival}</div><div class="stat-label">Facts</div></div>
  <div class="stat-card"><div class="stat-num">${data.stats.graph}</div><div class="stat-label">Graph Triples</div></div>
  <div class="stat-card"><div class="stat-num">${data.stats.episodes}</div><div class="stat-label">Episodes</div></div>
  <div class="stat-card"><div class="stat-num">${data.stats.embeddings}</div><div class="stat-label">Embeddings</div></div>
</div>

<div class="tabs">
  <div class="tab active" onclick="switchTab('facts')">Facts</div>
  <div class="tab" onclick="switchTab('graph')">Graph</div>
  <div class="tab" onclick="switchTab('episodes')">Episodes</div>
  <div class="tab" onclick="switchTab('core')">Core Memory</div>
  <div class="tab" onclick="switchTab('reflection')">Reflection</div>
</div>

<div id="tab-facts" class="tab-content active">
  <input class="search-box" id="fact-search" placeholder="Search facts..." oninput="filterFacts()">
  <div id="fact-list"></div>
</div>

<div id="tab-graph" class="tab-content">
  <h3>Knowledge Graph (${data.stats.graph} triples)</h3>
  <div id="graph-list"></div>
</div>

<div id="tab-episodes" class="tab-content">
  <h3>Conversation Episodes (${data.stats.episodes})</h3>
  <div id="episode-list"></div>
</div>

<div id="tab-core" class="tab-content">
  <h3>Core Memory Block</h3>
  <pre>${escapeHtml(coreJson)}</pre>
</div>

<div id="tab-reflection" class="tab-content">
  <h3>30-Day Reflection</h3>
  <div id="reflection-content"></div>
</div>

<script>
const archival = ${archivalJson};
const episodes = ${episodesJson};
const graph = ${graphJson};
const reflection = ${reflectionJson};
const coreJson = ${JSON.stringify(coreJson)};

function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
}

function impClass(v) { return v >= 7 ? 'high' : v <= 3 ? 'low' : 'mid'; }

function renderFacts(facts) {
  return facts.map(r => \`
    <div class="card">
      <div class="card-header">
        <span><span class="importance \${impClass(r.importance||5)}"></span>\${r.entity ? '<span class="card-entity">'+r.entity+'</span>' : ''}</span>
        <span class="card-date">\${(r.ts||'').slice(0,10)} · imp=\${r.importance||5} · accessed=\${r.access_count||0}</span>
      </div>
      <div class="card-content">\${escapeHtml(r.content)}</div>
      <div>\${(r.tags||[]).map(t => '<span class="tag">#'+t+'</span>').join('')}</div>
    </div>
  \`).join('');
}

function filterFacts() {
  const q = document.getElementById('fact-search').value.toLowerCase();
  const filtered = q ? archival.filter(r =>
    (r.content||'').toLowerCase().includes(q) ||
    (r.entity||'').toLowerCase().includes(q) ||
    (r.tags||[]).some(t => t.toLowerCase().includes(q))
  ) : archival;
  document.getElementById('fact-list').innerHTML = renderFacts(filtered);
}

// Init facts
document.getElementById('fact-list').innerHTML = renderFacts(archival);

// Init graph
document.getElementById('graph-list').innerHTML = graph.map(t =>
  '<div class="triple">(' + escapeHtml(t.s) + ') <span style="color:var(--accent)">—' + escapeHtml(t.r) + '→</span> (' + escapeHtml(t.o) + ')</div>'
).join('') || '<p style="color:#8b949e">No graph triples yet.</p>';

// Init episodes
document.getElementById('episode-list').innerHTML = episodes.map(ep => \`
  <div class="episode">
    <div class="card-date">\${(ep.ts||'').slice(0,10)} \${ep.mood ? '<span class="episode-mood">[\${ep.mood}]</span>' : ''}</div>
    <div class="card-content" style="margin:4px 0">\${escapeHtml(ep.summary||'')}</div>
    \${(ep.decisions||[]).length ? '<div class="episode-decisions">Decisions: '+(ep.decisions||[]).join('; ')+'</div>' : ''}
    <div>\${(ep.topics||[]).map(t => '<span class="tag">'+t+'</span>').join('')}</div>
  </div>
\`).join('') || '<p style="color:#8b949e">No episodes yet.</p>';

// Init reflection
const ref = reflection;
const topTopics = (ref.top_topics||[]).map(([t,c]) => '<div>'+t+': <span class="bar" style="width:'+Math.min(c*20,200)+'px"></span> '+c+'</div>').join('');
document.getElementById('reflection-content').innerHTML = \`
  <div class="grid">
    <div class="stat-card"><div class="stat-num">\${ref.activity?.new_facts||0}</div><div class="stat-label">New Facts (30d)</div></div>
    <div class="stat-card"><div class="stat-num">\${ref.activity?.new_episodes||0}</div><div class="stat-label">New Episodes</div></div>
    <div class="stat-card"><div class="stat-num">\${ref.activity?.total_decisions||0}</div><div class="stat-label">Decisions</div></div>
    <div class="stat-card"><div class="stat-num">\${ref.health?.forgetting_candidates||0}</div><div class="stat-label">Forgetting Candidates</div></div>
  </div>
  <h3>Top Topics</h3>\${topTopics||'<p style="color:#8b949e">No data</p>'}
  <h3>Time Distribution</h3>
  <div>Morning: \${ref.time_distribution?.morning||0} · Afternoon: \${ref.time_distribution?.afternoon||0} · Evening: \${ref.time_distribution?.evening||0} · Night: \${ref.time_distribution?.night||0}</div>
  \${ref.health?.neglected_entities?.length ? '<h3>Neglected Entities</h3><div>'+(ref.health.neglected_entities||[]).join(', ')+'</div>' : ''}
\`;
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
