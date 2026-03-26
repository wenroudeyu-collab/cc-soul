/**
 * meta-feedback.ts — Adaptive Feedback Learning Engine
 *
 * Tracks augment effectiveness with sigmoid-based continuous multipliers,
 * difficulty correction, pair interaction effects, and trend detection.
 * Learns which augments help vs which are noise, adjusting priority dynamically.
 */

import { resolve } from 'path'
import type { SoulModule } from './brain.ts'
import { DATA_DIR, loadJson, debouncedSave } from './persistence.ts'

const META_FEEDBACK_PATH = resolve(DATA_DIR, 'meta_feedback.json')
const TAG = '[cc-soul][meta-feedback]'

// ═══════════════════════════════════════════════════════════════════════════════
// DATA STRUCTURES
// ═══════════════════════════════════════════════════════════════════════════════

interface AugmentEffectiveness {
  augmentType: string
  totalInjections: number
  qualitySum: number
  avgQuality: number
  correctionCount: number
  complexitySum: number
  avgComplexity: number
  recentScores: number[]      // last 20 quality scores
}

interface AugmentPairEffect {
  pair: string                // "typeA|typeB" (sorted alphabetically)
  coCount: number
  qualitySum: number
  avgQuality: number
}

interface MetaFeedbackState {
  effectiveness: AugmentEffectiveness[]
  pairEffects: AugmentPairEffect[]
  globalAvgComplexity: number
  globalSampleCount: number
}

const MAX_EFFECTIVENESS = 50
const MAX_PAIR_EFFECTS = 100
const RECENT_SCORES_CAP = 20
const COLD_START_THRESHOLD = 10

// ═══════════════════════════════════════════════════════════════════════════════
// MODULE STATE
// ═══════════════════════════════════════════════════════════════════════════════

let state: MetaFeedbackState = {
  effectiveness: [],
  pairEffects: [],
  globalAvgComplexity: 0,
  globalSampleCount: 0,
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Estimate complexity from augment content text (0-1 scale) */
function estimateComplexity(augmentText: string): number {
  let score = 0
  // Length factor: longer content → more complex context
  const len = augmentText.length
  if (len > 500) score += 0.3
  else if (len > 200) score += 0.15
  // Contains code blocks or inline code
  if (/```[\s\S]*```|`[^`]+`/.test(augmentText)) score += 0.35
  // Contains error-like patterns
  if (/error|exception|traceback|failed|crash|bug|issue/i.test(augmentText)) score += 0.25
  // Contains stack traces or file paths
  if (/at\s+\w+\s*\(|\/[\w/]+\.\w+:\d+/.test(augmentText)) score += 0.1
  return Math.min(score, 1.0)
}

/** Build sorted pair key from two augment types */
function makePairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/** Sigmoid mapping: quality → multiplier in [0.5, 1.5] */
function sigmoidMultiplier(avgQuality: number): number {
  return 0.5 + 1.0 / (1 + Math.exp(-(avgQuality - 5) * 0.5))
}

// ═══════════════════════════════════════════════════════════════════════════════
// TREND DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

type TrendResult = 'rising' | 'declining' | 'stable'

function detectTrend(recentScores: number[]): TrendResult {
  if (recentScores.length < 10) return 'stable'
  const mid = Math.floor(recentScores.length / 2)
  const firstHalf = recentScores.slice(0, mid)
  const secondHalf = recentScores.slice(mid)
  const avgFirst = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length
  const avgSecond = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length
  const diff = avgSecond - avgFirst
  if (diff > 1.0) return 'rising'
  if (diff < -1.0) return 'declining'
  return 'stable'
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA MIGRATION
// ═══════════════════════════════════════════════════════════════════════════════

function migrateIfNeeded(raw: any): MetaFeedbackState {
  // Old format: bare array of effectiveness entries
  if (Array.isArray(raw)) {
    console.log(`${TAG} migrating old array format → MetaFeedbackState`)
    const migrated: AugmentEffectiveness[] = raw.map((e: any) => ({
      augmentType: e.augmentType ?? 'unknown',
      totalInjections: e.totalInjections ?? 0,
      qualitySum: e.qualitySum ?? 0,
      avgQuality: e.avgQuality ?? 5,
      correctionCount: e.correctionCount ?? 0,
      complexitySum: e.complexitySum ?? 0,
      avgComplexity: e.avgComplexity ?? 0,
      recentScores: e.recentScores ?? [],
    }))
    return {
      effectiveness: migrated,
      pairEffects: [],
      globalAvgComplexity: 0,
      globalSampleCount: 0,
    }
  }

  // New format but might have missing fields (partial upgrade)
  if (raw && typeof raw === 'object' && 'effectiveness' in raw) {
    const s = raw as Partial<MetaFeedbackState>
    // Patch each effectiveness entry for missing new fields
    const eff = (s.effectiveness ?? []).map((e: any) => ({
      augmentType: e.augmentType ?? 'unknown',
      totalInjections: e.totalInjections ?? 0,
      qualitySum: e.qualitySum ?? 0,
      avgQuality: e.avgQuality ?? 5,
      correctionCount: e.correctionCount ?? 0,
      complexitySum: e.complexitySum ?? 0,
      avgComplexity: e.avgComplexity ?? 0,
      recentScores: e.recentScores ?? [],
    }))
    return {
      effectiveness: eff,
      pairEffects: s.pairEffects ?? [],
      globalAvgComplexity: s.globalAvgComplexity ?? 0,
      globalSampleCount: s.globalSampleCount ?? 0,
    }
  }

  // Unrecognized or empty — fresh state
  return {
    effectiveness: [],
    pairEffects: [],
    globalAvgComplexity: 0,
    globalSampleCount: 0,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

export function loadMetaFeedback() {
  const raw = loadJson<any>(META_FEEDBACK_PATH, [])
  state = migrateIfNeeded(raw)
  console.log(`${TAG} loaded: ${state.effectiveness.length} augment types, ${state.pairEffects.length} pair effects`)
}

/**
 * Called after each response quality score is known.
 * @param augments - the list of augment strings that were injected
 * @param quality - the quality score (1-10)
 * @param wasCorrected - was the user's next message a correction?
 */
export function recordAugmentOutcome(augments: string[], quality: number, wasCorrected: boolean) {
  const extractedTypes: { type: string; text: string }[] = []

  for (const augment of augments) {
    const typeMatch = augment.match(/^\[([^\]]+)\]/)
    const augmentType = typeMatch ? typeMatch[1] : 'unknown'
    const complexity = estimateComplexity(augment)

    extractedTypes.push({ type: augmentType, text: augment })

    let entry = state.effectiveness.find(e => e.augmentType === augmentType)
    if (!entry) {
      entry = {
        augmentType,
        totalInjections: 0,
        qualitySum: 0,
        avgQuality: 5,
        correctionCount: 0,
        complexitySum: 0,
        avgComplexity: 0,
        recentScores: [],
      }
      state.effectiveness.push(entry)
    }

    entry.totalInjections++
    entry.qualitySum += quality
    entry.avgQuality = entry.qualitySum / entry.totalInjections
    entry.complexitySum += complexity
    entry.avgComplexity = entry.complexitySum / entry.totalInjections
    if (wasCorrected) entry.correctionCount++

    // Maintain recent scores window
    entry.recentScores.push(quality)
    if (entry.recentScores.length > RECENT_SCORES_CAP) {
      entry.recentScores = entry.recentScores.slice(-RECENT_SCORES_CAP)
    }
  }

  // Update global complexity tracking
  for (const { text } of extractedTypes) {
    const c = estimateComplexity(text)
    state.globalSampleCount++
    state.globalAvgComplexity += (c - state.globalAvgComplexity) / state.globalSampleCount
  }

  // Record pair co-occurrence effects
  const uniqueTypes = [...new Set(extractedTypes.map(e => e.type))]
  if (uniqueTypes.length >= 2) {
    for (let i = 0; i < uniqueTypes.length; i++) {
      for (let j = i + 1; j < uniqueTypes.length; j++) {
        const pairKey = makePairKey(uniqueTypes[i], uniqueTypes[j])
        let pair = state.pairEffects.find(p => p.pair === pairKey)
        if (!pair) {
          pair = { pair: pairKey, coCount: 0, qualitySum: 0, avgQuality: 0 }
          state.pairEffects.push(pair)
        }
        pair.coCount++
        pair.qualitySum += quality
        pair.avgQuality = pair.qualitySum / pair.coCount
      }
    }
  }

  // Enforce limits
  if (state.effectiveness.length > MAX_EFFECTIVENESS) {
    state.effectiveness.sort((a, b) => b.totalInjections - a.totalInjections)
    state.effectiveness = state.effectiveness.slice(0, MAX_EFFECTIVENESS)
  }
  if (state.pairEffects.length > MAX_PAIR_EFFECTS) {
    state.pairEffects.sort((a, b) => b.coCount - a.coCount)
    state.pairEffects = state.pairEffects.slice(0, MAX_PAIR_EFFECTS)
  }

  debouncedSave(META_FEEDBACK_PATH, state)
}

/**
 * Sigmoid-based continuous priority multiplier with difficulty correction.
 * Returns [0.5, 1.5], 1.0 = neutral. Cold start (<10 samples) returns 1.0.
 */
export function getAugmentPriorityMultiplier(augmentType: string): number {
  const entry = state.effectiveness.find(e => e.augmentType === augmentType)
  if (!entry || entry.totalInjections < COLD_START_THRESHOLD) return 1.0

  // Difficulty correction: don't punish augments that appear in hard contexts
  const complexityPenalty = (entry.avgComplexity - state.globalAvgComplexity) * 0.3
  const adjustedQuality = entry.avgQuality - complexityPenalty

  return sigmoidMultiplier(adjustedQuality)
}

/**
 * Get significant pair interaction effects.
 * Returns pairs with >= 5 co-occurrences, sorted by absolute boost magnitude.
 */
export function getPairEffects(): Array<{ pair: string; coCount: number; avgQualityBoost: number }> {
  const results: Array<{ pair: string; coCount: number; avgQualityBoost: number }> = []

  for (const pe of state.pairEffects) {
    if (pe.coCount < 5) continue

    const [typeA, typeB] = pe.pair.split('|')
    const entryA = state.effectiveness.find(e => e.augmentType === typeA)
    const entryB = state.effectiveness.find(e => e.augmentType === typeB)
    if (!entryA || !entryB) continue

    const soloAvg = (entryA.avgQuality + entryB.avgQuality) / 2
    const boost = pe.avgQuality - soloAvg

    // Only report meaningful effects (|boost| > 0.3)
    if (Math.abs(boost) > 0.3) {
      results.push({ pair: pe.pair, coCount: pe.coCount, avgQualityBoost: Math.round(boost * 100) / 100 })
    }
  }

  results.sort((a, b) => Math.abs(b.avgQualityBoost) - Math.abs(a.avgQualityBoost))
  return results
}

/**
 * Detect trends for all augment types with sufficient data.
 * Returns augments whose effectiveness is rising or declining.
 */
export function detectAugmentTrends(): Array<{ augmentType: string; trend: TrendResult; recentAvg: number }> {
  const results: Array<{ augmentType: string; trend: TrendResult; recentAvg: number }> = []

  for (const entry of state.effectiveness) {
    if (entry.recentScores.length < 10) continue
    const trend = detectTrend(entry.recentScores)
    if (trend === 'stable') continue

    const recent = entry.recentScores.slice(-10)
    const recentAvg = Math.round((recent.reduce((s, v) => s + v, 0) / recent.length) * 100) / 100
    results.push({ augmentType: entry.augmentType, trend, recentAvg })
  }

  return results
}

/**
 * Summary for diagnostic/soul prompt — shows learned augment effectiveness,
 * pair synergies, and trend warnings.
 */
export function getMetaFeedbackSummary(): string {
  const meaningful = state.effectiveness.filter(e => e.totalInjections >= COLD_START_THRESHOLD)
  if (meaningful.length === 0) return ''

  const lines: string[] = []

  // Effectiveness tiers using sigmoid value
  const boosted: string[] = []
  const demoted: string[] = []
  for (const e of meaningful) {
    const m = getAugmentPriorityMultiplier(e.augmentType)
    if (m >= 1.15) boosted.push(`${e.augmentType}(×${m.toFixed(2)})`)
    else if (m <= 0.85) demoted.push(`${e.augmentType}(×${m.toFixed(2)})`)
  }
  if (boosted.length) lines.push(`增效 augment: ${boosted.join(', ')}`)
  if (demoted.length) lines.push(`低效 augment: ${demoted.join(', ')}`)

  // Trend warnings
  const trends = detectAugmentTrends()
  const declining = trends.filter(t => t.trend === 'declining')
  const rising = trends.filter(t => t.trend === 'rising')
  if (declining.length) {
    lines.push(`⚠ 效力衰退: ${declining.map(t => `${t.augmentType}(近期均${t.recentAvg})`).join(', ')}`)
  }
  if (rising.length) {
    lines.push(`↑ 效力上升: ${rising.map(t => `${t.augmentType}(近期均${t.recentAvg})`).join(', ')}`)
  }

  // Pair synergies
  const pairs = getPairEffects()
  const synergy = pairs.filter(p => p.avgQualityBoost > 0).slice(0, 3)
  const conflict = pairs.filter(p => p.avgQualityBoost < 0).slice(0, 3)
  if (synergy.length) {
    lines.push(`增效组合: ${synergy.map(p => `${p.pair.replace('|', '+')}(+${p.avgQualityBoost})`).join(', ')}`)
  }
  if (conflict.length) {
    lines.push(`减效组合: ${conflict.map(p => `${p.pair.replace('|', '+')}(${p.avgQualityBoost})`).join(', ')}`)
  }

  return lines.join('\n')
}

// ── SoulModule ──
export const metaFeedbackModule: SoulModule = {
  id: 'meta-feedback',
  name: '反馈学习引擎',
  priority: 50,
  init() { loadMetaFeedback() },
}
