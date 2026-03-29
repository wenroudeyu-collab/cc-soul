/**
 * features.ts — Feature toggle system
 *
 * Users can enable/disable individual cc-soul features via data/features.json.
 * All modules check isEnabled() before running.
 */

import { existsSync } from 'fs'
import { FEATURES_PATH, loadJson, saveJson } from './persistence.ts'

// ── Default features (all ON) ──

const DEFAULTS: Record<string, boolean> = {
  memory_active: true,
  memory_consolidation: true,
  memory_contradiction_scan: true,
  memory_tags: true,
  memory_associative_recall: true,
  memory_predictive: true,
  memory_session_summary: true,
  memory_core: true,
  memory_working: true,
  episodic_memory: true,    // Structured event chains with lessons

  lorebook: true,
  skill_library: true,

  persona_splitting: true,
  emotional_contagion: true,
  emotional_arc: true,      // Mood history + trend detection
  fingerprint: true,
  metacognition: true,
  relationship_dynamics: true, // Trust/familiarity per user
  intent_anticipation: true,  // Pre-warm from recent message patterns
  attention_decay: true,      // Budget shrinks with conversation length

  dream_mode: false,            // 砍：bot自嗨，用户看不到，浪费token
  autonomous_goals: true,
  plan_tracking: true,

  cost_tracker: true,         // Token usage tracking

  // v2.2+ brain modules
  smart_forget: true,          // Weibull+ACT-R intelligent memory decay
  context_compress: true,      // Progressive context compression (ACON paper)
  cron_agent: true,            // Scheduled autonomous tasks
  persona_drift: true,         // Shannon entropy drift detection
  persona_drift_detection: true, // Rule-based persona drift checking per reply
  wal_protocol: true,            // Write-Ahead Logging: persist key info before AI reply
  a2a: true,                   // Agent-to-Agent protocol
  theory_of_mind: true,        // User cognitive model tracking
  dag_archive: true,            // Lossless archiving instead of hard decay

  // v2.3+ conversation features
  rhythm_adaptation: true,        // Adapt reply length to user's message rhythm
  trust_annotation: true,         // Inject domain trust level hint
  self_correction: true,          // Auto self-check after reply, notify if low quality
  predictive_memory: true,        // Time-slot based topic prediction
  scenario_shortcut: true,        // Match correction history for quick hints
  context_reminder: true,         // Keyword-triggered contextual reminders

  // v2.3+ auto-trigger features (replace manual commands)
  auto_memory_reference: true,     // Auto-inject recalled memory summaries into prompt
  auto_time_travel: true,          // Auto-search history when user mentions "以前/上次/之前"
  auto_natural_citation: true,     // Natural citation of user's past statements
  auto_contradiction_hint: true,   // Proactively point out contradictions in current message
  auto_mood_care: true,            // Emotional care when mood is consistently low
  auto_daily_review: false,        // 砍：每晚推送日报，用户没要求就是骚扰
  auto_topic_save: true,           // Auto-save topic context on topic shift
  auto_memory_chain: true,         // Graph 1-hop expansion of recalled memories
  auto_repeat_detect: true,        // Detect similar past questions and cite conclusions
  behavior_prediction: true,        // Predict user's next behavior from historical patterns
  absence_detection: true,          // Detect topics user stopped mentioning and hint AI to ask
}

// ── State ──

let features: Record<string, boolean> = { ...DEFAULTS }

// ── Public API ──

export function loadFeatures() {
  if (!existsSync(FEATURES_PATH)) {
    features = { ...DEFAULTS }
    saveJson(FEATURES_PATH, features)
    const on = Object.values(features).filter(v => v).length
    console.log(`[cc-soul][features] ${on}/${Object.keys(features).length} features enabled (fresh)`)
    return
  }

  const loaded = loadJson<Record<string, boolean>>(FEATURES_PATH, {})
  // Only add missing keys from DEFAULTS, never overwrite existing values
  let needsSave = false
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (!(k in loaded)) {
      loaded[k] = v
      needsSave = true
    }
  }
  features = loaded
  if (needsSave) saveJson(FEATURES_PATH, features)

  const on = Object.values(features).filter(v => v).length
  console.log(`[cc-soul][features] ${on}/${Object.keys(features).length} features enabled`)
}

/**
 * Check if a feature is enabled.
 * Usage: if (isEnabled('dream_mode')) { ... }
 */
export function isEnabled(feature: string): boolean {
  if (!(feature in features)) {
    console.warn(`[cc-soul][features] unknown feature "${feature}" — defaulting to OFF`)
    return false
  }
  return features[feature] !== false
}

/**
 * Toggle a feature at runtime (also saves to disk).
 */
export function setFeature(feature: string, enabled: boolean) {
  if (!(feature in features)) return
  features[feature] = enabled
  saveJson(FEATURES_PATH, features)
  console.log(`[cc-soul][features] ${feature} → ${enabled ? 'ON' : 'OFF'}`)
}

/**
 * Get all feature states (for status display / dashboard).
 */
export function getAllFeatures(): Record<string, boolean> {
  return { ...features }
}

/**
 * Handle feature toggle commands from user messages.
 * "开启 dream_mode" / "关闭 xxx" / "功能状态"
 */
export function handleFeatureCommand(msg: string): string | boolean {
  const m = msg.trim()

  // Owner-only features: hidden from status display and cannot be toggled
  const HIDDEN_FEATURES = new Set(['self_upgrade', '_comment'])

  // Status check
  if (m === '功能状态' || m === 'features' || m === 'feature status') {
    const enabled = Object.entries(features).filter(([k, v]) => !HIDDEN_FEATURES.has(k) && v).length
    const total = Object.entries(features).filter(([k]) => !HIDDEN_FEATURES.has(k)).length
    const lines = Object.entries(features)
      .filter(([k]) => !HIDDEN_FEATURES.has(k))
      .map(([k, v]) => `  ${v ? '✅' : '❌'} ${k}`)
      .join('\n')
    console.log(`[cc-soul][features] status:\n${lines}`)
    return `功能开关 (${enabled}/${total} 已启用)\n${lines}`
  }

  // Owner-only features: cannot be toggled by regular users via chat
  const OWNER_ONLY = new Set(['self_upgrade'])

  // Toggle: "开启 xxx" / "关闭 xxx"
  const onMatch = m.match(/^(?:开启|启用|enable)\s+(\S+)$/)
  if (onMatch && onMatch[1] in features) {
    if (OWNER_ONLY.has(onMatch[1])) {
      console.log(`[cc-soul][features] ${onMatch[1]} is owner-only, cannot enable via chat`)
      return true
    }
    setFeature(onMatch[1], true)
    return `✅ 已开启: ${onMatch[1]}`
  }

  const offMatch = m.match(/^(?:关闭|禁用|disable)\s+(\S+)$/)
  if (offMatch && offMatch[1] in features) {
    if (OWNER_ONLY.has(offMatch[1])) {
      console.log(`[cc-soul][features] ${offMatch[1]} is owner-only, cannot disable via chat`)
      return `⚠️ ${offMatch[1]} 是 Owner 专属功能，无法通过聊天切换`
    }
    setFeature(offMatch[1], false)
    return `❌ 已关闭: ${offMatch[1]}`
  }

  return false
}
