/**
 * theory-of-mind.ts — Theory of Mind（用户认知模型）
 *
 * Goes beyond user-profiles to build a cognitive model of what the user
 * believes, knows, misunderstands, wants, and finds frustrating.
 * Pure rule-based detection — no LLM calls.
 * Persisted to data/theory_of_mind.json.
 */

import type { SoulModule } from './brain.ts'
import type { Augment } from './types.ts'
import { resolve } from 'path'
import { DATA_DIR, loadJson, debouncedSave } from './persistence.ts'

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const TOM_PATH = resolve(DATA_DIR, 'theory_of_mind.json')
const TAG = '[cc-soul][theory-of-mind]'
const MAX_BELIEFS = 100
const MAX_KNOWLEDGE = 200
const MAX_GOALS = 20
const MAX_FRUSTRATIONS = 20

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface Belief {
  value: string
  confidence: number   // 0-1
  source: string       // e.g. "user said", "inferred from correction"
  ts: number
}

type KnowledgeLevel = 'knows' | 'unsure' | 'misconception'

interface KnowledgeEntry {
  topic: string
  level: KnowledgeLevel
  detail?: string      // what the misconception is, if applicable
  ts: number
}

export interface CognitiveModel {
  beliefs: Record<string, Belief>
  knowledge: Record<string, KnowledgeEntry>
  goals: string[]
  frustrations: string[]
}

interface ToMState {
  model: CognitiveModel
  /** Topics we corrected the user on — used to detect repeat misconceptions */
  corrections: { topic: string; correctInfo: string; ts: number }[]
  /** Recent message topics for detecting knowledge gaps (consecutive same-topic questions) */
  recentTopics: { topic: string; ts: number }[]
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let state: ToMState = {
  model: { beliefs: {}, knowledge: {}, goals: [], frustrations: [] },
  corrections: [],
  recentTopics: [],
}

function persist() {
  debouncedSave(TOM_PATH, state)
}

// ═══════════════════════════════════════════════════════════════════════════════
// BELIEF PATTERNS (rule-based, no LLM)
// ═══════════════════════════════════════════════════════════════════════════════

const BELIEF_PATTERNS: { regex: RegExp; extractor: (match: RegExpMatchArray) => { key: string; value: string } }[] = [
  {
    regex: /我以为(.+?)(?:[，。！？]|$)/,
    extractor: (m) => ({ key: m[1].trim().slice(0, 30), value: `用户以为：${m[1].trim()}` }),
  },
  {
    regex: /我觉得(.+?)(?:[，。！？]|$)/,
    extractor: (m) => ({ key: m[1].trim().slice(0, 30), value: `用户认为：${m[1].trim()}` }),
  },
  {
    regex: /难道不是(.+?)(?:[？?]|$)/,
    extractor: (m) => ({ key: m[1].trim().slice(0, 30), value: `用户质疑：难道不是${m[1].trim()}` }),
  },
  {
    regex: /I (?:thought|think|believe|assumed)\s+(.+?)(?:[.,!?]|$)/i,
    extractor: (m) => ({ key: m[1].trim().slice(0, 30), value: `User believes: ${m[1].trim()}` }),
  },
  {
    regex: /isn't it\s+(.+?)(?:[?]|$)/i,
    extractor: (m) => ({ key: m[1].trim().slice(0, 30), value: `User questions: isn't it ${m[1].trim()}` }),
  },
]

const FRUSTRATION_PATTERNS = [
  /为什么(总是|又|还是|一直)/,
  /太(慢|烦|复杂|难用)了/,
  /搞不(懂|定|明白)/,
  /受不了/,
  /why (does it|is it) (always|still|again)/i,
  /so (frustrat|annoy|confus)/i,
  /doesn't (work|make sense)/i,
]

const GOAL_PATTERNS: { regex: RegExp; extractor: (match: RegExpMatchArray) => string }[] = [
  { regex: /我想(要)?(.+?)(?:[，。！？]|$)/, extractor: (m) => m[2].trim() },
  { regex: /我需要(.+?)(?:[，。！？]|$)/, extractor: (m) => m[1].trim() },
  { regex: /帮我(.+?)(?:[，。！？]|$)/, extractor: (m) => m[1].trim() },
  { regex: /I want to\s+(.+?)(?:[.,!?]|$)/i, extractor: (m) => m[1].trim() },
  { regex: /I need\s+(.+?)(?:[.,!?]|$)/i, extractor: (m) => m[1].trim() },
]

// ═══════════════════════════════════════════════════════════════════════════════
// CORE API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Analyze a user message + bot reply to update the cognitive model.
 */
export function updateBeliefFromMessage(msg: string, botReply: string): void {
  if (!msg) return

  // 1. Extract beliefs
  for (const pat of BELIEF_PATTERNS) {
    const match = msg.match(pat.regex)
    if (match) {
      const { key, value } = pat.extractor(match)
      state.model.beliefs[key] = {
        value,
        confidence: 0.7,
        source: 'user_stated',
        ts: Date.now(),
      }
    }
  }

  // 2. Detect frustrations
  for (const pat of FRUSTRATION_PATTERNS) {
    if (pat.test(msg)) {
      const snippet = msg.slice(0, 60)
      if (!state.model.frustrations.includes(snippet)) {
        state.model.frustrations.push(snippet)
        if (state.model.frustrations.length > MAX_FRUSTRATIONS) {
          state.model.frustrations.shift()
        }
      }
      break
    }
  }

  // 3. Extract goals
  for (const pat of GOAL_PATTERNS) {
    const match = msg.match(pat.regex)
    if (match) {
      const goal = pat.extractor(match)
      if (goal.length > 2 && !state.model.goals.includes(goal)) {
        state.model.goals.push(goal)
        if (state.model.goals.length > MAX_GOALS) {
          state.model.goals.shift()
        }
      }
    }
  }

  // 4. Detect corrections in bot reply → mark misconception
  const correctionPatterns = [
    /实际上/,
    /其实/,
    /不是.*而是/,
    /纠正/,
    /actually/i,
    /correction/i,
    /that's not quite right/i,
  ]
  for (const pat of correctionPatterns) {
    if (pat.test(botReply)) {
      // Extract topic from user message (first 30 chars as key)
      const topic = msg.slice(0, 30).trim()
      state.corrections.push({ topic, correctInfo: botReply.slice(0, 100), ts: Date.now() })
      if (state.corrections.length > 50) state.corrections.shift()

      state.model.knowledge[topic] = {
        topic,
        level: 'misconception',
        detail: botReply.slice(0, 100),
        ts: Date.now(),
      }
      break
    }
  }

  // 5. Track topic for knowledge gap detection
  const topicKey = extractTopic(msg)
  if (topicKey) {
    state.recentTopics.push({ topic: topicKey, ts: Date.now() })
    if (state.recentTopics.length > 30) state.recentTopics.shift()

    // If same topic appears 3+ times in recent 10 messages → knowledge gap
    const recent10 = state.recentTopics.slice(-10)
    const count = recent10.filter((t) => t.topic === topicKey).length
    if (count >= 3 && state.model.knowledge[topicKey]?.level !== 'misconception') {
      state.model.knowledge[topicKey] = {
        topic: topicKey,
        level: 'unsure',
        detail: `User asked about "${topicKey}" ${count} times recently`,
        ts: Date.now(),
      }
    }
  }

  // Cap sizes
  capBeliefs()
  capKnowledge()
  persist()
}

/**
 * Check if user message contains a likely misconception based on past corrections.
 */
export function detectMisconception(msg: string): string | null {
  if (!msg || state.corrections.length === 0) return null

  const lower = msg.toLowerCase()
  for (const c of state.corrections) {
    // If user mentions the same topic again with belief-like language
    const topicLower = c.topic.toLowerCase()
    if (topicLower.length > 3 && lower.includes(topicLower)) {
      // Check for belief indicators
      if (/我以为|我觉得|难道不是|i think|i thought|isn't it/i.test(msg)) {
        return `用户可能仍然认为关于"${c.topic}"的错误信息。上次纠正：${c.correctInfo}`
      }
    }
  }
  return null
}

/**
 * Generate a context string for prompt injection summarizing the user's cognitive state.
 */
export function getToMContext(): string {
  const parts: string[] = []

  // Misconceptions
  const misconceptions = Object.values(state.model.knowledge).filter((k) => k.level === 'misconception')
  if (misconceptions.length > 0) {
    const items = misconceptions.slice(-3).map((k) => `- ${k.topic}: ${k.detail || ''}`)
    parts.push(`[用户曾有的错误认知]\n${items.join('\n')}`)
  }

  // Knowledge gaps
  const gaps = Object.values(state.model.knowledge).filter((k) => k.level === 'unsure')
  if (gaps.length > 0) {
    const items = gaps.slice(-3).map((k) => `- ${k.topic}`)
    parts.push(`[用户不太确定的领域]\n${items.join('\n')}`)
  }

  // Active beliefs
  const beliefs = Object.values(state.model.beliefs).sort((a, b) => b.ts - a.ts).slice(0, 3)
  if (beliefs.length > 0) {
    const items = beliefs.map((b) => `- ${b.value}`)
    parts.push(`[用户当前信念]\n${items.join('\n')}`)
  }

  // Frustrations
  if (state.model.frustrations.length > 0) {
    const items = state.model.frustrations.slice(-3).map((f) => `- ${f}`)
    parts.push(`[用户感到沮丧的事]\n${items.join('\n')}`)
  }

  // Goals
  if (state.model.goals.length > 0) {
    const items = state.model.goals.slice(-3).map((g) => `- ${g}`)
    parts.push(`[用户目标]\n${items.join('\n')}`)
  }

  return parts.join('\n')
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function extractTopic(msg: string): string {
  // Simple: use first meaningful segment (strip common prefixes)
  const cleaned = msg
    .replace(/^(请问|你好|hey|hi|hello|帮我|我想|能不能)\s*/i, '')
    .replace(/[？?！!。.，,]+$/, '')
    .trim()
  // Take first 20 chars as topic key
  return cleaned.slice(0, 20)
}

function capBeliefs() {
  const keys = Object.keys(state.model.beliefs)
  if (keys.length > MAX_BELIEFS) {
    const sorted = keys.sort(
      (a, b) => (state.model.beliefs[a]?.ts || 0) - (state.model.beliefs[b]?.ts || 0)
    )
    for (let i = 0; i < sorted.length - MAX_BELIEFS; i++) {
      delete state.model.beliefs[sorted[i]]
    }
  }
}

function capKnowledge() {
  const keys = Object.keys(state.model.knowledge)
  if (keys.length > MAX_KNOWLEDGE) {
    const sorted = keys.sort(
      (a, b) => (state.model.knowledge[a]?.ts || 0) - (state.model.knowledge[b]?.ts || 0)
    )
    for (let i = 0; i < sorted.length - MAX_KNOWLEDGE; i++) {
      delete state.model.knowledge[sorted[i]]
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODULE
// ═══════════════════════════════════════════════════════════════════════════════

export const theoryOfMindModule: SoulModule = {
  id: 'theory-of-mind',
  name: '用户认知模型',
  priority: 45,
  features: ['theory_of_mind'],

  init() {
    const loaded = loadJson<ToMState>(TOM_PATH, {
      model: { beliefs: {}, knowledge: {}, goals: [], frustrations: [] },
      corrections: [],
      recentTopics: [],
    })
    state = loaded
    // Ensure all sub-fields exist (backward compat)
    if (!state.model) state.model = { beliefs: {}, knowledge: {}, goals: [], frustrations: [] }
    if (!state.model.beliefs) state.model.beliefs = {}
    if (!state.model.knowledge) state.model.knowledge = {}
    if (!state.model.goals) state.model.goals = []
    if (!state.model.frustrations) state.model.frustrations = []
    if (!state.corrections) state.corrections = []
    if (!state.recentTopics) state.recentTopics = []

    const beliefCount = Object.keys(state.model.beliefs).length
    const knowledgeCount = Object.keys(state.model.knowledge).length
    console.log(`${TAG} loaded ${beliefCount} beliefs, ${knowledgeCount} knowledge entries`)
  },

  dispose() {
    persist()
  },

  onPreprocessed(event: any): Augment[] | void {
    const msg = event?.userMessage || event?.content || ''
    if (!msg) return

    // Check for misconceptions to inject as augment
    const misconception = detectMisconception(msg)
    const tomContext = getToMContext()

    const augments: Augment[] = []
    if (misconception) {
      augments.push({ content: `⚠ ${misconception}`, priority: 7, tokens: 40 })
    }
    if (tomContext.length > 10) {
      augments.push({ content: tomContext, priority: 3, tokens: Math.ceil(tomContext.length / 3) })
    }
    return augments.length > 0 ? augments : undefined
  },

  onSent(event: any) {
    const userMsg = event?.userMessage || event?.content || ''
    const botReply = event?.botReply || event?.response || ''
    if (userMsg) {
      updateBeliefFromMessage(userMsg, botReply)
    }
  },
}
