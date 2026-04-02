#!/bin/bash
# setup.sh — One-command setup for openclaw-memory-engine
# Usage: bash setup.sh [workspace_path]
#   --non-interactive    Skip prompts, use defaults
#
# Supports: macOS (LaunchAgent), Linux (systemd timer), Windows (manual)

set -euo pipefail

NON_INTERACTIVE=false
WS_ARG=""
for arg in "$@"; do
  case "$arg" in
    --non-interactive) NON_INTERACTIVE=true ;;
    *) [ -z "$WS_ARG" ] && WS_ARG="$arg" ;;
  esac
done
WORKSPACE="${WS_ARG:-${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}}"
OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"
CONFIG="$OPENCLAW_DIR/openclaw.json"
MEMORY_DIR="$WORKSPACE/memory"
AGENTS_MD="$WORKSPACE/AGENTS.md"
PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
OS="$(uname -s)"

echo "🧠 openclaw-memory-engine setup"
echo "   Workspace: $WORKSPACE"
echo "   Config:    $CONFIG"
echo "   Platform:  $OS"
echo ""

# --- Helper: prompt with default ---
ask() {
  local prompt="$1" default="$2" var_name="$3"
  if $NON_INTERACTIVE; then
    eval "$var_name=\"$default\""
    return
  fi
  printf "%s [%s]: " "$prompt" "$default"
  read -r input
  eval "$var_name=\"${input:-$default}\""
}

# --- 1. Create memory directory ---
mkdir -p "$MEMORY_DIR"
echo "✅ memory/ directory ready"

# --- 2. Create core.json (interactive or template) ---
if [ ! -f "$MEMORY_DIR/core.json" ]; then
  echo ""
  echo "📝 Let's set up your core memory (what your agent knows about you)."
  echo "   Press Enter to skip any field — you can update later via core_memory_replace."
  echo ""

  ask "Your name" "" USER_NAME
  ask "Your location (city, timezone)" "" USER_LOCATION
  ask "Language preference (e.g., 'English', '中英对照')" "English" USER_LANG
  ask "Your job/role" "" USER_JOB
  ask "Agent relationship (e.g., 'helpful assistant', 'intimate companion')" "helpful assistant" REL_DYNAMIC

  python3 -c "
import json, datetime
core = {
    '_meta': {
        'version': 1,
        'updated_at': datetime.datetime.utcnow().isoformat() + 'Z',
        'description': 'Core memory block — always in context. Keep under 500 tokens.'
    },
    'user': {
        'name': '''$USER_NAME''',
        'location': '''$USER_LOCATION''',
        'language': '''$USER_LANG''',
        'job': '''$USER_JOB'''
    },
    'relationship': {
        'dynamic': '''$REL_DYNAMIC''',
        'trust': '',
        'boundaries': ''
    },
    'preferences': {},
    'current_focus': []
}
# Remove empty string values
for section in ['user', 'relationship']:
    core[section] = {k: v for k, v in core[section].items() if v}
with open('$MEMORY_DIR/core.json', 'w') as f:
    json.dump(core, f, indent=2, ensure_ascii=False)
print('✅ core.json created with your info')
" 2>/dev/null || {
    # Fallback if python3 fails
    cat > "$MEMORY_DIR/core.json" <<'CORE'
{
  "_meta": { "version": 1, "updated_at": "", "description": "Core memory block." },
  "user": {},
  "relationship": { "dynamic": "helpful assistant" },
  "preferences": {},
  "current_focus": []
}
CORE
    echo "✅ core.json created (edit manually to add your info)"
  }
else
  echo "⏭️  core.json already exists"
fi

# --- 3. Create empty archival.jsonl (if not exists) ---
if [ ! -f "$MEMORY_DIR/archival.jsonl" ]; then
  touch "$MEMORY_DIR/archival.jsonl"
  echo "✅ archival.jsonl created"
else
  lines=$(wc -l < "$MEMORY_DIR/archival.jsonl" | tr -d ' ')
  echo "⏭️  archival.jsonl already exists ($lines records)"
fi

# --- 3b. Migrate legacy memory files into archival ---
if command -v node &>/dev/null && [ -f "$PLUGIN_DIR/extras/migrate-legacy.mjs" ]; then
  # Check if there are legacy files to migrate
  legacy_count=0
  [ -f "$WORKSPACE/MEMORY.md" ] && legacy_count=$((legacy_count + 1))
  md_count=$(find "$MEMORY_DIR" -maxdepth 1 -name "*.md" 2>/dev/null | wc -l | tr -d ' ' || true)
  weekly_count=$(find "$MEMORY_DIR/weekly" -name "*.md" 2>/dev/null | wc -l | tr -d ' ' || true)
  topics_count=$(find "$MEMORY_DIR/topics" -name "*.md" 2>/dev/null | wc -l | tr -d ' ' || true)
  : "${md_count:=0}" "${weekly_count:=0}" "${topics_count:=0}"
  legacy_count=$((legacy_count + md_count + weekly_count + topics_count))

  archival_count=0
  [ -f "$MEMORY_DIR/archival.jsonl" ] && archival_count=$(wc -l < "$MEMORY_DIR/archival.jsonl" | tr -d ' ')

  if [ "$legacy_count" -gt 0 ] && [ "$archival_count" -lt 10 ]; then
    echo ""
    echo "📦 Found $legacy_count legacy memory files (MEMORY.md, daily logs, weekly summaries, topics)."
    if $NON_INTERACTIVE; then
      echo "   Migrating automatically..."
      node "$PLUGIN_DIR/extras/migrate-legacy.mjs" "$WORKSPACE" 2>&1 | tail -3
    else
      printf "   Migrate into archival memory? [Y/n]: "
      read -r migrate_answer
      if [ "${migrate_answer:-Y}" != "n" ] && [ "${migrate_answer:-Y}" != "N" ]; then
        node "$PLUGIN_DIR/extras/migrate-legacy.mjs" "$WORKSPACE" 2>&1 | tail -5
      else
        echo "⏭️  Skipping migration. Run manually later: node $PLUGIN_DIR/extras/migrate-legacy.mjs $WORKSPACE"
      fi
    fi
    echo ""
  else
    if [ "$archival_count" -gt 10 ]; then
      echo "⏭️  Archival already has $archival_count records, skipping migration"
    fi
  fi
fi

# --- 4. Install memory-maintenance.sh ---
SCRIPTS_DIR="$WORKSPACE/scripts"
mkdir -p "$SCRIPTS_DIR"
if [ ! -f "$SCRIPTS_DIR/memory-maintenance.sh" ]; then
  if cp "$PLUGIN_DIR/extras/memory-maintenance.sh" "$SCRIPTS_DIR/memory-maintenance.sh" 2>/dev/null; then
    chmod +x "$SCRIPTS_DIR/memory-maintenance.sh" 2>/dev/null || true
    echo "✅ memory-maintenance.sh installed"
  else
    echo "⚠️  memory-maintenance.sh not found in extras/. Copy manually."
  fi
else
  echo "⏭️  memory-maintenance.sh already exists"
fi

# --- 5. Install platform-specific scheduler ---
install_scheduler() {
  case "$OS" in
    Darwin)
      # macOS: LaunchAgent
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
        echo "✅ macOS LaunchAgent installed (daily 3am)"
      else
        echo "⏭️  macOS LaunchAgent already exists"
      fi
      ;;

    Linux)
      # Linux: systemd user timer
      UNIT_DIR="$HOME/.config/systemd/user"
      mkdir -p "$UNIT_DIR"
      if [ ! -f "$UNIT_DIR/openclaw-memory-maintenance.timer" ]; then
        cat > "$UNIT_DIR/openclaw-memory-maintenance.service" <<SVC
[Unit]
Description=OpenClaw Memory Maintenance
[Service]
Type=oneshot
ExecStart=/bin/bash $SCRIPTS_DIR/memory-maintenance.sh
SVC
        cat > "$UNIT_DIR/openclaw-memory-maintenance.timer" <<TMR
[Unit]
Description=OpenClaw Memory Maintenance Timer
[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
[Install]
WantedBy=timers.target
TMR
        systemctl --user daemon-reload 2>/dev/null || true
        systemctl --user enable --now openclaw-memory-maintenance.timer 2>/dev/null || true
        echo "✅ Linux systemd timer installed (daily 3am)"
      else
        echo "⏭️  Linux systemd timer already exists"
      fi
      ;;

    MINGW*|MSYS*|CYGWIN*)
      echo "⚠️  Windows detected. Add a scheduled task manually:"
      echo "    schtasks /create /tn \"OpenClaw Memory Maintenance\" /tr \"bash $SCRIPTS_DIR/memory-maintenance.sh\" /sc daily /st 03:00"
      ;;

    *)
      echo "⚠️  Unknown platform ($OS). Set up a daily cron manually:"
      echo "    0 3 * * * /bin/bash $SCRIPTS_DIR/memory-maintenance.sh"
      ;;
  esac
}
install_scheduler

# --- 6. Patch openclaw.json ---
if command -v python3 &>/dev/null && [ -f "$CONFIG" ]; then
  python3 <<PYEOF
import json

with open("$CONFIG") as f:
    cfg = json.load(f)

changed = False

allow = cfg.setdefault("plugins", {}).setdefault("allow", [])
if "memory-engine" not in allow:
    allow.append("memory-engine")
    changed = True

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
    print("✅ openclaw.json updated")
else:
    print("⏭️  openclaw.json already configured")
PYEOF
else
  echo "⚠️  Could not patch openclaw.json. Add manually:"
  echo '  "plugins": { "allow": ["memory-engine"], "entries": { "memory-engine": { "enabled": true } } }'
fi

# --- 7. Patch AGENTS.md ---
if [ -f "$AGENTS_MD" ]; then
  if ! grep -q "core_memory_read" "$AGENTS_MD"; then
    cat >> "$AGENTS_MD" <<'PATCH'

## Memory System (memory-engine plugin v4.2)

**Memory is automatic.** All conversations are captured by hooks — you don't need to manually save anything.

### What NOT to do
- **Don't say "I'll remember that" or "recorded"** — memory happens silently
- **Don't call `archival_insert` for conversation content** — hooks already capture it
- Just be natural. Like a person who actually remembers things.

### When to use tools manually
- `core_memory_read` — call at **every session start** to load your identity
- `core_memory_replace` / `core_memory_append` — when identity facts change
- `archival_search` — **before answering factual questions** (don't guess)
- `archival_insert` — only for non-conversation sources (web_fetch results, file contents)
- `archival_update` / `archival_delete` — correct or remove wrong facts
- `graph_query` — answer relational questions ("who is my doctor?")
- `episode_save` — at end of meaningful conversations (summary, decisions, mood)
- `episode_recall` — "what did we discuss about X last time?"
- `memory_reflect` — during heartbeats to analyze patterns
PATCH
    echo "✅ AGENTS.md patched with memory instructions"
  else
    echo "⏭️  AGENTS.md already has memory instructions"
  fi
else
  echo "⚠️  AGENTS.md not found — create it with memory instructions"
fi

# --- 8. Register cron jobs (for all agents with workspaces) ---
if command -v openclaw &>/dev/null; then
  EXISTING_CRONS=$(openclaw cron list --json 2>/dev/null | python3 -c "import sys,json; data=json.load(sys.stdin); print(' '.join(j.get('name','') for j in (data if isinstance(data,list) else data.get('jobs',[]))))" 2>/dev/null || echo "")

  # Detect timezone
  TZ_IANA=$(python3 -c "
try:
    import subprocess
    if '$(uname)' == 'Darwin':
        tz = subprocess.check_output(['readlink', '/etc/localtime']).decode().strip().split('zoneinfo/')[-1]
    else:
        tz = open('/etc/timezone').read().strip()
    print(tz)
except:
    print('UTC')
" 2>/dev/null || echo "UTC")

  register_cron() {
    local name="$1" cron="$2" agent="$3" msg="$4" desc="$5" timeout="${6:-60000}"
    if echo "$EXISTING_CRONS" | grep -q "$name"; then
      echo "⏭️  Cron '$name' already exists"
      return
    fi
    openclaw cron add \
      --name "$name" \
      --cron "$cron" \
      --tz "$TZ_IANA" \
      --agent "$agent" \
      --session isolated \
      --model "anthropic/claude-sonnet-4-6" \
      --message "$msg" \
      --description "$desc" \
      --timeout "$timeout" \
      >/dev/null 2>&1 && echo "✅ Cron '$name' ($agent) registered" || echo "⚠️  Cron '$name' failed (gateway not running?)"
  }

  # Discover all agents from openclaw.json
  AGENTS=$(python3 -c "
import json, os
try:
    with open(os.path.expanduser('$CONFIG')) as f:
        cfg = json.load(f)
    agents = [a['id'] for a in cfg.get('agents',{}).get('list',[])]
    print(' '.join(agents) if agents else 'main')
except:
    print('main')
" 2>/dev/null || echo "main")

  echo "  Agents found: $AGENTS"

  # Register main agent crons (shared across all agents using default workspace)
  register_cron "memory-reflect-daily" "0 9 * * *" "main" \
    "Run memory_reflect with window_days=7. If you notice patterns, store via archival_insert with tags=['reflection']. Do NOT output to main chat." \
    "Daily reflection: analyze memory patterns"

  register_cron "memory-consolidate-6h" "0 */6 * * *" "main" \
    "Read today's daily log. If it has content not in archival, run memory_consolidate. Then archival_stats. Do NOT output to main chat." \
    "Auto-consolidate daily logs every 6 hours"

  register_cron "memory-dedup-weekly" "0 4 * * 0" "main" \
    "Run archival_deduplicate with apply=true. Then archival_stats. Do NOT output to main chat." \
    "Weekly dedup: clean near-duplicate records"

  register_cron "memory-dashboard-daily" "30 9 * * *" "main" \
    "Run memory_dashboard to regenerate the HTML dashboard. Do NOT output to main chat." \
    "Daily dashboard refresh for main agent" 30000

  # Register per-agent crons for agents with separate workspaces
  STAGGER=0
  for agent_id in $AGENTS; do
    # Skip main (already registered above)
    [ "$agent_id" = "main" ] && continue

    # Check if this agent has its own workspace
    HAS_OWN_WS=$(python3 -c "
import json, os
try:
    with open(os.path.expanduser('$CONFIG')) as f:
        cfg = json.load(f)
    default_ws = cfg.get('agents',{}).get('defaults',{}).get('workspace','')
    for a in cfg.get('agents',{}).get('list',[]):
        if a['id'] == '$agent_id' and a.get('workspace','') and a.get('workspace','') != default_ws:
            print('yes')
            break
    else:
        print('no')
except:
    print('no')
" 2>/dev/null || echo "no")

    if [ "$HAS_OWN_WS" = "yes" ]; then
      STAGGER=$((STAGGER + 5))
      register_cron "${agent_id}-memory-dashboard" "$((30 + STAGGER)) 9 * * *" "$agent_id" \
        "Run memory_dashboard to regenerate the HTML dashboard. Do NOT output to main chat." \
        "Daily dashboard refresh for $agent_id agent" 30000

      register_cron "${agent_id}-memory-consolidate" "30 */6 * * *" "$agent_id" \
        "Read today's daily log. If it has content not in archival, run memory_consolidate. Then archival_stats. Do NOT output to main chat." \
        "Auto-consolidate daily logs for $agent_id" 60000

      echo "  ✅ Per-agent crons registered for: $agent_id"
    fi
  done
else
  echo "⚠️  openclaw CLI not found — skipping cron registration"
fi

# --- 9. Validate config ---
echo ""
if command -v openclaw &>/dev/null; then
  openclaw config validate 2>&1 && echo "✅ Config valid" || echo "❌ Config validation failed"
fi

echo ""
echo "🎉 Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Review $MEMORY_DIR/core.json (edit if needed)"
echo "  2. Restart gateway: openclaw gateway restart"
echo "  3. Test: openclaw agent -m 'core_memory_read'"
echo "  4. Dashboard: open $MEMORY_DIR/dashboard.html"
echo ""
echo "20 tools + 2 hooks ready:"
echo "  Hooks:    auto-capture incoming messages + agent replies (passive)"
echo "  Core:     core_memory_read, core_memory_replace, core_memory_append"
echo "  Archival: archival_insert/search/update/delete/stats"
echo "  Graph:    graph_query, graph_add"
echo "  Episodes: episode_save, episode_recall"
echo "  Reflect:  memory_reflect"
echo "  Quality:  memory_quality"
echo "  Maint:    archival_deduplicate, memory_consolidate"
echo "  Backup:   memory_export, memory_import"
echo "  Admin:    memory_migrate, memory_dashboard"
echo ""
echo "Memory is automatic — hooks capture all conversations."
echo "Your agent doesn't need to say 'I'll remember that.'"
