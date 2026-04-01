#!/bin/bash
# setup.sh — One-command setup for openclaw-memory-engine
# Usage: bash setup.sh [workspace_path]
#
# What it does:
#   1. Enables the plugin in openclaw.json
#   2. Creates memory/core.json template (if not exists)
#   3. Installs memory-maintenance.sh + LaunchAgent (macOS)
#   4. Patches AGENTS.md with memory tool instructions (if not already patched)
#   5. Validates config

set -euo pipefail

WORKSPACE="${1:-${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}}"
OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"
CONFIG="$OPENCLAW_DIR/openclaw.json"
MEMORY_DIR="$WORKSPACE/memory"
AGENTS_MD="$WORKSPACE/AGENTS.md"
PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🧠 openclaw-memory-engine setup"
echo "   Workspace: $WORKSPACE"
echo "   Config:    $CONFIG"
echo ""

# --- 1. Create memory directory ---
mkdir -p "$MEMORY_DIR"
echo "✅ memory/ directory ready"

# --- 2. Create core.json template (if not exists) ---
if [ ! -f "$MEMORY_DIR/core.json" ]; then
  cat > "$MEMORY_DIR/core.json" <<'CORE'
{
  "_meta": {
    "version": 1,
    "updated_at": "PLACEHOLDER",
    "description": "Core memory block — always in context. Keep under 500 tokens."
  },
  "user": {
    "name": "",
    "location": "",
    "language": "",
    "job": ""
  },
  "relationship": {
    "dynamic": "",
    "trust": "",
    "boundaries": ""
  },
  "preferences": {},
  "current_focus": []
}
CORE
  # Replace placeholder with current time
  if command -v python3 &>/dev/null; then
    python3 -c "
import json, datetime
with open('$MEMORY_DIR/core.json') as f: d = json.load(f)
d['_meta']['updated_at'] = datetime.datetime.utcnow().isoformat() + 'Z'
with open('$MEMORY_DIR/core.json', 'w') as f: json.dump(d, f, indent=2)
"
  fi
  echo "✅ core.json template created — edit it with your info!"
else
  echo "⏭️  core.json already exists, skipping"
fi

# --- 3. Create empty archival.jsonl (if not exists) ---
if [ ! -f "$MEMORY_DIR/archival.jsonl" ]; then
  touch "$MEMORY_DIR/archival.jsonl"
  echo "✅ archival.jsonl created"
else
  lines=$(wc -l < "$MEMORY_DIR/archival.jsonl" | tr -d ' ')
  echo "⏭️  archival.jsonl already exists ($lines records)"
fi

# --- 4. Install memory-maintenance.sh ---
SCRIPTS_DIR="$WORKSPACE/scripts"
mkdir -p "$SCRIPTS_DIR"
if [ ! -f "$SCRIPTS_DIR/memory-maintenance.sh" ]; then
  cp "$PLUGIN_DIR/extras/memory-maintenance.sh" "$SCRIPTS_DIR/memory-maintenance.sh" 2>/dev/null || {
    echo "⚠️  memory-maintenance.sh not found in extras/. Copy it manually from the repo."
  }
  chmod +x "$SCRIPTS_DIR/memory-maintenance.sh" 2>/dev/null
  echo "✅ memory-maintenance.sh installed"
else
  echo "⏭️  memory-maintenance.sh already exists"
fi

# --- 5. Install LaunchAgent (macOS only) ---
if [ "$(uname)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/ai.openclaw.memory-maintenance.plist"
  if [ ! -f "$PLIST" ]; then
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.openclaw.memory-maintenance</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$SCRIPTS_DIR/memory-maintenance.sh</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>3</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/memory-maintenance.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/memory-maintenance.log</string>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
PLIST
    launchctl bootstrap gui/$(id -u) "$PLIST" 2>/dev/null || true
    echo "✅ LaunchAgent installed (daily 3am maintenance)"
  else
    echo "⏭️  LaunchAgent already exists"
  fi
fi

# --- 6. Patch openclaw.json (add plugin config if missing) ---
if command -v python3 &>/dev/null && [ -f "$CONFIG" ]; then
  python3 <<PYEOF
import json

with open("$CONFIG") as f:
    cfg = json.load(f)

changed = False

# Ensure plugins.allow includes memory-engine
allow = cfg.setdefault("plugins", {}).setdefault("allow", [])
if "memory-engine" not in allow:
    allow.append("memory-engine")
    changed = True

# Ensure plugins.entries.memory-engine exists
entries = cfg["plugins"].setdefault("entries", {})
if "memory-engine" not in entries:
    entries["memory-engine"] = {
        "enabled": True,
        "config": {"workspace": "$WORKSPACE"}
    }
    changed = True

if changed:
    with open("$CONFIG", "w") as f:
        json.dump(cfg, f, indent=2)
    print("✅ openclaw.json updated with memory-engine plugin config")
else:
    print("⏭️  openclaw.json already has memory-engine config")
PYEOF
else
  echo "⚠️  Could not patch openclaw.json automatically. Add manually:"
  echo '  "plugins": { "allow": ["memory-engine"], "entries": { "memory-engine": { "enabled": true } } }'
fi

# --- 7. Patch AGENTS.md (add memory instructions if missing) ---
if [ -f "$AGENTS_MD" ]; then
  if ! grep -q "core_memory_read" "$AGENTS_MD"; then
    cat >> "$AGENTS_MD" <<'PATCH'

## Memory System — MemGPT Architecture

You have 4 memory tools. **Use them actively.**

### Core Memory (`core_memory_read` / `core_memory_replace`)
- Call `core_memory_read` at **every session start**
- Update with `core_memory_replace` when facts change
- `current_focus` should be updated frequently (max 5 items)
- Hard limit: 3KB — move details to archival

### Archival Memory (`archival_insert` / `archival_search`)
- `archival_insert`: store facts, decisions, events, summaries
- `archival_search`: keyword search before answering factual questions
- Always set `entity` and `tags` for better retrieval

### Memory Discipline
- If it matters → `archival_insert` it. "Mental notes" don't survive restarts.
- Don't guess → `archival_search` first.
- Update core memory proactively when projects complete or facts change.
PATCH
    echo "✅ AGENTS.md patched with memory tool instructions"
  else
    echo "⏭️  AGENTS.md already has memory tool instructions"
  fi
else
  echo "⚠️  AGENTS.md not found at $AGENTS_MD — create it with memory instructions"
fi

# --- 8. Register cron jobs ---
if command -v openclaw &>/dev/null; then
  EXISTING_CRONS=$(openclaw cron list --json 2>/dev/null | python3 -c "import sys,json; data=json.load(sys.stdin); print(' '.join(j.get('name','') for j in (data if isinstance(data,list) else data.get('jobs',[]))))" 2>/dev/null || echo "")

  register_cron() {
    local name="$1" cron="$2" msg="$3" desc="$4" timeout="${5:-60000}"
    if echo "$EXISTING_CRONS" | grep -q "$name"; then
      echo "⏭️  Cron '$name' already exists"
      return
    fi
    openclaw cron add \
      --name "$name" \
      --cron "$cron" \
      --tz "$(python3 -c 'import time; import datetime; print(datetime.datetime.now().astimezone().tzname())' 2>/dev/null || echo 'UTC')" \
      --agent main \
      --session isolated \
      --model "anthropic/claude-sonnet-4-6" \
      --message "$msg" \
      --description "$desc" \
      --timeout "$timeout" \
      >/dev/null 2>&1 && echo "✅ Cron '$name' registered" || echo "⚠️  Cron '$name' failed to register (gateway may not be running)"
  }

  register_cron "memory-reflect-daily" "0 9 * * *" \
    "Run memory_reflect with window_days=7. If you notice patterns, store via archival_insert with tags=['reflection']. Do NOT output to main chat." \
    "Daily reflection: analyze memory patterns"

  register_cron "memory-consolidate-6h" "0 */6 * * *" \
    "Read today's daily log. If it has content not in archival, run memory_consolidate. Then archival_stats. Do NOT output to main chat." \
    "Auto-consolidate daily logs every 6 hours"

  register_cron "memory-dedup-weekly" "0 4 * * 0" \
    "Run archival_deduplicate with apply=true. Then archival_stats. Do NOT output to main chat." \
    "Weekly dedup: clean near-duplicate records"

  register_cron "memory-dashboard-daily" "30 9 * * *" \
    "Run memory_dashboard to regenerate the HTML dashboard. Do NOT output to main chat." \
    "Daily dashboard refresh" 30000
else
  echo "⚠️  openclaw CLI not found — skipping cron registration. Register manually after install."
fi

# --- 9. Validate config ---
echo ""
if command -v openclaw &>/dev/null; then
  openclaw config validate 2>&1 && echo "✅ Config valid" || echo "❌ Config validation failed — check openclaw.json"
fi

echo ""
echo "🎉 Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Edit $MEMORY_DIR/core.json with your info"
echo "  2. Restart gateway: openclaw gateway restart"
echo "  3. Test: openclaw agent -m 'core_memory_read'"
echo "  4. Open dashboard: open $MEMORY_DIR/dashboard.html"
echo ""
echo "Your agent now has 19 memory tools:"
echo "  Core:        core_memory_read, core_memory_replace, core_memory_append"
echo "  Archival:    archival_insert, archival_search, archival_update, archival_delete, archival_stats"
echo "  Graph:       graph_query, graph_add"
echo "  Episodes:    episode_save, episode_recall"
echo "  Reflection:  memory_reflect"
echo "  Maintenance: archival_deduplicate, memory_consolidate"
echo "  Backup:      memory_export, memory_import"
echo "  Admin:       memory_migrate, memory_dashboard"
echo ""
echo "Cron jobs registered:"
echo "  Daily 9:00am — memory reflection"
echo "  Every 6h     — auto-consolidate daily logs"
echo "  Weekly Sun    — deduplicate archival"
echo "  Daily 9:30am — dashboard refresh"
