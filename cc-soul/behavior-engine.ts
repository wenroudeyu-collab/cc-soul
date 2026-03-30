/**
 * behavior-engine.ts — Behavioral Pattern Engine (行为模式引擎)
 *
 * 竞品没有的原创功能。不存事实，学规律。
 *
 * 核心思想：人的行为有模式。同样的情境（时间+话题+情绪+上下文）
 * 通常导致同样的需求。学会这些模式，就能在用户开口前知道他要什么。
 *
 * 模式格式：
 *   condition: { time?: TimeSlot, topic?: string, mood?: 'positive'|'negative', after?: string }
 *   action: { style: string, priority: string, hint: string }
 *   evidence: { hits: number, misses: number, lastHit: number }
 *
 * 学习方式：
 *   1. 每轮对话后，记录 (情境, 用户反应) 对
 *   2. 积累 3+ 个相同情境的样本后，提取模式
 *   3. 模式通过 augment 注入 LLM，影响回复风格
 *   4. 用户纠正 → 模式惩罚；用户满意 → 模式强化
 */

import type { Memory } from './types.ts'
import { DATA_DIR, loadJson, debouncedSave } from './persistence.ts'
import { resolve } from 'path'

const ENGINE_PATH = resolve(DATA_DIR, 'behavior_patterns.json')

// ═══════════════════════════════════════════════════════════════════════════════
// DATA STRUCTURES
// ═══════════════════════════════════════════════════════════════════════════════

type TimeSlot = 'early_morning' | 'morning' | 'afternoon' | 'evening' | 'late_night'
type MoodBucket = 'positive' | 'negative' | 'neutral'

interface SituationCondition {
  timeSlot?: TimeSlot
  topicDomain?: string       // "python" | "career" | "health" | etc.
  mood?: MoodBucket
  afterEvent?: string        // "correction" | "long_silence" | "rapid_fire" | "topic_switch"
  dayType?: 'weekday' | 'weekend'
}

interface ResponseAction {
  style: string              // "concise" | "detailed" | "empathetic" | "code_first" | "step_by_step"
  hint: string               // natural language hint for LLM
}

interface BehaviorPattern {
  id: string
  condition: SituationCondition
  action: ResponseAction
  hits: number               // times this pattern was confirmed
  misses: number             // times this pattern was wrong
  lastHit: number            // timestamp
  createdAt: number
  source: 'learned' | 'seeded'  // learned from data vs pre-seeded
}

// Observation: what actually happened in a situation
interface SituationObservation {
  situation: SituationCondition
  userReaction: 'satisfied' | 'corrected' | 'follow_up' | 'topic_switch' | 'neutral'
  responseStyle: string      // what style was used
  ts: number
}

interface EngineState {
  patterns: BehaviorPattern[]
  observations: SituationObservation[]
  lastLearningRun: number
}

let state: EngineState = loadJson<EngineState>(ENGINE_PATH, {
  patterns: [],
  observations: [],
  lastLearningRun: 0,
})

// Seed default patterns if empty
if (state.patterns.length === 0) {
  state.patterns = SEED_PATTERNS()
  saveState()
}

function saveState() { debouncedSave(ENGINE_PATH, state) }

var _counter = 0  // var to avoid TDZ in SEED_PATTERNS init
function makeId(): string { return `bp_${Date.now()}_${_counter++}` }

// ═══════════════════════════════════════════════════════════════════════════════
// SEED PATTERNS — common sense defaults, refined by learning
// ═══════════════════════════════════════════════════════════════════════════════

function SEED_PATTERNS(): BehaviorPattern[] {
  const now = Date.now()
  const seed = (cond: SituationCondition, style: string, hint: string): BehaviorPattern => ({
    id: makeId(), condition: cond, action: { style, hint },
    hits: 1, misses: 0, lastHit: now, createdAt: now, source: 'seeded',
  })
  return [
    seed({ timeSlot: 'late_night', topicDomain: 'tech' }, 'concise', '深夜问技术问题，可能在排障，给命令和代码，少解释'),
    seed({ timeSlot: 'early_morning' }, 'concise', '早上刚起来，简洁回答，别长篇大论'),
    seed({ afterEvent: 'correction' }, 'careful', '刚被纠正过，这次更谨慎，多检查事实'),
    seed({ afterEvent: 'rapid_fire' }, 'concise', '用户连续快速提问，给短平快的答案'),
    seed({ mood: 'negative' }, 'empathetic', '用户情绪不好，先共情再给方案'),
    seed({ mood: 'negative', topicDomain: 'work' }, 'empathetic', '工作压力大，别说教，给实际可操作的建议'),
    seed({ topicDomain: 'tech', afterEvent: 'topic_switch' }, 'code_first', '刚切到技术话题，先上代码再解释'),
    seed({ dayType: 'weekend' }, 'casual', '周末了，轻松一点，不用太正式'),
    seed({ dayType: 'weekend', topicDomain: 'life' }, 'casual', '周末聊生活话题，像朋友一样说话'),
  ]
}

// ═══════════════════════════════════════════════════════════════════════════════
// SITUATION DETECTION — analyze current context
// ═══════════════════════════════════════════════════════════════════════════════

function getTimeSlot(): TimeSlot {
  const h = new Date().getHours()
  if (h >= 0 && h < 6) return 'late_night'
  if (h >= 6 && h < 9) return 'early_morning'
  if (h >= 9 && h < 12) return 'morning'
  if (h >= 12 && h < 18) return 'afternoon'
  if (h >= 18 && h < 23) return 'evening'
  return 'late_night'
}

function getMoodBucket(mood: number): MoodBucket {
  if (mood > 0.3) return 'positive'
  if (mood < -0.3) return 'negative'
  return 'neutral'
}

function detectTopicDomain(msg: string): string {
  const m = msg.toLowerCase()
  if (/python|\.py|pip|django|flask|pandas|numpy/.test(m)) return 'python'
  if (/javascript|node|react|vue|typescript|npm/.test(m)) return 'javascript'
  if (/go|golang|goroutine/.test(m)) return 'go'
  if (/rust|cargo|ownership|borrow/.test(m)) return 'rust'
  if (/swift|ios|xcode|uikit|swiftui/.test(m)) return 'ios'
  if (/docker|k8s|kubernetes|deploy|nginx|ci\/cd/.test(m)) return 'devops'
  if (/sql|数据库|mysql|postgres|redis|mongo/.test(m)) return 'database'
  if (/git|merge|rebase|branch|commit/.test(m)) return 'git'
  if (/api|http|fetch|curl|网络|接口/.test(m)) return 'network'
  if (/linux|shell|bash|ssh|systemd/.test(m)) return 'linux'
  if (/面试|简历|跳槽|工作|职场|老板|薪资/.test(m)) return 'career'
  if (/理财|投资|基金|股票|贷款/.test(m)) return 'finance'
  if (/健康|减肥|健身|睡眠|失眠|运动/.test(m)) return 'health'
  if (/学习|考试|英语|留学|课程/.test(m)) return 'study'
  if (/租房|买房|装修|搬家/.test(m)) return 'housing'
  if (/做饭|菜谱|食材/.test(m)) return 'cooking'
  if (/朋友|恋爱|分手|沟通|父母|孩子/.test(m)) return 'relationship'
  if (/旅游|旅行|出差|机票/.test(m)) return 'travel'
  // Generic tech detection
  if (/代码|函数|变量|编程|bug|报错|算法|框架/.test(m)) return 'tech'
  return 'general'
}

function detectAfterEvent(session: any): string | undefined {
  if (!session) return undefined
  // Check if user was just corrected
  if (session._pendingCorrectionVerify) return 'correction'
  // Check rapid fire (turn count in short time)
  if (session.turnCount >= 3) return 'rapid_fire'
  // Check topic switch
  const lastTopics = session.lastTopicKeywords || []
  if (lastTopics.length > 0) return undefined  // could detect switch here
  return undefined
}

/**
 * Build current situation from context.
 */
export function detectSituation(userMsg: string, mood: number, session?: any): SituationCondition {
  const day = new Date().getDay()
  return {
    timeSlot: getTimeSlot(),
    topicDomain: detectTopicDomain(userMsg),
    mood: getMoodBucket(mood),
    afterEvent: detectAfterEvent(session),
    dayType: (day === 0 || day === 6) ? 'weekend' : 'weekday',
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PATTERN MATCHING — find applicable patterns for current situation
// ═══════════════════════════════════════════════════════════════════════════════

function matchScore(pattern: SituationCondition, current: SituationCondition): number {
  let score = 0
  let fields = 0
  if (pattern.timeSlot) { fields++; if (pattern.timeSlot === current.timeSlot) score++ }
  if (pattern.topicDomain) { fields++; if (pattern.topicDomain === current.topicDomain) score++ }
  if (pattern.mood) { fields++; if (pattern.mood === current.mood) score++ }
  if (pattern.afterEvent) { fields++; if (pattern.afterEvent === current.afterEvent) score++ }
  if (pattern.dayType) { fields++; if (pattern.dayType === current.dayType) score++ }
  if (fields === 0) return 0
  return score / fields  // 1.0 = perfect match
}

/**
 * Find best matching patterns for current situation.
 * Returns patterns sorted by relevance, filtered by confidence.
 */
export function matchPatterns(situation: SituationCondition): BehaviorPattern[] {
  const candidates = state.patterns
    .map(p => ({ pattern: p, score: matchScore(p.condition, situation) }))
    .filter(c => c.score >= 0.5)  // at least half the conditions match
    .filter(c => {
      // Confidence filter: hits / (hits + misses) > 0.4
      const total = c.pattern.hits + c.pattern.misses
      return total < 3 || (c.pattern.hits / total) > 0.4
    })
    .sort((a, b) => {
      // Sort by: match score * confidence
      const confA = a.pattern.hits / Math.max(1, a.pattern.hits + a.pattern.misses)
      const confB = b.pattern.hits / Math.max(1, b.pattern.hits + b.pattern.misses)
      return (b.score * confB) - (a.score * confA)
    })
  return candidates.slice(0, 3).map(c => c.pattern)
}

/**
 * Generate augment hint from matched patterns.
 * This is what gets injected into SOUL.md for the LLM.
 */
export function getBehaviorEngineHint(userMsg: string, mood: number, session?: any): string | null {
  const situation = detectSituation(userMsg, mood, session)
  const matched = matchPatterns(situation)
  if (matched.length === 0) return null

  const hints = matched.map(p => p.action.hint).join('；')
  const confidence = matched[0].hits / Math.max(1, matched[0].hits + matched[0].misses)
  const confLabel = confidence > 0.8 ? '高' : confidence > 0.5 ? '中' : '低'

  return `[行为模式·${confLabel}置信] ${hints}`
}

// ═══════════════════════════════════════════════════════════════════════════════
// LEARNING — observe and extract new patterns
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record what happened after we responded.
 * Called from feedback loop.
 */
export function recordObservation(
  userMsg: string, mood: number, session: any,
  reaction: SituationObservation['userReaction'], responseStyle: string
) {
  const situation = detectSituation(userMsg, mood, session)
  state.observations.push({
    situation, userReaction: reaction, responseStyle, ts: Date.now(),
  })
  // Keep last 200 observations
  if (state.observations.length > 200) {
    state.observations = state.observations.slice(-200)
  }

  // Reinforce or penalize matched patterns
  const matched = matchPatterns(situation)
  for (const p of matched) {
    if (reaction === 'satisfied' || reaction === 'neutral') {
      p.hits++
      p.lastHit = Date.now()
    } else if (reaction === 'corrected') {
      p.misses++
    }
  }

  saveState()
}

/**
 * Learning cycle: analyze recent observations and extract new patterns.
 * Called from heartbeat (every 30 min).
 */
export function learnFromObservations() {
  const now = Date.now()
  if (now - state.lastLearningRun < 30 * 60000) return  // 30 min cooldown
  state.lastLearningRun = now

  // Group recent observations by situation key
  const recent = state.observations.filter(o => now - o.ts < 7 * 86400000)  // last 7 days
  const groups = new Map<string, SituationObservation[]>()

  for (const obs of recent) {
    // Create a key from the non-null condition fields
    const key = [
      obs.situation.timeSlot || '*',
      obs.situation.topicDomain || '*',
      obs.situation.mood || '*',
      obs.situation.afterEvent || '*',
    ].join(':')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(obs)
  }

  // Extract patterns from groups with 3+ observations
  let newPatterns = 0
  for (const [key, observations] of groups) {
    if (observations.length < 3) continue

    // Check if a pattern for this key already exists
    const existing = state.patterns.find(p => {
      const pKey = [
        p.condition.timeSlot || '*',
        p.condition.topicDomain || '*',
        p.condition.mood || '*',
        p.condition.afterEvent || '*',
      ].join(':')
      return pKey === key
    })
    if (existing) continue  // already have a pattern for this

    // Determine dominant reaction
    const reactionCounts: Record<string, number> = {}
    for (const obs of observations) {
      reactionCounts[obs.userReaction] = (reactionCounts[obs.userReaction] || 0) + 1
    }
    const dominant = Object.entries(reactionCounts).sort((a, b) => b[1] - a[1])[0]
    if (!dominant) continue

    // Determine best response style for this situation
    const satisfiedObs = observations.filter(o => o.userReaction === 'satisfied' || o.userReaction === 'neutral')
    const bestStyle = satisfiedObs.length > 0 ? satisfiedObs[0].responseStyle : 'balanced'

    // Build the condition from key
    const parts = key.split(':')
    const condition: SituationCondition = {}
    if (parts[0] !== '*') condition.timeSlot = parts[0] as TimeSlot
    if (parts[1] !== '*') condition.topicDomain = parts[1]
    if (parts[2] !== '*') condition.mood = parts[2] as MoodBucket
    if (parts[3] !== '*') condition.afterEvent = parts[3]

    // Generate hint based on observations
    const hint = generateHint(condition, bestStyle, observations.length)
    if (!hint) continue

    state.patterns.push({
      id: makeId(),
      condition,
      action: { style: bestStyle, hint },
      hits: satisfiedObs.length,
      misses: observations.filter(o => o.userReaction === 'corrected').length,
      lastHit: now,
      createdAt: now,
      source: 'learned',
    })
    newPatterns++
  }

  // Prune dead patterns (confidence < 0.3 and old)
  state.patterns = state.patterns.filter(p => {
    const total = p.hits + p.misses
    const conf = total > 0 ? p.hits / total : 0.5
    const ageMs = now - p.lastHit
    // Keep if: young (<30 days) or confident (>0.3) or few samples (<5)
    return ageMs < 30 * 86400000 || conf > 0.3 || total < 5
  })

  if (newPatterns > 0) {
    console.log(`[cc-soul][behavior-engine] learned ${newPatterns} new patterns (total: ${state.patterns.length})`)
  }
  saveState()
}

function generateHint(condition: SituationCondition, style: string, sampleCount: number): string | null {
  const parts: string[] = []
  if (condition.timeSlot === 'late_night') parts.push('深夜')
  if (condition.timeSlot === 'early_morning') parts.push('早上')
  if (condition.topicDomain && condition.topicDomain !== 'general') parts.push(`聊${condition.topicDomain}`)
  if (condition.mood === 'negative') parts.push('情绪不好时')
  if (condition.mood === 'positive') parts.push('心情好时')
  if (condition.afterEvent === 'correction') parts.push('被纠正后')
  if (condition.afterEvent === 'rapid_fire') parts.push('连续提问时')

  if (parts.length === 0) return null

  const context = parts.join('、')
  const styleMap: Record<string, string> = {
    concise: '简短直接回答',
    detailed: '详细展开说明',
    empathetic: '先共情再给方案',
    code_first: '先上代码再解释',
    step_by_step: '分步骤引导',
    careful: '谨慎回答，多检查',
    casual: '轻松随意地聊',
    balanced: '平衡回答',
  }

  return `用户${context}，历史${sampleCount}次互动表明${styleMap[style] || style}效果最好`
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

export function getPatternCount(): number { return state.patterns.length }
export function getLearnedPatternCount(): number { return state.patterns.filter(p => p.source === 'learned').length }
export function getAllPatterns(): BehaviorPattern[] { return state.patterns }
