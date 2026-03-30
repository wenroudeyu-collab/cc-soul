/**
 * fingerprint.ts — Soul Fingerprint (personality consistency monitor)
 *
 * Tracks cc's reply style statistics and detects when a response
 * deviates from the established pattern (personality drift).
 */

import { resolve } from 'path'
import type { SoulModule } from './brain.ts'
import { DATA_DIR, loadJson, debouncedSave } from './persistence.ts'
import { getParam } from './auto-tune.ts'

const FINGERPRINT_PATH = resolve(DATA_DIR, 'fingerprint.json')

/** Welford's online stats tracker for 3-sigma anomaly detection */
interface WelfordStats {
  mean: number
  m2: number      // sum of squared deviations (for variance)
  count: number
}

function updateWelford(stats: WelfordStats, newValue: number) {
  stats.count++
  const delta = newValue - stats.mean
  stats.mean += delta / stats.count
  const delta2 = newValue - stats.mean
  stats.m2 += delta * delta2
}

function getStddev(stats: WelfordStats): number {
  return stats.count > 1 ? Math.sqrt(stats.m2 / (stats.count - 1)) : 0
}

function ensureWelford(stats: WelfordStats | undefined): WelfordStats {
  if (stats && typeof stats.m2 === 'number') return stats
  return { mean: 0, m2: 0, count: 0 }
}

/**
 * 自适应异常检测：替代固定 3-sigma
 * 当样本少时（<20），放宽阈值（减少误报）
 * 当样本多时（>50），收紧阈值（更精确）
 * 用自适应 sigma 系数，对小样本更鲁棒
 */
function isAnomaly(value: number, mean: number, stddev: number, sampleCount: number): boolean {
  if (sampleCount < 5) return false  // 数据不够，不判定
  // 自适应系数：样本越多越严格
  const adaptiveSigma = 2.5 + 1.5 / Math.sqrt(sampleCount)  // 5样本→3.17σ，50样本→2.71σ，200样本→2.61σ
  return Math.abs(value - mean) > adaptiveSigma * Math.max(stddev, 0.01)
}

/**
 * 趋势感知漂移检测：不只看单次离群，还看连续方向
 * 如果连续 5 次都偏高（即使每次都在阈值内），也算漂移
 */
function detectTrend(recentValues: number[], mean: number): 'stable' | 'drifting_up' | 'drifting_down' {
  if (recentValues.length < 5) return 'stable'
  const last5 = recentValues.slice(-5)
  const aboveMean = last5.filter(v => v > mean).length
  if (aboveMean >= 4) return 'drifting_up'
  if (aboveMean <= 1) return 'drifting_down'
  return 'stable'
}

interface StyleFingerprint {
  avgLength: number           // average reply length
  avgSentenceLength: number   // average sentence length
  questionRatio: number       // how often cc asks questions back
  codeBlockRatio: number      // how often replies contain code
  emojiRatio: number          // emoji usage frequency
  firstPersonRatio: number    // "我" usage
  samples: number             // how many replies analyzed
  lastUpdated: number
  // Welford stats for adaptive anomaly detection
  lengthStats?: WelfordStats
  sentenceLengthStats?: WelfordStats
  // 趋势检测：最近回复长度序列
  recentLengths?: number[]
  recentSentenceLengths?: number[]
}

let fingerprint: StyleFingerprint = loadJson<StyleFingerprint>(FINGERPRINT_PATH, {
  avgLength: 0,
  avgSentenceLength: 0,
  questionRatio: 0,
  codeBlockRatio: 0,
  emojiRatio: 0,
  firstPersonRatio: 0,
  samples: 0,
  lastUpdated: 0,
})

function saveFingerprint() {
  debouncedSave(FINGERPRINT_PATH, fingerprint)
}

/**
 * Analyze a response and update the fingerprint (EMA smoothing).
 */
export function updateFingerprint(response: string) {
  if (!response || response.length < 10) return

  const alpha = fingerprint.samples < 50 ? 0.2 : 0.05 // faster learning early

  const length = response.length
  const sentences = response.split(/[。！？!?.\n]+/).filter(s => s.trim().length > 0)
  const avgSentLen = sentences.length > 0 ? length / sentences.length : length
  const hasQuestion = /[？?]/.test(response) ? 1 : 0
  const hasCode = response.includes('```') ? 1 : 0
  const hasEmoji = /[\u{1F300}-\u{1FAFF}]|[😀-🙏]/u.test(response) ? 1 : 0
  const firstPerson = (response.match(/我/g) || []).length / Math.max(1, response.length / 100)

  fingerprint.avgLength = fingerprint.avgLength * (1 - alpha) + length * alpha
  fingerprint.avgSentenceLength = fingerprint.avgSentenceLength * (1 - alpha) + avgSentLen * alpha
  fingerprint.questionRatio = fingerprint.questionRatio * (1 - alpha) + hasQuestion * alpha
  fingerprint.codeBlockRatio = fingerprint.codeBlockRatio * (1 - alpha) + hasCode * alpha
  fingerprint.emojiRatio = fingerprint.emojiRatio * (1 - alpha) + hasEmoji * alpha
  fingerprint.firstPersonRatio = fingerprint.firstPersonRatio * (1 - alpha) + firstPerson * alpha

  // Update Welford stats for adaptive anomaly detection
  fingerprint.lengthStats = ensureWelford(fingerprint.lengthStats)
  fingerprint.sentenceLengthStats = ensureWelford(fingerprint.sentenceLengthStats)
  updateWelford(fingerprint.lengthStats, length)
  updateWelford(fingerprint.sentenceLengthStats, avgSentLen)

  // 追踪最近值用于趋势检测
  if (!fingerprint.recentLengths) fingerprint.recentLengths = []
  fingerprint.recentLengths.push(length)
  if (fingerprint.recentLengths.length > 20) fingerprint.recentLengths.shift()

  if (!fingerprint.recentSentenceLengths) fingerprint.recentSentenceLengths = []
  fingerprint.recentSentenceLengths.push(avgSentLen)
  if (fingerprint.recentSentenceLengths.length > 20) fingerprint.recentSentenceLengths.shift()

  fingerprint.samples++
  fingerprint.lastUpdated = Date.now()

  saveFingerprint()
}

/**
 * Check if a response matches cc's established fingerprint.
 * Returns deviation warning or empty string.
 */
export function checkPersonaConsistency(response: string): string {
  if (fingerprint.samples < 30) return '' // need enough data first

  const issues: string[] = []

  // Length deviation — adaptive anomaly detection with trend awareness
  const lenStats = ensureWelford(fingerprint.lengthStats)
  const lenStddev = getStddev(lenStats)
  if (lenStddev > 0 && lenStats.count > 5) {
    // 自适应阈值检测（替代固定 3-sigma）
    if (isAnomaly(response.length, lenStats.mean, lenStddev, lenStats.count)) {
      if (response.length > lenStats.mean) {
        issues.push('回复异常长')
      } else if (response.length > 5) {
        issues.push('回复异常短')
      }
    }
    // 趋势漂移检测
    const lengthTrend = detectTrend(fingerprint.recentLengths || [], lenStats.mean)
    if (lengthTrend === 'drifting_up') {
      issues.push('回复长度持续偏高（趋势漂移）')
    } else if (lengthTrend === 'drifting_down') {
      issues.push('回复长度持续偏低（趋势漂移）')
    }
  } else {
    // Fallback: legacy hardcoded thresholds (insufficient Welford data)
    if (response.length > fingerprint.avgLength * getParam('fingerprint.length_upper_multiplier')) {
      issues.push('回复异常长')
    }
    if (response.length < fingerprint.avgLength * getParam('fingerprint.length_lower_multiplier') && response.length > 5) {
      issues.push('回复异常短')
    }
  }

  // AI identity leak detection
  if (/作为一个?AI|作为语言模型|作为人工智能|I am an AI|as an AI/i.test(response)) {
    issues.push('人设泄露：提到了AI身份')
  }

  // Excessive hedging (deviation from normal confidence)
  const hedgeWords = (response.match(/可能|也许|或许|不太确定|我不确定|大概/g) || []).length
  if (hedgeWords > getParam('fingerprint.hedge_word_limit')) {
    issues.push('过度犹豫')
  }

  if (issues.length === 0) return ''
  return `[风格偏离] ${issues.join('；')}`
}

/**
 * Get fingerprint summary for soul prompt.
 */
export function getFingerprintSummary(): string {
  if (fingerprint.samples < 20) return ''
  return `[回复风格基线] 平均长度${Math.round(fingerprint.avgLength)}字 | ` +
    `提问率${(fingerprint.questionRatio * 100).toFixed(0)}% | ` +
    `代码率${(fingerprint.codeBlockRatio * 100).toFixed(0)}% | ` +
    `样本${fingerprint.samples}条`
}

export function loadFingerprint() {
  const loaded = loadJson<StyleFingerprint>(FINGERPRINT_PATH, fingerprint)
  Object.assign(fingerprint, loaded)
}

let cachedDriftWarning = ''

export function getCachedDriftWarning(): string {
  const warning = cachedDriftWarning
  cachedDriftWarning = ''
  return warning
}

export function setCachedDriftWarning(warning: string) {
  cachedDriftWarning = warning
}

// ── SoulModule ──
export const fingerprintModule: SoulModule = {
  id: 'fingerprint',
  name: '灵魂指纹',
  priority: 50,
  features: ['fingerprint'],
  init() { loadFingerprint() },
}
