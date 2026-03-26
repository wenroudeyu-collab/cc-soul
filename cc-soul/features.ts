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

  dream_mode: true,
  autonomous_voice: true,
  autonomous_goals: true,
  web_rover: false,           // OFF by default — requires explicit opt-in
  structured_reflection: true,
  plan_tracking: true,
  strategy_replay: true,    // Record + recall decision traces
  meta_learning: true,      // Learn about the learning process itself
  tech_radar: false,         // OFF by default — owner-only
  reflexion: true,           // Structured failure reflection → actionable rules
  self_challenge: true,      // Self-quiz during idle time to strengthen weak domains

  // All sensitive features OFF by default — require explicit opt-in
  // self_upgrade: NOT included — owner-only, hidden from feature list
  federation: false,
  sync: false,
  cost_tracker: true,         // Token usage tracking
  telemetry: false,

  // v2.2+ brain modules
  smart_forget: true,          // Weibull+ACT-R intelligent memory decay
  context_compress: true,      // Progressive context compression (ACON paper)
  cron_agent: true,            // Scheduled autonomous tasks
  debate: false,               // Multi-perspective internal debate (high token usage)
  persona_drift: true,         // Shannon entropy drift detection
  a2a: true,                   // Agent-to-Agent protocol
  llm_judge: false,            // LLM self-evaluation (requires extra API calls)
  skill_extract: true,         // Auto-detect reusable patterns
  theory_of_mind: true,        // User cognitive model tracking
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
 * "开启 dream_mode" / "关闭 web_rover" / "功能状态"
 */
export function handleFeatureCommand(msg: string): string | boolean {
  const m = msg.trim()

  // Owner-only features: hidden from status display and cannot be toggled
  const HIDDEN_FEATURES = new Set(['self_upgrade', 'tech_radar', 'competitive_radar', 'federation', 'sync', 'telemetry', 'web_rover', '_comment'])

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
  const OWNER_ONLY = new Set(['self_upgrade', 'tech_radar', 'competitive_radar', 'federation', 'sync', 'telemetry', 'web_rover'])

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
