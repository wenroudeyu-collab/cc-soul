/**
 * llm-judge.ts — LLM-as-Judge 自评
 *
 * Uses LLM to evaluate its own reply quality (1-10 scale).
 * Maintains a sliding window of recent 50 scores with trend detection.
 * Persisted to data/llm_judge.json.
 */

import type { SoulModule } from './brain.ts'
import { resolve } from 'path'
import { DATA_DIR, loadJson, debouncedSave } from './persistence.ts'
import { spawnCLI } from './cli.ts'
import { extractJSON } from './utils.ts'

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const JUDGE_PATH = resolve(DATA_DIR, 'llm_judge.json')
const TAG = '[cc-soul][llm-judge]'
const WINDOW_SIZE = 50

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface JudgeEntry {
  score: number
  feedback: string
  ts: number
}

interface JudgeState {
  entries: JudgeEntry[]
  totalJudged: number
}

export interface JudgeStats {
  avgScore: number
  totalJudged: number
  recentTrend: 'improving' | 'stable' | 'declining'
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let state: JudgeState = {
  entries: [],
  totalJudged: 0,
}

function persist() {
  debouncedSave(JUDGE_PATH, state)
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ask LLM to judge a bot reply. Calls back with (score, feedback).
 */
export function judgeSelfReply(
  userMsg: string,
  botReply: string,
  callback: (score: number, feedback: string) => void
): void {
  const prompt = `请评估以下回复的质量（1-10分），考虑：准确性、有用性、语气匹配、简洁度。只输出JSON：{"score":N,"feedback":"一句话"}\n用户：${userMsg}\n回复：${botReply}`

  spawnCLI(prompt, (output) => {
    try {
      const parsed = extractJSON(output)
      if (!parsed || typeof parsed.score !== 'number') {
        console.log(`${TAG} failed to parse judge output`)
        callback(5, 'parse_error')
        return
      }

      const score = Math.max(1, Math.min(10, Math.round(parsed.score)))
      const feedback = typeof parsed.feedback === 'string' ? parsed.feedback : ''

      // Add to sliding window
      state.entries.push({ score, feedback, ts: Date.now() })
      if (state.entries.length > WINDOW_SIZE) {
        state.entries = state.entries.slice(-WINDOW_SIZE)
      }
      state.totalJudged++
      persist()

      callback(score, feedback)
    } catch (e: any) {
      console.log(`${TAG} judge error: ${e.message}`)
      callback(5, 'error')
    }
  }, 30000, 'llm-judge')
}

/**
 * Get aggregate judge statistics with trend detection.
 */
export function getJudgeStats(): JudgeStats {
  const entries = state.entries
  if (entries.length === 0) {
    return { avgScore: 0, totalJudged: state.totalJudged, recentTrend: 'stable' }
  }

  const avgScore = entries.reduce((sum, e) => sum + e.score, 0) / entries.length

  // Trend: compare first half avg vs second half avg
  let trend: 'improving' | 'stable' | 'declining' = 'stable'
  if (entries.length >= 6) {
    const mid = Math.floor(entries.length / 2)
    const firstHalf = entries.slice(0, mid)
    const secondHalf = entries.slice(mid)
    const firstAvg = firstHalf.reduce((s, e) => s + e.score, 0) / firstHalf.length
    const secondAvg = secondHalf.reduce((s, e) => s + e.score, 0) / secondHalf.length
    const diff = secondAvg - firstAvg
    if (diff > 0.5) trend = 'improving'
    else if (diff < -0.5) trend = 'declining'
  }

  return {
    avgScore: Math.round(avgScore * 100) / 100,
    totalJudged: state.totalJudged,
    recentTrend: trend,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODULE
// ═══════════════════════════════════════════════════════════════════════════════

export const llmJudgeModule: SoulModule = {
  id: 'llm-judge',
  name: 'LLM自评',
  priority: 20,
  features: ['llm_judge'],

  init() {
    state = loadJson(JUDGE_PATH, { entries: [], totalJudged: 0 })
    // Ensure entries array is capped
    if (state.entries.length > WINDOW_SIZE) {
      state.entries = state.entries.slice(-WINDOW_SIZE)
    }
    console.log(`${TAG} loaded ${state.entries.length} entries, total judged: ${state.totalJudged}`)
  },

  dispose() {
    persist()
  },

  onSent(event: any) {
    // Auto-judge every reply if module is active
    const userMsg = event?.userMessage || event?.content || ''
    const botReply = event?.botReply || event?.response || ''
    if (!userMsg || !botReply) return

    judgeSelfReply(userMsg, botReply, (score, feedback) => {
      console.log(`${TAG} score=${score} feedback="${feedback}"`)
    })
  },
}
