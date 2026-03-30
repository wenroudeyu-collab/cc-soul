/**
 * patterns.ts — Adaptive pattern discovery engine
 *
 * Self-discovers response patterns via LLM free-naming + trigram clustering.
 * Multi-dimensional classification: questionType × emotion × depth × timeSlot.
 * Thompson Sampling (Beta distribution) for explore/exploit balance.
 * Time-based decay to forget stale patterns.
 */

import type { SoulModule } from './brain.ts'
import { SUCCESS_PATTERNS_PATH, loadJson, debouncedSave } from './persistence.ts'
import { spawnCLI } from './cli.ts'
import { TECH_CLASSIFY, EMOTION_CLASSIFY } from './signals.ts'
import { adaptiveDecay } from './memory-utils.ts'

// ── Types ──

interface SuccessPattern {
  patternName: string      // LLM free-named, no fixed set
  questionType: string
  emotion: string          // 'positive' | 'negative' | 'neutral'
  depth: string            // 'short' | 'medium' | 'long'
  timeSlot: string         // 'morning' | 'afternoon' | 'evening' | 'night'
  userId: string
  alpha: number            // Beta distribution: success + 1
  beta: number             // Beta distribution: failure + 1
  lastUsed: number
  description?: string     // LLM short description of the pattern
}

// Old format for migration detection
interface OldPattern {
  questionType: string
  pattern: string
  userId: string
  successCount: number
  lastUsed: number
}

// ── Constants ──

const MAX_PATTERNS = 300
const DECAY_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000   // 90 days
const DELETE_THRESHOLD_MS = 180 * 24 * 60 * 60 * 1000  // 180 days
const TRIGRAM_MERGE_THRESHOLD = 0.6
const DECAY_FACTOR = 0.8
const TAG = '[cc-soul][patterns]'

// ── State ──

let patterns: SuccessPattern[] = []

// ── Trigram utilities ──

function trigrams(s: string): Set<string> {
  const t = new Set<string>()
  const lower = s.toLowerCase()
  for (let i = 0; i <= lower.length - 3; i++) {
    t.add(lower.slice(i, i + 3))
  }
  return t
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let intersection = 0
  for (const x of a) {
    if (b.has(x)) intersection++
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/** Find existing pattern name that is similar enough, or return null */
function findSimilarPatternName(candidate: string): string | null {
  const candidateTri = trigrams(candidate)
  let bestName: string | null = null
  let bestScore = 0

  const seen = new Set<string>()
  for (const p of patterns) {
    if (seen.has(p.patternName)) continue
    seen.add(p.patternName)
    const score = jaccardSimilarity(candidateTri, trigrams(p.patternName))
    if (score > bestScore) {
      bestScore = score
      bestName = p.patternName
    }
  }

  return bestScore >= TRIGRAM_MERGE_THRESHOLD ? bestName : null
}

// ── Classification helpers ──

function classifyQuestionType(msg: string): string {
  const m = msg.toLowerCase()
  if (TECH_CLASSIFY.some(w => m.includes(w))) return 'technical'
  if (EMOTION_CLASSIFY.some(w => m.includes(w))) return 'emotional'
  if (['你觉得', '建议', '你看', '怎么看', '看法', '意见'].some(w => m.includes(w))) return 'opinion'
  if (msg.length < 20) return 'quick'
  if (['帮我', '做', '写', '改', '搞', '处理'].some(w => m.includes(w))) return 'action'
  return 'general'
}

function classifyEmotion(msg: string): string {
  const m = msg.toLowerCase()
  const positive = ['开心', '哈哈', '牛逼', '太棒', '感谢', '谢谢', '厉害', '完美']
  const negative = ['烦', '累', '难过', '焦虑', '压力', '郁闷', '崩溃']
  if (positive.some(w => m.includes(w))) return 'positive'
  if (negative.some(w => m.includes(w))) return 'negative'
  return 'neutral'
}

function classifyDepth(msg: string): string {
  if (msg.length < 30) return 'short'
  if (msg.length <= 200) return 'medium'
  return 'long'
}

function classifyTimeSlot(): string {
  const h = new Date().getHours()
  if (h >= 6 && h < 12) return 'morning'
  if (h >= 12 && h < 18) return 'afternoon'
  if (h >= 18 && h < 23) return 'evening'
  return 'night'
}

// ── Thompson Sampling ──

function betaSample(alpha: number, beta: number): number {
  // Simplified Beta sampling: jitter * mean
  const jitter = 0.8 + Math.random() * 0.4  // [0.8, 1.2]
  return jitter * alpha / (alpha + beta)
}

// ── Usage-Based Decay (使用频率驱动衰减) ──
//
// Delegates to adaptiveDecay() from memory-utils.ts for consistency.
// hitCount=0  → normal decay
// hitCount=5  → decay rate reduced to ~1/3.5
// hitCount=10 → decay rate reduced to ~1/6

/**
 * Compute decay factor for a pattern based on age and usage frequency.
 * Returns value in [0, 1] where 1 = fully alive, 0 = should be deleted.
 */
function computePatternDecay(pattern: SuccessPattern, now: number): number {
  const ageMs = now - (pattern.lastUsed || now)
  // Use alpha as hit count proxy: alpha starts at 1 (prior), each success adds 1
  const hitCount = Math.max(0, pattern.alpha - 1)
  return adaptiveDecay(ageMs, hitCount, DECAY_THRESHOLD_MS, 0.5)
}

function applyDecayAndCleanup() {
  const now = Date.now()
  let changed = false
  const toDelete: number[] = []

  for (let i = patterns.length - 1; i >= 0; i--) {
    const p = patterns[i]
    const age = now - p.lastUsed

    // Skip recently-used patterns (no decay needed)
    if (age <= DECAY_THRESHOLD_MS) continue

    const decay = computePatternDecay(p, now)

    if (decay < 0.1) {
      // Decayed to near-zero → delete
      console.log(`${TAG} deleted decayed pattern: ${p.patternName} (${Math.round(age / 86400000)}d old, α=${p.alpha.toFixed(1)}, decay=${decay.toFixed(3)})`)
      toDelete.push(i)
      changed = true
    } else {
      // Apply usage-based decay to alpha/beta
      p.alpha = Math.max(1, p.alpha * decay)
      p.beta = Math.max(1, p.beta * decay)
      changed = true
    }
  }

  // Remove deleted patterns (iterate in reverse so indices stay valid)
  for (const i of toDelete) {
    patterns.splice(i, 1)
  }

  if (changed) {
    debouncedSave(SUCCESS_PATTERNS_PATH, patterns)
  }
}

// ── Data migration ──

function migrateOldFormat(data: any[]): SuccessPattern[] {
  return data.map(item => {
    // Detect old format: has successCount but no alpha
    if ('successCount' in item && !('alpha' in item)) {
      const old = item as OldPattern
      return {
        patternName: old.pattern,
        questionType: old.questionType,
        emotion: 'neutral',
        depth: 'medium',
        timeSlot: 'afternoon',
        userId: old.userId,
        alpha: (old.successCount || 0) + 1,
        beta: 2,
        lastUsed: old.lastUsed || Date.now(),
        description: undefined,
      } as SuccessPattern
    }
    return item as SuccessPattern
  })
}

// ── Enforce size cap ──

function enforceCapacity() {
  if (patterns.length <= MAX_PATTERNS) return
  // Sort by lastUsed ascending, drop oldest
  patterns.sort((a, b) => a.lastUsed - b.lastUsed)
  const removed = patterns.length - MAX_PATTERNS
  patterns = patterns.slice(removed)
  console.log(`${TAG} capacity enforced: removed ${removed} stale patterns, kept ${patterns.length}`)
}

// ── Multi-dimensional matching with fallback ──

function findMatchingPatterns(
  qType: string, emotion: string, depth: string, timeSlot: string, userId: string,
): SuccessPattern[] {
  // Level 1: exact 4D match
  let matches = patterns.filter(p =>
    p.questionType === qType && p.emotion === emotion &&
    p.depth === depth && p.timeSlot === timeSlot && p.userId === userId,
  )
  if (matches.length > 0) return matches

  // Level 2: drop timeSlot
  matches = patterns.filter(p =>
    p.questionType === qType && p.emotion === emotion &&
    p.depth === depth && p.userId === userId,
  )
  if (matches.length > 0) return matches

  // Level 3: drop depth + timeSlot
  matches = patterns.filter(p =>
    p.questionType === qType && p.emotion === emotion && p.userId === userId,
  )
  if (matches.length > 0) return matches

  // Level 4: questionType + userId only
  matches = patterns.filter(p =>
    p.questionType === qType && p.userId === userId,
  )
  return matches
}

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════════════════════

export function loadPatterns() {
  const raw = loadJson<any[]>(SUCCESS_PATTERNS_PATH, [])
  patterns = migrateOldFormat(raw)

  // Migrate might have changed format, save back
  if (raw.length > 0 && raw.some((item: any) => 'successCount' in item && !('alpha' in item))) {
    debouncedSave(SUCCESS_PATTERNS_PATH, patterns)
    console.log(`${TAG} migrated ${raw.length} patterns from old format`)
  }

  applyDecayAndCleanup()
  console.log(`${TAG} loaded ${patterns.length} patterns`)
}

export function learnSuccessPattern(question: string, response: string, userId: string) {
  spawnCLI(
    `分析这个成功的回复用了什么结构模式，用一个简短的英文下划线命名（如 code_first, empathy_then_advice, analogy_explain, challenge_back 等，可自由命名）：\n` +
    `问题: "${question.slice(0, 150)}"\n回复: "${response.slice(0, 300)}"\n\n` +
    `格式要求（严格遵守）:\n第一行: 模式名（纯英文下划线，如 direct_answer）\n第二行: 一句话中文描述（如"直接给答案不废话"）`,
    (output) => {
      const lines = output.trim().split('\n').filter(l => l.trim())
      if (lines.length === 0) return

      let rawName = lines[0].trim().toLowerCase().replace(/[^a-z_]/g, '')
      if (!rawName || rawName.length < 3) return

      const description = lines.length > 1 ? lines[1].trim() : undefined

      // Trigram clustering: merge similar names
      const existingName = findSimilarPatternName(rawName)
      const patternName = existingName || rawName

      if (existingName && existingName !== rawName) {
        console.log(`${TAG} merged "${rawName}" → "${existingName}" (trigram similarity)`)
      }

      const qType = classifyQuestionType(question)
      const emotion = classifyEmotion(question)
      const depth = classifyDepth(question)
      const timeSlot = classifyTimeSlot()

      const existing = patterns.find(
        p => p.patternName === patternName &&
          p.questionType === qType && p.emotion === emotion &&
          p.depth === depth && p.timeSlot === timeSlot &&
          p.userId === userId,
      )

      if (existing) {
        existing.alpha++
        existing.lastUsed = Date.now()
        if (description && !existing.description) existing.description = description
      } else {
        patterns.push({
          patternName,
          questionType: qType,
          emotion,
          depth,
          timeSlot,
          userId,
          alpha: 2,  // 1 prior + 1 success
          beta: 1,
          lastUsed: Date.now(),
          description,
        })
      }

      enforceCapacity()
      debouncedSave(SUCCESS_PATTERNS_PATH, patterns)

      const e = existing
      console.log(`${TAG} learned: ${qType}/${emotion}/${depth}→${patternName} for ${userId.slice(0, 8)} (α=${e ? e.alpha : 2})`)
    },
  )
}

export function getBestPattern(question: string, userId: string): string {
  const qType = classifyQuestionType(question)
  const emotion = classifyEmotion(question)
  const depth = classifyDepth(question)
  const timeSlot = classifyTimeSlot()

  const candidates = findMatchingPatterns(qType, emotion, depth, timeSlot, userId)
  if (candidates.length === 0) return ''

  // Thompson Sampling: sample from Beta(alpha, beta) for each candidate
  let bestCandidate: SuccessPattern | null = null
  let bestSample = -1

  for (const c of candidates) {
    const sample = betaSample(c.alpha, c.beta)
    if (sample > bestSample) {
      bestSample = sample
      bestCandidate = c
    }
  }

  if (!bestCandidate) return ''

  const desc = bestCandidate.description || bestCandidate.patternName
  const confidence = (bestCandidate.alpha / (bestCandidate.alpha + bestCandidate.beta) * 100).toFixed(0)
  return `[成功模式] 这类问题对该用户用 "${desc}" 效果好（置信度${confidence}%，α=${bestCandidate.alpha.toFixed(1)}）`
}

export function getPatternStats(): {
  total: number
  uniquePatterns: number
  topPatterns: Array<{ name: string; totalAlpha: number; users: number }>
  dimensionCoverage: { questionTypes: string[]; emotions: string[]; depths: string[]; timeSlots: string[] }
} {
  const nameMap = new Map<string, { totalAlpha: number; users: Set<string> }>()
  for (const p of patterns) {
    const entry = nameMap.get(p.patternName) || { totalAlpha: 0, users: new Set() }
    entry.totalAlpha += p.alpha
    entry.users.add(p.userId)
    nameMap.set(p.patternName, entry)
  }

  const topPatterns = [...nameMap.entries()]
    .map(([name, v]) => ({ name, totalAlpha: Math.round(v.totalAlpha * 10) / 10, users: v.users.size }))
    .sort((a, b) => b.totalAlpha - a.totalAlpha)
    .slice(0, 10)

  return {
    total: patterns.length,
    uniquePatterns: nameMap.size,
    topPatterns,
    dimensionCoverage: {
      questionTypes: [...new Set(patterns.map(p => p.questionType))],
      emotions: [...new Set(patterns.map(p => p.emotion))],
      depths: [...new Set(patterns.map(p => p.depth))],
      timeSlots: [...new Set(patterns.map(p => p.timeSlot))],
    },
  }
}

// ── SoulModule ──
export const patternsModule: SoulModule = {
  id: 'patterns',
  name: '自适应模式发现',
  priority: 50,
  init() { loadPatterns() },
}
