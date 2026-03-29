/**
 * cognition.ts — Cognition Pipeline (SYNC)
 *
 * Attention gate, intent detection, strategy selection, implicit feedback.
 * Ported from handler.ts lines 444-570 with attention gate false-positive fix.
 */

import type { CogResult } from './types.ts'
import { body, bodyOnCorrection, bodyOnPositiveFeedback, emotionVector } from './body.ts'
import { getProfile, getProfileTier } from './user-profiles.ts'
import { CORRECTION_WORDS, CORRECTION_EXCLUDE, EMOTION_ALL, EMOTION_NEGATIVE, TECH_WORDS, CASUAL_WORDS } from './signals.ts'

// ── Layer 0: Bayesian Attention Gate ──
// Instead of first-match-wins, compute probability for ALL intent types simultaneously.
// Human analogy: when you hear "这段代码让我很烦", you simultaneously consider:
//   technical (代码) + emotional (烦) + correction (implicit frustration)
// The old if-else would pick just one. Bayesian picks the strongest signal.

interface AttentionHypothesis { type: string; score: number }

function attentionGate(msg: string): { type: string; priority: number } {
  const m = msg.toLowerCase()
  const hypotheses: AttentionHypothesis[] = [
    { type: 'correction', score: 0 },
    { type: 'emotional', score: 0 },
    { type: 'technical', score: 0 },
    { type: 'casual', score: 0 },
    { type: 'general', score: 1 }, // prior: general is default
  ]

  // Accumulate evidence for each hypothesis (not first-match-wins)
  const correctionHits = CORRECTION_WORDS.filter(w => m.includes(w)).length
  const correctionExclude = CORRECTION_EXCLUDE.some(w => m.includes(w))
  if (correctionHits > 0 && !correctionExclude) {
    hypotheses[0].score += correctionHits * 3 // strong signal
  }

  const emotionHits = EMOTION_ALL.filter(w => m.includes(w)).length
  hypotheses[1].score += emotionHits * 2

  const techHits = TECH_WORDS.filter(w => m.includes(w)).length
  hypotheses[2].score += techHits * 2

  const casualHits = CASUAL_WORDS.filter(w => m === w || m === w + '的').length
  hypotheses[3].score += casualHits * 2
  if (msg.length < 15) hypotheses[3].score += 1 // short messages lean casual

  // Length-based priors
  if (msg.length > 100) hypotheses[2].score += 0.5 // long messages lean technical
  if (msg.length < 8) hypotheses[3].score += 1 // very short lean casual

  // Negative emotion + technical = still emotional (not just technical)
  const negEmotionHits = EMOTION_NEGATIVE.filter(w => m.includes(w)).length
  if (negEmotionHits > 0 && techHits > 0) {
    hypotheses[1].score += 1 // boost emotional even when technical words present
  }

  // Pick winner
  hypotheses.sort((a, b) => b.score - a.score)
  const winner = hypotheses[0]
  const priority = Math.min(10, Math.round(winner.score * 2 + 3))
  return { type: winner.type, priority }
}

// ── Layer 1: Intent Detection ──

function detectIntent(msg: string): string {
  const m = msg.toLowerCase()
  if (['你觉得', '你看', '你认为', '你怎么看', '你的看法', '建议'].some(w => m.includes(w))) return 'wants_opinion'
  if (['顺便', '另外', '还有', '对了'].some(w => m.includes(w))) return 'wants_proactive'
  if (m.endsWith('?') || m.endsWith('？') || ['吗', '呢', '么'].some(w => m.endsWith(w))) return 'wants_answer'
  if (msg.length < 20) return 'wants_quick'
  if (['做', '写', '改', '帮我', '实现', '生成'].some(w => m.includes(w))) return 'wants_action'
  return 'unclear'
}

// ── Layer 2: Strategy ──

function decideStrategy(attention: { type: string; priority: number }, intent: string, msgLen: number): string {
  if (attention.type === 'correction') return 'acknowledge_and_retry'
  if (attention.type === 'emotional') return 'empathy_first'
  if (intent === 'wants_quick' || msgLen < 10) return 'direct'
  if (intent === 'wants_opinion') return 'opinion_with_reasoning'
  if (intent === 'wants_action') return 'action_oriented'
  if (msgLen > 200) return 'detailed'
  return 'balanced'
}

// ── SYNC implicit feedback (fast keyword-based for immediate body state) ──

function detectImplicitFeedbackSync(msg: string, prevResponse: string): string | null {
  if (!prevResponse) return null
  const m = msg.toLowerCase()

  // Short reply after long answer = too verbose
  if (prevResponse.length > 500 && msg.length < 10 && ['嗯', '好', '行', '哦', 'ok'].some(w => m.includes(w))) {
    return 'too_verbose'
  }

  // Brief acknowledgment = silent accept
  if (['嗯', '好的', '明白', '了解', 'ok', '收到', '可以', '好'].some(w => m === w)) {
    return 'silent_accept'
  }

  // Enthusiastic response = positive
  if (['太好了', '牛', '厉害', '完美', '正是', '对对对', '就是这个', '感谢'].some(w => m.includes(w))) {
    return 'positive'
  }

  return null
}

// ── Intent Prediction from Behavioral Patterns ──

export function predictIntent(msg: string, _senderId: string, lastMsgs: string[]): string[] {
  const hints: string[] = []
  const m = msg.toLowerCase()

  // Pattern: Multiple short messages in sequence → user is describing a problem piece by piece
  if (lastMsgs.length >= 2 && lastMsgs.slice(-2).every(x => x.length < 50) && msg.length < 50) {
    hints.push('用户在连续发短消息描述问题，等他说完再回复，不要逐条回')
  }

  // Pattern: Single "?" or "？" → user is waiting for a response, urgent
  if (m === '?' || m === '？' || m === '...' || m === '???') {
    hints.push('用户在催回复，简短回应即可')
  }

  // Pattern: Screenshot/image sent → user wants you to LOOK at content, not praise
  if (msg.includes('[图片]') || msg.includes('[Image]') || msg.includes('截图')) {
    hints.push('用户发了图片/截图，关注内容本身，不要评价图片质量')
  }

  // Pattern: Message starts with forwarded content marker → user wants analysis
  if (msg.includes('[转发]') || msg.includes('转发') || msg.startsWith('>>')) {
    hints.push('这是转发的内容，用户想要你的分析/看法')
  }

  // Pattern: Code paste → user has a specific technical problem
  if (msg.includes('```') || msg.includes('error') || msg.includes('Error') || msg.includes('traceback')) {
    hints.push('用户贴了代码/错误信息，直接定位问题给解决方案')
  }

  // Pattern: Long message with numbers/data → user wants analysis not summary
  if (msg.length > 200 && (msg.match(/\d+/g) || []).length > 5) {
    hints.push('消息包含大量数据/数字，做分析而不是摘要')
  }

  return hints
}

// ── Atmosphere Sensing: overall conversation vibe from patterns ──

export function detectAtmosphere(
  currentMsg: string,
  recentHistory: { user: string }[]
): string[] {
  const hints: string[] = []

  // Pattern 1: User sending very short messages (1-5 chars) → busy/distracted
  const recentLengths = recentHistory.slice(-3).map(h => h.user.length)
  if (recentLengths.length >= 2 && recentLengths.every(l => l < 5)) {
    hints.push('用户连续发极短消息，可能在忙，回复也要简短')
  }

  // Pattern 2: Long detailed message → serious/focused
  if (currentMsg.length > 300) {
    hints.push('用户写了很长的描述，说明在认真讨论，给详细的回复')
  }

  // Pattern 3: Emoji/casual markers → relaxed
  if (/[😂😊🤣👍❤️💀😭🥲]|哈哈|嘿嘿|呵呵/.test(currentMsg)) {
    hints.push('对话氛围轻松，可以随意一些')
  }

  // Pattern 4: Questions piling up without cc answering → user waiting
  if (currentMsg.endsWith('？') || currentMsg.endsWith('?')) {
    const recentQuestions = recentHistory.slice(-3).filter(h => h.user.endsWith('？') || h.user.endsWith('?'))
    if (recentQuestions.length >= 2) {
      hints.push('用户连续提问，可能之前的回答没到位，这次要更直接')
    }
  }

  // Pattern 5: Time-based atmosphere
  const hour = new Date().getHours()
  if (hour >= 22 || hour < 6) {
    hints.push('深夜对话，简洁为主')
  }

  return hints
}

// ── Conversation Pace Sensing ──

export interface ConversationPace {
  speed: 'rapid' | 'normal' | 'slow'
  avgMsgLength: number
  msgsPerMinute: number
  hint: string | null
}

/**
 * Detect conversation pace from recent message history.
 * Adjusts response verbosity: rapid pace → shorter replies, slow pace → can be detailed.
 */
export function detectConversationPace(
  currentMsg: string,
  recentHistory: { user: string; ts?: number }[],
): ConversationPace {
  const recent = recentHistory.slice(-5)
  if (recent.length < 2) return { speed: 'normal', avgMsgLength: currentMsg.length, msgsPerMinute: 0, hint: null }

  // Average message length
  const lengths = recent.map(h => h.user.length)
  const avgLen = lengths.reduce((s, l) => s + l, 0) / lengths.length

  // Messages per minute (if timestamps available)
  let msgsPerMinute = 0
  const timestamps = recent.filter(h => h.ts).map(h => h.ts!)
  if (timestamps.length >= 2) {
    const timeSpan = Math.max((timestamps[timestamps.length - 1] - timestamps[0]) / 60000, 0.5)
    msgsPerMinute = timestamps.length / timeSpan
  }

  // Determine pace
  let speed: 'rapid' | 'normal' | 'slow' = 'normal'
  let hint: string | null = null

  if ((msgsPerMinute > 3 || (msgsPerMinute > 1 && avgLen < 20)) && recent.length >= 3) {
    speed = 'rapid'
    hint = '用户发消息节奏很快（短消息连发），回复要简短精炼，不要长篇大论'
  } else if (msgsPerMinute > 0 && msgsPerMinute < 0.3 && avgLen > 100) {
    speed = 'slow'
    hint = '用户节奏较慢但每条消息很长，说明在深度思考，可以给详细回复'
  }

  return { speed, avgMsgLength: avgLen, msgsPerMinute, hint }
}

// ── Main Entry ──

export function cogProcess(msg: string, lastResponseContent: string, lastPrompt: string, senderId?: string): CogResult {
  const attention = attentionGate(msg)
  const intent = detectIntent(msg)
  const complexity = Math.min(1, msg.length / 500)
  const strategy = decideStrategy(attention, intent, msg.length)
  const hints: string[] = []

  // Correction handling — weighted by user tier
  if (attention.type === 'correction') {
    const profile = senderId ? getProfile(senderId) : null
    const tier = profile?.tier || 'new'

    if (tier === 'owner') {
      hints.push('⚠ 主人在纠正你，这是高权重反馈，必须认真对待并调整')
      bodyOnCorrection() // full correction impact
    } else if (tier === 'known') {
      hints.push('⚠ 老朋友在纠正你，注意调整')
      // Moderate correction — lighter than full bodyOnCorrection
      body.alertness = Math.min(1.0, body.alertness + 0.1)
      body.mood = Math.max(-1, body.mood - 0.05)
      // Sync emotionVector (mirrors bodyOnCorrection but without double body state update)
      const clamp = (v: number) => Math.max(-1, Math.min(1, v))
      emotionVector.certainty = clamp(emotionVector.certainty - 0.2)
      emotionVector.dominance = clamp(emotionVector.dominance - 0.1)
      emotionVector.pleasure = clamp(emotionVector.pleasure - 0.15)
    } else {
      hints.push('新用户反馈，可能是期望管理问题，温和对待')
      // Minimal impact — might just be expectation mismatch
      body.alertness = Math.min(1.0, body.alertness + 0.05)
      // Sync emotionVector (lighter — halved deltas for new user)
      const clamp = (v: number) => Math.max(-1, Math.min(1, v))
      emotionVector.certainty = clamp(emotionVector.certainty - 0.1)
      emotionVector.dominance = clamp(emotionVector.dominance - 0.05)
      emotionVector.pleasure = clamp(emotionVector.pleasure - 0.08)
    }
    // brain removed — feedback now handled by patterns.ts success tracking
  }

  // Emotional handling
  if (attention.type === 'emotional') {
    const neg = EMOTION_NEGATIVE.some(w => msg.includes(w))
    if (neg) {
      hints.push('用户情绪不好，先共情再回答，不要急着给建议')
      body.mood = Math.max(-1, body.mood - 0.15)
    } else {
      hints.push('用户情绪积极，可以轻松互动')
      body.mood = Math.min(1, body.mood + 0.1)
    }
  }

  // Strategy hints
  if (strategy === 'direct') hints.push('简短回答即可')
  if (strategy === 'opinion_with_reasoning') hints.push('给出明确立场和理由，不说"各有优劣"')
  if (strategy === 'action_oriented') hints.push('先给代码/方案，再解释')
  if (strategy === 'empathy_first') hints.push('先共情，再提供帮助')
  if (strategy === 'acknowledge_and_retry') hints.push('先承认错误，再给出正确答案')

  // SYNC implicit feedback (fast, for immediate body state)
  const implicit = detectImplicitFeedbackSync(msg, lastResponseContent)
  if (implicit === 'too_verbose') {
    body.energy = Math.max(0, body.energy - 0.03)
    hints.push('上次回答可能太长了，这次简洁些')
  } else if (implicit === 'silent_accept') {
    // brain removed
  } else if (implicit === 'positive') {
    bodyOnPositiveFeedback()
    // brain removed
  }

  // Tier-based strategy adjustment
  if (senderId) {
    const tier = getProfileTier(senderId)
    if (tier === 'owner') {
      hints.push('主人在说话，技术深度优先，少废话')
    } else if (tier === 'new') {
      hints.push('新用户，耐心观察，先了解对方再适配风格')
    }
  }

  return { hints, intent, strategy, attention: attention.type, complexity }
}
