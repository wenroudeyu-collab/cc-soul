/**
 * cc-soul — Conversation flow tracker
 *
 * Detects multi-turn patterns: topic persistence, frustration, resolution.
 * Prevents repetitive responses when stuck on the same bug for 8+ rounds.
 * Session end detection: when a resolved conversation goes idle, generates a summary.
 */

import type { SoulModule } from './brain.ts'
import { spawnCLI } from './cli.ts'
import { memoryState, addMemory } from './memory.ts'
import { extractJSON } from './utils.ts'
import { getParam } from './auto-tune.ts'

// ── Algorithm: Frustration Dynamics (挫败感动力学) ──
// 不只检测"现在是否挫败"，而是建模挫败感的积累轨迹
// 基于 Yerkes-Dodson 激活曲线 — 挫败感不是二元状态，是有惯性的连续过程
// 能预测"再过几轮可能放弃"

export interface FrustrationTrajectory {
  current: number           // 当前挫败感 [0, 1]
  velocity: number          // 变化速率（正=恶化，负=改善）
  turnsToAbandon: number | null  // 预测几轮后放弃（null=不会）
}

// 每个用户的挫败感历史
const _frustrationHistory = new Map<string, number[]>()

export function computeFrustrationDynamics(
  flowKey: string,
  msgLength: number,
  prevMsgLength: number,
  turnCount: number,
  hasQuestionMark: boolean,
  hasNegativeWords: boolean,
): FrustrationTrajectory {
  // 获取历史
  if (!_frustrationHistory.has(flowKey)) _frustrationHistory.set(flowKey, [])
  const history = _frustrationHistory.get(flowKey)!

  // 计算当前信号
  let signal = 0
  // 消息变短 = 失去耐心
  if (prevMsgLength > 0 && msgLength < prevMsgLength * 0.5) signal += 0.2
  // 连续问号 = 没得到答案
  if (hasQuestionMark && turnCount > 3) signal += 0.15
  // 负面词 = 明确表达不满
  if (hasNegativeWords) signal += 0.3
  // 回合数递增 = 疲劳累积
  signal += Math.min(0.15, turnCount * 0.02)

  // 衰减项：如果消息变长了或没有负面信号 = 缓解
  if (msgLength > prevMsgLength * 1.2) signal -= 0.15
  if (!hasQuestionMark && !hasNegativeWords) signal -= 0.05

  signal = Math.max(-0.2, Math.min(0.5, signal))
  history.push(signal)
  if (history.length > 20) history.shift()

  // 计算当前值：指数加权移动平均
  let current = 0
  let weight = 1
  for (let i = history.length - 1; i >= 0; i--) {
    current += history[i] * weight
    weight *= 0.7 // 最近的信号权重最大
  }
  current = Math.max(0, Math.min(1, current))

  // 计算速率：最近3个信号的趋势
  const recentSlice = history.slice(-3)
  const velocity = recentSlice.length >= 2
    ? (recentSlice[recentSlice.length - 1] - recentSlice[0]) / recentSlice.length
    : 0

  // 预测放弃轮数
  let turnsToAbandon: number | null = null
  if (current > 0.3 && velocity > 0) {
    // 线性外推：几轮后到 0.8（放弃阈值）
    turnsToAbandon = Math.ceil((0.8 - current) / velocity)
    if (turnsToAbandon > 10 || turnsToAbandon < 0) turnsToAbandon = null
  }

  return { current, velocity, turnsToAbandon }
}

interface ConversationFlow {
  topic: string              // current topic being discussed
  turnCount: number          // consecutive turns on same topic
  frustration: number        // 0-1, rises when user messages get shorter or more terse
  resolved: boolean          // topic appears resolved
  depth: 'shallow' | 'deep' | 'stuck'
  lastMsgLengths: number[]   // last 5 message lengths for frustration detection
  topicKeywords: string[]    // keywords that define this topic
  lastUpdate: number         // timestamp of last update
  frustrationTrajectory?: FrustrationTrajectory  // 挫败感动力学轨迹
}

// ── Session end tracking ──

interface ResolvedSession {
  resolvedAt: number
  summarized: boolean
  topic: string
  turnCount: number
}

const lastResolvedFlows = new Map<string, ResolvedSession>()

function createEmptyFlow(): ConversationFlow {
  return {
    topic: '', turnCount: 0, frustration: 0, resolved: false,
    depth: 'shallow', lastMsgLengths: [], topicKeywords: [], lastUpdate: Date.now(),
  }
}

const flows = new Map<string, ConversationFlow>()
const MAX_FLOWS = 50

// ── Session resolved callback (set by handler.ts to avoid circular deps) ──

let onSessionResolved: (() => void) | null = null

export function setOnSessionResolved(cb: () => void) {
  onSessionResolved = cb
}

export function updateFlow(userMsg: string, botResponse: string, flowKey: string): ConversationFlow {
  let flow = flows.get(flowKey) || createEmptyFlow()
  const msgWords = (userMsg.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase())

  // Check if same topic continues (keyword overlap with current topic)
  const overlap = flow.topicKeywords.filter(w => msgWords.includes(w)).length
  const isSameTopic = overlap >= 2 || (flow.turnCount > 0 && overlap >= 1 && userMsg.length < 50)

  if (isSameTopic) {
    flow.turnCount++
    // Merge new keywords into topic
    for (const w of msgWords.slice(0, 5)) {
      if (!flow.topicKeywords.includes(w)) flow.topicKeywords.push(w)
    }
    if (flow.topicKeywords.length > 15) flow.topicKeywords = flow.topicKeywords.slice(-10)
  } else {
    // New topic — reset flow
    flow = {
      topic: userMsg.slice(0, 50),
      turnCount: 1,
      frustration: 0,
      resolved: false,
      depth: 'shallow',
      lastMsgLengths: [],
      topicKeywords: msgWords.slice(0, 8),
      lastUpdate: Date.now(),
    }
  }

  // Frustration detection: message length trend
  flow.lastMsgLengths.push(userMsg.length)
  if (flow.lastMsgLengths.length > 5) flow.lastMsgLengths.shift()

  if (flow.lastMsgLengths.length >= 3) {
    const lengths = flow.lastMsgLengths
    const trend = lengths[lengths.length - 1] - lengths[0]
    // Getting shorter = frustration rising
    if (trend < -50) flow.frustration = Math.min(1, flow.frustration + getParam('flow.frustration_shortening_rate'))
    // Terse responses (single word confirmations after long exchanges)
    if (userMsg.length < 10 && flow.turnCount > 3) flow.frustration = Math.min(1, flow.frustration + getParam('flow.frustration_terse'))
  }

  // Frustration keywords
  if (['算了', '不对', '还是不行', '怎么又', '说了多少遍'].some(w => userMsg.includes(w))) {
    flow.frustration = Math.min(1, flow.frustration + getParam('flow.frustration_keyword_rate'))
  }

    // Dimension 2: Question mark density (confusion signal)
    const questionMarks = (userMsg.match(/[？?]/g) || []).length
    if (questionMarks >= 2) {
      flow.frustration = Math.min(1, flow.frustration + getParam('flow.frustration_question_rate') * questionMarks)
    }

    // Dimension 3: Repetition (user repeating same words = not being heard)
    if (flow.turnCount >= 2 && flow.topicKeywords.length > 0) {
      const repeated = msgWords.filter(w => flow.topicKeywords.includes(w)).length
      const repeatRatio = repeated / Math.max(1, msgWords.length)
      if (repeatRatio > 0.6 && flow.turnCount > 3) {
        flow.frustration = Math.min(1, flow.frustration + getParam('flow.frustration_repetition'))
      }
    }

    // Dimension 4: Time decay (frustration cools down over time)
    // If user took >5 min to reply, they calmed down
    if (flow.lastMsgLengths.length > 0) {
      // No explicit timestamp in flow, so we approximate from context
      // Just add natural decay each turn
      flow.frustration = Math.max(0, flow.frustration - getParam('flow.frustration_decay_per_turn'))
    }

  // Frustration Dynamics: compute trajectory alongside existing frustration
  const prevMsgLen = flow.lastMsgLengths.length >= 2 ? flow.lastMsgLengths[flow.lastMsgLengths.length - 2] : 0
  const hasQuestionMark = /[？?]/.test(userMsg)
  const hasNegativeWords = ['算了', '不对', '还是不行', '怎么又', '说了多少遍', '烦', '累'].some(w => userMsg.includes(w))
  flow.frustrationTrajectory = computeFrustrationDynamics(flowKey, userMsg.length, prevMsgLen, flow.turnCount, hasQuestionMark, hasNegativeWords)

  // Resolution detection
  if (['搞定', '可以了', '好了', '解决了', '谢谢', 'thanks', '成功了'].some(w => userMsg.toLowerCase().includes(w))) {
    flow.resolved = true
    flow.frustration = Math.max(0, flow.frustration - 0.3)
    if (typeof onSessionResolved === 'function') onSessionResolved()
    // Record for session end detection
    if (!lastResolvedFlows.has(flowKey)) {
      lastResolvedFlows.set(flowKey, {
        resolvedAt: Date.now(),
        summarized: false,
        topic: flow.topic,
        turnCount: flow.turnCount,
      })
    }
  }

  // Depth assessment
  if (flow.turnCount <= 2) flow.depth = 'shallow'
  else if (flow.turnCount <= 6 && flow.frustration < getParam('flow.stuck_threshold')) flow.depth = 'deep'
  else if (flow.turnCount > 6 || flow.frustration >= getParam('flow.stuck_threshold')) flow.depth = 'stuck'

  flow.lastUpdate = Date.now()
  flows.set(flowKey, flow)

  // Evict oldest flows (keep max MAX_FLOWS)
  if (flows.size > MAX_FLOWS) {
    const oldest = [...flows.entries()].sort((a, b) => a[1].lastUpdate - b[1].lastUpdate)[0]
    if (oldest) flows.delete(oldest[0])
  }

  // Cleanup old resolved flows (prevent memory leak)
  const OLD_THRESHOLD = 24 * 3600000
  for (const [key, resolved] of lastResolvedFlows) {
    if (Date.now() - resolved.resolvedAt > OLD_THRESHOLD) {
      lastResolvedFlows.delete(key)
    }
  }

  return flow
}

export function getFlowHints(flowKey: string): string[] {
  const flow = flows.get(flowKey)
  if (!flow) return []
  const hints: string[] = []

  if (flow.depth === 'stuck') {
    hints.push(`已经讨论${flow.turnCount}轮了，可能陷入僵局。试试换个思路或直接给最终方案`)
  }
  if (flow.frustration >= 0.6) {
    hints.push('用户可能越来越不耐烦了，简化回答，直接给方案')
  }
  // Frustration trajectory: predictive warning
  if (flow.frustrationTrajectory) {
    const ft = flow.frustrationTrajectory
    if (ft.turnsToAbandon !== null && ft.turnsToAbandon <= 3) {
      hints.push(`⚠ 预测用户可能在${ft.turnsToAbandon}轮内放弃，立即给出最终方案`)
    } else if (ft.velocity > 0.1 && ft.current > 0.2) {
      hints.push('挫败感正在快速上升，注意调整策略')
    }
  }
  if (flow.resolved) {
    hints.push('问题似乎已解决，自然收尾即可')
  }
  if (flow.turnCount >= 4 && !flow.resolved && flow.frustration < 0.3) {
    hints.push(`讨论已${flow.turnCount}轮，用户很有耐心，可以继续深入`)
  }

  return hints
}

export function getFlowContext(flowKey: string): string {
  const flow = flows.get(flowKey)
  if (!flow || flow.turnCount <= 1) return ''
  return `[对话流] 当前话题已${flow.turnCount}轮 | 深度:${flow.depth} | 用户耐心:${(1 - flow.frustration).toFixed(1)} | ${flow.resolved ? '已解决' : '进行中'}`
}

/** Return the worst (most stuck) depth across all active flows */
export function getCurrentFlowDepth(): 'shallow' | 'deep' | 'stuck' {
  let worst: 'shallow' | 'deep' | 'stuck' = 'shallow'
  for (const flow of flows.values()) {
    if (flow.depth === 'stuck') return 'stuck'
    if (flow.depth === 'deep') worst = 'deep'
  }
  return worst
}

/** Average frustration across all active flows (for upgrade observation metrics) */
export function getAvgFrustration(): number {
  if (flows.size === 0) return 0
  let sum = 0
  for (const flow of flows.values()) sum += flow.frustration
  return Math.round(sum / flows.size * 100) / 100
}

/** Get topics of active unresolved flows (for proactive voice scanning) */
export function getUnresolvedTopics(): string[] {
  const topics: string[] = []
  const now = Date.now()
  for (const flow of flows.values()) {
    // Active in last 24h, not resolved, has a real topic
    if (flow.topic && !flow.resolved && now - flow.lastUpdate < 86400000) {
      topics.push(flow.topic)
    }
  }
  return topics
}

export function resetFlow(flowKey?: string) {
  if (flowKey) {
    flows.delete(flowKey)
  } else {
    flows.clear()
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION END DETECTION + SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a resolved conversation has gone idle long enough to be considered "ended".
 * Returns session info if ended and not yet summarized, null otherwise.
 */
export function checkSessionEnd(flowKey: string): { ended: boolean; topic: string; turnCount: number } | null {
  const resolved = lastResolvedFlows.get(flowKey)
  if (!resolved) return null
  if (resolved.summarized) return null

  // If resolved and no new message for 5+ minutes → session ended
  if (Date.now() - resolved.resolvedAt > 5 * 60 * 1000) {
    resolved.summarized = true
    return { ended: true, topic: resolved.topic, turnCount: resolved.turnCount }
  }
  return null
}

/**
 * Check all flows for ended sessions. Called from heartbeat or message:preprocessed.
 */
export function checkAllSessionEnds(): { flowKey: string; topic: string; turnCount: number }[] {
  const ended: { flowKey: string; topic: string; turnCount: number }[] = []
  for (const [key] of lastResolvedFlows) {
    const result = checkSessionEnd(key)
    if (result) {
      ended.push({ flowKey: key, topic: result.topic, turnCount: result.turnCount })
    }
  }
  return ended
}

/**
 * Generate a session-level summary via CLI. More valuable than per-message memory extraction
 * because it captures the arc of the conversation, satisfaction, and pending items.
 */
export function generateSessionSummary(topic: string, turnCount: number, _flowKey: string) {
  const chatHistory = memoryState.chatHistory
  // Get recent history relevant to this topic (rough estimate: turnCount * 2 entries)
  const recentHistory = chatHistory.slice(-(turnCount * 2))
  const historyText = recentHistory.map(t =>
    `用户: ${t.user.slice(0, 100)}\n助手: ${t.assistant.slice(0, 100)}`
  ).join('\n\n')

  spawnCLI(
    `以下是一段${turnCount}轮的对话（话题: ${topic}）。请总结：\n` +
    `1. 聊了什么\n2. 用户满意吗\n3. 有没有遗留问题\n4. 值得记住的事实/偏好\n\n` +
    `${historyText.slice(0, 2000)}\n\n` +
    `格式: {"summary":"一段话总结","facts":["值得记住的事实"],"satisfied":true/false,"pending":"遗留问题或null"}`,
    (output) => {
      try {
        const result = extractJSON(output)
        if (result) {
          // Store as high-value consolidated memory
          if (result.summary) {
            addMemory(`[会话总结] ${topic}: ${result.summary}`, 'consolidated')
          }
          for (const fact of (result.facts || [])) {
            addMemory(fact, 'fact')
          }
          if (result.pending) {
            addMemory(`[遗留问题] ${result.pending}`, 'task')
          }
          console.log(`[cc-soul][session] summarized: ${topic} (${turnCount} turns, satisfied=${result.satisfied})`)
        }
      } catch (e: any) {
        console.error(`[cc-soul][session] summary parse error: ${e.message}`)
      }
    }
  )
}

// ── SoulModule registration ──

export const flowModule: SoulModule = {
  id: 'flow',
  name: '对话流管理',
  priority: 50,
}
