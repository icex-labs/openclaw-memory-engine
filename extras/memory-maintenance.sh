#!/bin/bash
# memory-maintenance.sh — Automated memory system maintenance
# Replaces the old memory-cleanup.sh with a comprehensive maintenance system
#
# Runs daily at 3am via LaunchAgent
# Actions:
#   1. Health check: MEMORY.md size limits
#   2. Daily logs: merge week-old dailies into weekly summaries
#   3. Archive: move weekly summaries older than 60 days
#   4. Topic files: warn if any topic file exceeds size limit
#   5. Report: append to maintenance log

set -euo pipefail

WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"
MEMORY_DIR="$WORKSPACE/memory"
TOPICS_DIR="$MEMORY_DIR/topics"
WEEKLY_DIR="$MEMORY_DIR/weekly"
ARCHIVE_DIR="$MEMORY_DIR/archive"
LOG_FILE="$MEMORY_DIR/maintenance.log"
ALERT_FILE="$MEMORY_DIR/maintenance-alerts.json"

MEMORY_MD="$WORKSPACE/MEMORY.md"
DATE=$(date +%Y-%m-%d)
TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%S)

# Limits (bytes)
MEMORY_MD_MAX=5120        # 5KB — hard limit for MEMORY.md
MEMORY_MD_WARN=4096       # 4KB — warning threshold
TOPIC_FILE_MAX=8192       # 8KB per topic file
DAILY_RETAIN_DAYS=7       # Keep daily logs for 7 days
WEEKLY_ARCHIVE_DAYS=60    # Archive weekly summaries after 60 days

mkdir -p "$TOPICS_DIR" "$WEEKLY_DIR" "$ARCHIVE_DIR"

# --- Helpers ---
log() { echo "[$TIMESTAMP] $1" >> "$LOG_FILE"; }
alert_json=""
add_alert() {
  local level="$1" msg="$2"
  if [ -z "$alert_json" ]; then
    alert_json="[{\"level\":\"$level\",\"msg\":\"$msg\",\"ts\":\"$TIMESTAMP\"}"
  else
    alert_json="$alert_json,{\"level\":\"$level\",\"msg\":\"$msg\",\"ts\":\"$TIMESTAMP\"}"
  fi
}

# --- 1. MEMORY.md health check ---
if [ -f "$MEMORY_MD" ]; then
  mem_size=$(wc -c < "$MEMORY_MD" | tr -d ' ')
  mem_lines=$(wc -l < "$MEMORY_MD" | tr -d ' ')
  if [ "$mem_size" -gt "$MEMORY_MD_MAX" ]; then
    add_alert "critical" "MEMORY.md is ${mem_size}B (>${MEMORY_MD_MAX}B limit). Needs trimming."
    log "CRITICAL: MEMORY.md ${mem_size}B exceeds ${MEMORY_MD_MAX}B limit (${mem_lines} lines)"
  elif [ "$mem_size" -gt "$MEMORY_MD_WARN" ]; then
    add_alert "warn" "MEMORY.md is ${mem_size}B (>${MEMORY_MD_WARN}B warning). Consider trimming."
    log "WARN: MEMORY.md ${mem_size}B approaching limit (${mem_lines} lines)"
  else
    log "OK: MEMORY.md ${mem_size}B / ${mem_lines} lines"
  fi
else
  add_alert "critical" "MEMORY.md not found!"
  log "CRITICAL: MEMORY.md missing"
fi

# --- 2. Topic file health check ---
if [ -d "$TOPICS_DIR" ]; then
  for f in "$TOPICS_DIR"/*.md; do
    [ -f "$f" ] || continue
    fsize=$(wc -c < "$f" | tr -d ' ')
    fname=$(basename "$f")
    if [ "$fsize" -gt "$TOPIC_FILE_MAX" ]; then
      add_alert "warn" "Topic ${fname} is ${fsize}B (>${TOPIC_FILE_MAX}B). Needs pruning."
      log "WARN: Topic ${fname} ${fsize}B exceeds limit"
    fi
  done
fi

# --- 3. Merge old daily logs into weekly summaries ---
# Find daily logs (YYYY-MM-DD.md) older than DAILY_RETAIN_DAYS
daily_count=0
merged_count=0
for f in "$MEMORY_DIR"/2???-??-??.md; do
  [ -f "$f" ] || continue
  fname=$(basename "$f" .md)
  # Parse date from filename
  file_date="$fname"

  # Calculate age in days using date arithmetic
  file_epoch=$(date -j -f "%Y-%m-%d" "$file_date" "+%s" 2>/dev/null || echo 0)
  now_epoch=$(date "+%s")
  if [ "$file_epoch" -eq 0 ]; then
    continue
  fi
  age_days=$(( (now_epoch - file_epoch) / 86400 ))

  if [ "$age_days" -gt "$DAILY_RETAIN_DAYS" ]; then
    # Determine ISO week: YYYY-Www
    week_label=$(date -j -f "%Y-%m-%d" "$file_date" "+%G-W%V" 2>/dev/null || continue)
    weekly_file="$WEEKLY_DIR/${week_label}.md"

    # Append daily content to weekly file with date header
    if [ ! -f "$weekly_file" ]; then
      echo "# Weekly Summary: ${week_label}" > "$weekly_file"
      echo "" >> "$weekly_file"
    fi
    echo "## ${file_date}" >> "$weekly_file"
    echo "" >> "$weekly_file"
    # Extract just the section headers and key bullet points (compress)
    grep -E '^##|^- |^\*' "$f" >> "$weekly_file" 2>/dev/null || true
    echo "" >> "$weekly_file"

    # Move original to archive
    mv "$f" "$ARCHIVE_DIR/"
    merged_count=$((merged_count + 1))
  fi
  daily_count=$((daily_count + 1))
done
log "Daily logs: ${daily_count} active, ${merged_count} merged into weekly"

# --- 4. Archive old weekly summaries ---
archive_count=0
for f in "$WEEKLY_DIR"/*.md; do
  [ -f "$f" ] || continue
  fmod=$(stat -f %m "$f" 2>/dev/null || echo 0)
  now_epoch=$(date "+%s")
  age_days=$(( (now_epoch - fmod) / 86400 ))
  if [ "$age_days" -gt "$WEEKLY_ARCHIVE_DAYS" ]; then
    mv "$f" "$ARCHIVE_DIR/"
    archive_count=$((archive_count + 1))
  fi
done
if [ "$archive_count" -gt 0 ]; then
  log "Archived ${archive_count} weekly summaries (>${WEEKLY_ARCHIVE_DAYS} days old)"
fi

# --- 5. Count total memory footprint ---
total_active=$(du -sh "$MEMORY_DIR" 2>/dev/null | cut -f1)
total_archive=$(du -sh "$ARCHIVE_DIR" 2>/dev/null | cut -f1)
topic_count=$(ls "$TOPICS_DIR"/*.md 2>/dev/null | wc -l | tr -d ' ')
daily_active=$(ls "$MEMORY_DIR"/2???-??-??.md 2>/dev/null | wc -l | tr -d ' ')
weekly_active=$(ls "$WEEKLY_DIR"/*.md 2>/dev/null | wc -l | tr -d ' ')
log "Totals: active=${total_active} archive=${total_archive} topics=${topic_count} dailies=${daily_active} weeklies=${weekly_active}"

# --- 6. Handle special-name daily logs (e.g., 2026-03-28-maren-stuck.md) ---
for f in "$MEMORY_DIR"/2???-??-??-*.md; do
  [ -f "$f" ] || continue
  fname=$(basename "$f" .md)
  file_date=$(echo "$fname" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}')
  [ -z "$file_date" ] && continue

  file_epoch=$(date -j -f "%Y-%m-%d" "$file_date" "+%s" 2>/dev/null || echo 0)
  now_epoch=$(date "+%s")
  [ "$file_epoch" -eq 0 ] && continue
  age_days=$(( (now_epoch - file_epoch) / 86400 ))

  if [ "$age_days" -gt "$DAILY_RETAIN_DAYS" ]; then
    mv "$f" "$ARCHIVE_DIR/"
    log "Archived special log: $(basename "$f") (${age_days} days old)"
  fi
done

# --- 7. Write alerts file ---
if [ -n "$alert_json" ]; then
  echo "${alert_json}]" > "$ALERT_FILE"
  log "Alerts written: $(echo "${alert_json}]" | grep -o '"level"' | wc -l | tr -d ' ') items"
else
  echo "[]" > "$ALERT_FILE"
fi

# --- 8. Trim maintenance log (keep last 90 entries) ---
if [ -f "$LOG_FILE" ]; then
  tail -270 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
fi

log "Maintenance complete"
