/**
 * cc-soul — Data persistence layer
 *
 * Handles all file I/O: path constants, atomic save, debounced writes, config loading.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import type { SoulConfig } from './types.ts'

// ═══════════════════════════════════════════════════════════════════════════════
// PATH CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

// Auto-detect data dir: prefer plugins/ path, fallback to hooks/ for backward compat
const _pluginsData = resolve(homedir(), '.openclaw/plugins/cc-soul/data')
const _hooksData = resolve(homedir(), '.openclaw/hooks/cc-soul/data')
export const DATA_DIR = existsSync(_pluginsData) ? _pluginsData : _hooksData
export const BRAIN_PATH = resolve(DATA_DIR, 'brain.json')
export const MEMORIES_PATH = resolve(DATA_DIR, 'memories.json')
export const RULES_PATH = resolve(DATA_DIR, 'rules.json')
export const STATS_PATH = resolve(DATA_DIR, 'stats.json')
export const CONFIG_PATH = resolve(DATA_DIR, 'config.json')
export const HISTORY_PATH = resolve(DATA_DIR, 'history.json')
export const GRAPH_PATH = resolve(DATA_DIR, 'graph.json')
export const HYPOTHESES_PATH = resolve(DATA_DIR, 'hypotheses.json')
export const EVAL_PATH = resolve(DATA_DIR, 'eval.json')
export const JOURNAL_PATH = resolve(DATA_DIR, 'journal.json')
export const USER_MODEL_PATH = resolve(DATA_DIR, 'user_model.json')
export const SOUL_EVOLVED_PATH = resolve(DATA_DIR, 'soul_evolved.json')
export const PATTERNS_PATH = resolve(DATA_DIR, 'patterns.json')
export const FOLLOW_UPS_PATH = resolve(DATA_DIR, 'followups.json')
export const PLANS_PATH = resolve(DATA_DIR, 'plans.json')
export const WORKFLOWS_PATH = resolve(DATA_DIR, 'workflows.json')
export const SUCCESS_PATTERNS_PATH = resolve(DATA_DIR, 'success_patterns.json')
export const FEATURES_PATH = resolve(DATA_DIR, 'features.json')
export const FEEDBACK_STATE_PATH = resolve(DATA_DIR, 'feedback_state.json')
export const SYNC_CONFIG_PATH = resolve(DATA_DIR, 'sync_config.json')
export const SYNC_EXPORT_PATH = resolve(DATA_DIR, 'sync-export.jsonl')
export const SYNC_IMPORT_PATH = resolve(DATA_DIR, 'sync-import.jsonl')
export const UPGRADE_META_PATH = resolve(DATA_DIR, 'upgrade_meta.json')
export const REMINDERS_PATH = resolve(DATA_DIR, 'reminders.json')
const _pluginsCode = resolve(homedir(), '.openclaw/plugins/cc-soul/cc-soul')
const _hooksCode = resolve(homedir(), '.openclaw/hooks/cc-soul/cc-soul')
const _moduleDir = existsSync(_pluginsCode) ? _pluginsCode : _hooksCode
export const HANDLER_PATH = resolve(_moduleDir, 'handler.ts')
export const MODULE_DIR = _moduleDir
export const HANDLER_BACKUP_DIR = resolve(DATA_DIR, 'backups')

// ═══════════════════════════════════════════════════════════════════════════════
// ENSURE DATA DIR
// ═══════════════════════════════════════════════════════════════════════════════

export function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true })
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOAD JSON
// ═══════════════════════════════════════════════════════════════════════════════

export function loadJson<T>(path: string, fallback: T): T {
  try {
    const raw = readFileSync(path, 'utf-8').trim()
    if (!raw) return fallback
    return JSON.parse(raw)
  } catch (e: any) {
    if (e.code === 'ENOENT') return fallback
    console.error(`[cc-soul] CORRUPTED JSON: ${path}: ${e.message}`)
    // Backup corrupted file for diagnosis
    try {
      const backup = path + '.corrupted.' + Date.now()
      writeFileSync(backup, readFileSync(path, 'utf-8'), 'utf-8')
      console.error(`[cc-soul] corrupted file backed up to ${backup}`)
    } catch { /* best effort */ }
  }
  return fallback
}

// ═══════════════════════════════════════════════════════════════════════════════
// SAVE JSON + DEBOUNCED SAVE — atomic write (tmp + rename), debounce layer
// ═══════════════════════════════════════════════════════════════════════════════

const pendingSaves = new Map<string, { data: any; timer: ReturnType<typeof setTimeout> | null }>()

export function saveJson(path: string, data: any) {
  // Cancel any pending debounced save for this path to prevent stale data overwrite
  const pending = pendingSaves.get(path)
  if (pending?.timer) clearTimeout(pending.timer)
  pendingSaves.delete(path)

  ensureDataDir()
  const tmp = path + '.tmp'
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    renameSync(tmp, path)
  } catch (e: any) {
    console.error(`[cc-soul] failed to save ${path}: ${e.message}`)
  }
}

export function debouncedSave(path: string, data: any, delayMs = 3000) {
  const existing = pendingSaves.get(path)
  if (existing?.timer) clearTimeout(existing.timer)
  // Clone data to prevent stale reference after reassignment
  const snapshot = JSON.parse(JSON.stringify(data))
  const timer = setTimeout(() => {
    saveJson(path, snapshot)
    pendingSaves.delete(path)
  }, delayMs)
  pendingSaves.set(path, { data: snapshot, timer })
}

export function flushAll() {
  for (const [path, entry] of pendingSaves) {
    if (entry.timer) clearTimeout(entry.timer)
    saveJson(path, entry.data)
  }
  pendingSaves.clear()

  // Sync essential memories to OpenClaw workspace for native memory_search compatibility
  // This ensures memories survive cc-soul uninstall
  syncMemoriesToWorkspace()
}

// ── Sync cc-soul memories to OpenClaw workspace ──
// Writes a markdown snapshot of important memories to ~/.openclaw/workspace/memory/
// OpenClaw's native memory_search indexes this directory

let _lastSyncHash = ''

function syncMemoriesToWorkspace() {
  try {
    // Dynamic import to avoid circular dependency (persistence ← memory ← persistence)
    let memoryState: any
    try { memoryState = require('./memory.ts').memoryState } catch { return }
    if (!memoryState?.memories?.length) return

    // Filter: only long-term, preference, fact, correction, consolidated
    const SYNC_SCOPES = new Set(['long_term', 'preference', 'fact', 'correction', 'consolidated', 'pinned'])
    const important = memoryState.memories.filter((m: any) =>
      SYNC_SCOPES.has(m.scope) ||
      SYNC_SCOPES.has(m.tier) ||
      (m.confidence && m.confidence >= 0.9) ||
      (m.recallCount && m.recallCount >= 3)
    ).filter((m: any) => m.scope !== 'expired' && m.scope !== 'decayed')

    if (important.length === 0) return

    // Quick hash check to avoid unnecessary writes
    const hash = `${important.length}_${important[0]?.ts}_${important[important.length - 1]?.ts}`
    if (hash === _lastSyncHash) return
    _lastSyncHash = hash

    // Build markdown
    const lines = ['# cc-soul Memories\n', `> Auto-synced: ${new Date().toISOString()} | ${important.length} entries\n`]

    // Group by scope
    const grouped = new Map<string, any[]>()
    for (const m of important) {
      const key = m.scope || 'other'
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key)!.push(m)
    }

    for (const [scope, mems] of grouped) {
      lines.push(`\n## ${scope}\n`)
      for (const m of mems.slice(0, 100)) { // cap per scope
        const emotionTag = m.emotion && m.emotion !== 'neutral' ? ` [${m.emotion}]` : ''
        lines.push(`- ${m.content}${emotionTag}`)
      }
    }

    // Write to workspace
    const workspaceMemDir = resolve(homedir(), '.openclaw/workspace/memory')
    mkdirSync(workspaceMemDir, { recursive: true })
    const outPath = resolve(workspaceMemDir, 'cc-soul-memories.md')
    writeFileSync(outPath, lines.join('\n'), 'utf-8')
    console.log(`[cc-soul][sync-workspace] synced ${important.length} memories to ${outPath}`)
  } catch (e: any) {
    // Silent fail — workspace sync is best-effort
    console.error(`[cc-soul][sync-workspace] ${e.message}`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG — env vars first, fall back to config.json
// ═══════════════════════════════════════════════════════════════════════════════

export function loadConfig(): SoulConfig {
  const config: SoulConfig = {
    feishu_app_id: process.env.CC_SOUL_FEISHU_APP_ID || '',
    feishu_app_secret: process.env.CC_SOUL_FEISHU_APP_SECRET || '',
    report_chat_id: process.env.CC_SOUL_REPORT_CHAT_ID || '',
    owner_open_id: process.env.CC_SOUL_OWNER_OPEN_ID || '',
  }
  // Fall back to config.json for any empty values
  if (!config.feishu_app_id || !config.feishu_app_secret || !config.report_chat_id || !config.owner_open_id) {
    try {
      if (existsSync(CONFIG_PATH)) {
        const file = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
        for (const [k, v] of Object.entries(file)) {
          if (!config[k as keyof SoulConfig]) config[k as keyof SoulConfig] = v as string
        }
      }
    } catch {
      // config.json missing or malformed — proceed with env-only values
    }
  }
  return config
}

// Loaded once at module init
export const soulConfig = loadConfig()
