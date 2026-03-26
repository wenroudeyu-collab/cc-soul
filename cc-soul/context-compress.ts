/**
 * context-compress.ts — 渐进式上下文压缩
 *
 * 基于 Anthropic ACON 论文思路：记忆/增强按年龄自动分三级
 *   verbatim（原文）→ summary（摘要）→ compressed fact（压缩事实）
 *
 * 压缩规则：
 *   < 5 分钟：verbatim，不压缩
 *   5分钟 ~ 1小时：summary，压缩到原长 50%
 *   > 1小时：compressed fact，压缩到原长 20%
 */

import type { SoulModule } from './brain.ts'

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface TimedAugment {
  content: string
  priority: number
  tokens: number
  ts?: number // timestamp — undefined = now
}

export interface CompressedAugment {
  content: string
  priority: number
  tokens: number
}

export type CompressionTier = 'verbatim' | 'summary' | 'compressed_fact'

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const FIVE_MINUTES_MS = 5 * 60 * 1000
const ONE_HOUR_MS = 60 * 60 * 1000

// ═══════════════════════════════════════════════════════════════════════════════
// TIER CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

/** Determine compression tier based on age */
export function classifyTier(ts: number | undefined, now: number): CompressionTier {
  if (ts == null) return 'verbatim'
  const age = now - ts
  if (age < FIVE_MINUTES_MS) return 'verbatim'
  if (age < ONE_HOUR_MS) return 'summary'
  return 'compressed_fact'
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPRESSION STRATEGIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Summary 策略：保留首句+末句，中间用"..."连接。
 * 目标：压缩到原长 ~50%
 */
export function summarize(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return trimmed

  // Split into sentences — handle Chinese (。！？) and English (.!?)
  const sentences = trimmed.split(/(?<=[。！？!?\.\n])\s*/).filter(s => s.trim())
  if (sentences.length <= 2) return trimmed

  const first = sentences[0].trim()
  const last = sentences[sentences.length - 1].trim()

  const result = `${first} ... ${last}`

  // If result is already >= 50% of original, return as-is
  // If result is too short (< 50%), include more sentences from the start
  const targetLen = Math.ceil(trimmed.length * 0.5)
  if (result.length >= targetLen) return result

  // Add more sentences from the beginning until we reach ~50%
  let built = first
  for (let i = 1; i < sentences.length - 1; i++) {
    const candidate = `${built} ${sentences[i].trim()} ... ${last}`
    if (candidate.length >= targetLen) {
      return candidate
    }
    built = `${built} ${sentences[i].trim()}`
  }
  return `${built} ... ${last}`
}

/**
 * Compressed fact 策略：只保留关键名词/动词/数字。
 * 目标：压缩到原长 ~20%
 */
export function compressFact(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return trimmed

  // Extract key tokens: CJK words, English words, numbers, code identifiers
  const tokens: string[] = []

  // Match: numbers (with units), code identifiers (snake_case, camelCase, dot.paths),
  // CJK key nouns/verbs, capitalized English words, quoted strings
  const patterns = [
    /\d[\d.,]*[%kmgtbKMGTB]?(?:\s*(?:秒|分|小时|天|条|个|次|行|MB|GB|ms|s|min|px|em|rem))?/g,
    /[A-Z][a-zA-Z]+(?:\.[a-zA-Z]+)*/g,                      // PascalCase / dotted paths
    /[a-z][a-zA-Z]*(?:_[a-zA-Z]+)+/g,                        // snake_case
    /`[^`]+`/g,                                                // inline code
    /"[^"]{1,30}"/g,                                           // short quoted strings
    /[\u4e00-\u9fff]{2,}/g,                                    // CJK word sequences (2+ chars)
  ]

  const seen = new Set<string>()
  for (const pat of patterns) {
    let m: RegExpExecArray | null
    // Reset lastIndex for global patterns
    pat.lastIndex = 0
    while ((m = pat.exec(trimmed)) !== null) {
      const tok = m[0].trim()
      if (tok && !seen.has(tok)) {
        seen.add(tok)
        tokens.push(tok)
      }
    }
  }

  if (tokens.length === 0) {
    // Fallback: take first 20% of characters
    return trimmed.slice(0, Math.max(1, Math.ceil(trimmed.length * 0.2)))
  }

  // Sort tokens by their order of appearance in original text
  tokens.sort((a, b) => trimmed.indexOf(a) - trimmed.indexOf(b))

  // Join and trim to ~20% of original length
  const targetLen = Math.max(1, Math.ceil(trimmed.length * 0.2))
  let result = ''
  for (const tok of tokens) {
    const next = result ? `${result} ${tok}` : tok
    if (next.length > targetLen * 1.5) break // allow slight overshoot
    result = next
  }

  return result || tokens[0]
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPRESS FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 对 augments 做渐进压缩：
 * - < 5 分钟：verbatim，不压缩
 * - 5分钟 ~ 1小时：summary，压缩到原长 50%
 * - > 1小时：compressed fact，压缩到原长 20%
 */
export function compressAugments(
  augments: TimedAugment[],
): CompressedAugment[] {
  const now = Date.now()
  return augments.map(aug => {
    const tier = classifyTier(aug.ts, now)
    switch (tier) {
      case 'verbatim':
        return { content: aug.content, priority: aug.priority, tokens: aug.tokens }
      case 'summary': {
        const compressed = summarize(aug.content)
        const ratio = aug.content.length > 0 ? compressed.length / aug.content.length : 1
        return {
          content: compressed,
          priority: aug.priority,
          tokens: Math.ceil(aug.tokens * ratio),
        }
      }
      case 'compressed_fact': {
        const compressed = compressFact(aug.content)
        const ratio = aug.content.length > 0 ? compressed.length / aug.content.length : 1
        return {
          content: compressed,
          priority: aug.priority,
          tokens: Math.ceil(aug.tokens * ratio),
        }
      }
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOKEN SAVINGS ESTIMATOR
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate token savings from compression.
 */
export function estimateTokenSavings(
  original: number,
  compressed: number,
): { saved: number; ratio: number } {
  const saved = original - compressed
  const ratio = original > 0 ? saved / original : 0
  return { saved, ratio: Math.round(ratio * 1000) / 1000 }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOUL MODULE
// ═══════════════════════════════════════════════════════════════════════════════

export const contextCompressModule: SoulModule = {
  id: 'context-compress',
  name: '渐进式上下文压缩',
  priority: 30, // runs early so other modules see compressed augments

  onPreprocessed(event: any) {
    // If event carries augments with timestamps, compress them
    if (!event?.augments || !Array.isArray(event.augments)) return
    const timedAugments: TimedAugment[] = event.augments
      .filter(
        (a: any) => a && typeof a.content === 'string' && typeof a.ts === 'number',
      )
      .map((a: any) => ({
        ...a,
        priority: typeof a.priority === 'number' ? a.priority : 5,
        tokens: typeof a.tokens === 'number' ? a.tokens : Math.ceil(a.content.length * 0.75),
      }))
    if (timedAugments.length === 0) return

    const compressed = compressAugments(timedAugments)
    const totalOriginal = timedAugments.reduce((s, a) => s + a.tokens, 0)
    const totalCompressed = compressed.reduce((s, a) => s + a.tokens, 0)

    // Return compressed augments as injection
    if (totalCompressed < totalOriginal) {
      const { saved, ratio } = estimateTokenSavings(totalOriginal, totalCompressed)
      return [{
        content: `[context-compress] 压缩了 ${timedAugments.length} 条增强，节省 ${saved} tokens (${(ratio * 100).toFixed(1)}%)`,
        priority: 1,
        tokens: 20,
      }]
    }
  },
}
