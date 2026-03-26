/**
 * skill-extract.ts — Skill 自动提取
 *
 * Detects repeated user operation patterns and suggests extracting them
 * into reusable skills / automations.
 * Uses n-gram analysis over the last 100 operations.
 * Persisted to data/skill_patterns.json.
 */

import type { SoulModule } from './brain.ts'
import type { Augment } from './types.ts'
import { resolve } from 'path'
import { DATA_DIR, loadJson, debouncedSave } from './persistence.ts'

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const SKILL_PATH = resolve(DATA_DIR, 'skill_patterns.json')
const TAG = '[cc-soul][skill-extract]'
const MAX_OPERATIONS = 100
const SUGGEST_THRESHOLD = 3  // same pattern >= 3 times → suggest
const NGRAM_SIZES = [2, 3]   // look for 2-gram and 3-gram patterns

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface Operation {
  /** Normalized action label extracted from user message */
  action: string
  /** Whether the interaction was successful */
  success: boolean
  ts: number
}

interface PatternMatch {
  pattern: string
  count: number
  lastSeen: number
  suggested: boolean    // whether we already suggested this
  dismissed: boolean    // user said no
}

interface SkillState {
  operations: Operation[]
  patterns: PatternMatch[]
  suggestedSkills: string[]  // skills user accepted
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let state: SkillState = {
  operations: [],
  patterns: [],
  suggestedSkills: [],
}

function persist() {
  debouncedSave(SKILL_PATH, state)
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION NORMALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalize a user message into a short action label for pattern matching.
 * Strips specifics, keeps the intent.
 */
function normalizeAction(msg: string): string {
  let action = msg.trim().toLowerCase()

  // Strip quoted content and file paths
  action = action.replace(/"[^"]*"/g, '<STR>')
  action = action.replace(/'[^']*'/g, '<STR>')
  action = action.replace(/`[^`]*`/g, '<CODE>')
  action = action.replace(/\/[\w/.@-]+/g, '<PATH>')
  action = action.replace(/https?:\/\/\S+/g, '<URL>')
  action = action.replace(/\d+/g, '<N>')

  // Collapse whitespace
  action = action.replace(/\s+/g, ' ').trim()

  // Truncate to keep patterns manageable
  if (action.length > 50) action = action.slice(0, 50)

  return action
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Track a user operation for pattern detection.
 */
export function trackUserPattern(msg: string, wasSuccessful: boolean): void {
  if (!msg || msg.length < 3) return

  const action = normalizeAction(msg)
  state.operations.push({ action, success: wasSuccessful, ts: Date.now() })

  // Cap operations
  if (state.operations.length > MAX_OPERATIONS) {
    state.operations = state.operations.slice(-MAX_OPERATIONS)
  }

  // Re-analyze patterns after every new operation
  analyzePatterns()
  persist()
}

/**
 * Detect a repeated pattern that could become a skill.
 * Returns the most frequent unsuggested pattern, or null.
 */
export function detectRepeatedPattern(): { pattern: string; count: number; suggestedSkill: string } | null {
  const candidate = state.patterns.find(
    (p) => p.count >= SUGGEST_THRESHOLD && !p.suggested && !p.dismissed
  )
  if (!candidate) return null

  return {
    pattern: candidate.pattern,
    count: candidate.count,
    suggestedSkill: generateSkillName(candidate.pattern),
  }
}

/**
 * Get a user-friendly skill suggestion string, or null if nothing to suggest.
 */
export function getSkillSuggestion(): string | null {
  const detected = detectRepeatedPattern()
  if (!detected) return null

  // Mark as suggested so we don't repeat
  const pat = state.patterns.find((p) => p.pattern === detected.pattern)
  if (pat) {
    pat.suggested = true
    persist()
  }

  return `我注意到你经常做「${detected.pattern}」（已经${detected.count}次了），要不要我把它自动化为一个技能？`
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL: N-GRAM ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

function analyzePatterns() {
  const actions = state.operations.map((o) => o.action)
  const ngramCounts = new Map<string, number>()

  for (const n of NGRAM_SIZES) {
    for (let i = 0; i <= actions.length - n; i++) {
      const gram = actions.slice(i, i + n).join(' → ')
      ngramCounts.set(gram, (ngramCounts.get(gram) || 0) + 1)
    }
  }

  // Also count single action repeats (1-gram)
  for (const action of actions) {
    ngramCounts.set(action, (ngramCounts.get(action) || 0) + 1)
  }

  // Update patterns list
  for (const [pattern, count] of ngramCounts) {
    if (count < SUGGEST_THRESHOLD) continue

    const existing = state.patterns.find((p) => p.pattern === pattern)
    if (existing) {
      existing.count = count
      existing.lastSeen = Date.now()
    } else {
      state.patterns.push({
        pattern,
        count,
        lastSeen: Date.now(),
        suggested: false,
        dismissed: false,
      })
    }
  }

  // Prune old patterns that no longer meet threshold
  state.patterns = state.patterns.filter(
    (p) => p.count >= SUGGEST_THRESHOLD || p.suggested || p.dismissed
  )

  // Cap patterns list
  if (state.patterns.length > 50) {
    state.patterns.sort((a, b) => b.count - a.count)
    state.patterns = state.patterns.slice(0, 50)
  }
}

function generateSkillName(pattern: string): string {
  // Create a readable skill name from the pattern
  const cleaned = pattern
    .replace(/<STR>/g, '')
    .replace(/<CODE>/g, '')
    .replace(/<PATH>/g, '')
    .replace(/<URL>/g, '')
    .replace(/<N>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length < 3) return `auto-skill-${Date.now()}`
  return cleaned.slice(0, 30)
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODULE
// ═══════════════════════════════════════════════════════════════════════════════

export const skillExtractModule: SoulModule = {
  id: 'skill-extract',
  name: 'Skill自动提取',
  priority: 15,
  features: ['skill_extract'],

  init() {
    const loaded = loadJson<SkillState>(SKILL_PATH, {
      operations: [],
      patterns: [],
      suggestedSkills: [],
    })
    state = loaded
    if (!state.operations) state.operations = []
    if (!state.patterns) state.patterns = []
    if (!state.suggestedSkills) state.suggestedSkills = []

    console.log(`${TAG} loaded ${state.operations.length} operations, ${state.patterns.length} patterns`)
  },

  dispose() {
    persist()
  },

  onSent(event: any) {
    const userMsg = event?.userMessage || event?.content || ''
    if (!userMsg) return

    // Determine success: no error indicators in bot reply
    const botReply = event?.botReply || event?.response || ''
    const hasError = /error|失败|出错|cannot|unable/i.test(botReply)
    trackUserPattern(userMsg, !hasError)
  },

  onPreprocessed(event: any): Augment[] | void {
    // If we have a skill suggestion ready, inject it
    const suggestion = getSkillSuggestion()
    if (suggestion) {
      return [{ content: `💡 ${suggestion}`, priority: 2, tokens: 30 }]
    }
  },
}
