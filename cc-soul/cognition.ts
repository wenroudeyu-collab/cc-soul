/**
 * cognition.ts — Cognition Pipeline (SYNC)
 *
 * Attention gate, intent detection, strategy selection, implicit feedback.
 * Ported from handler.ts lines 444-570 with attention gate false-positive fix.
 */

import type { CogResult, IntentSpectrum, EntropyFeedbackResult } from './types.ts'
import { body, bodyOnCorrection, bodyOnPositiveFeedback, emotionVector } from './body.ts'
import { getProfile, getProfileTier } from './user-profiles.ts'
import { CORRECTION_WORDS, CORRECTION_EXCLUDE, EMOTION_ALL, EMOTION_NEGATIVE, TECH_WORDS, CASUAL_WORDS } from './signals.ts'
import { DATA_DIR, loadJson, debouncedSave } from './persistence.ts'
import { resolve } from 'path'

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

  // Pick winner via softmax — 分数差距大时高优先级，差距小时中性
  hypotheses.sort((a, b) => b.score - a.score)
  const winner = hypotheses[0]
  const expScores = hypotheses.map(h => Math.exp(h.score * 2))
  const sumExp = expScores.reduce((s, e) => s + e, 0)
  const winnerProb = expScores[0] / sumExp
  const priority = Math.min(10, Math.max(1, Math.round(winnerProb * 10)))
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

// ── Algorithm: Intent Spectrum (意图光谱) ──
// 不是分类为单一意图，而是输出连续多维评分
// 每个维度独立评分 [0-1]，可以同时有多种需求
// 认知科学基础：人的意图不是离散的分类，是连续的需求组合

export function computeIntentSpectrum(msg: string): IntentSpectrum {
  const len = msg.length
  const spectrum: IntentSpectrum = { information: 0.3, action: 0.1, emotional: 0.1, validation: 0.1, exploration: 0.1 }

  // 信息需求信号
  const infoSignals = (msg.match(/什么|怎么|为什么|哪个|多少|是不是|如何|区别|对比|原理/g) || []).length
  spectrum.information = Math.min(1, 0.2 + infoSignals * 0.2)

  // 行动需求信号
  const actionSignals = (msg.match(/帮我|做|写|改|实现|生成|创建|删除|修复|部署|安装|配置/g) || []).length
  spectrum.action = Math.min(1, actionSignals * 0.3)

  // 情感需求信号
  const emotionSignals = (msg.match(/烦|累|难受|焦虑|开心|郁闷|崩溃|压力|害怕|纠结|迷茫|无聊|孤独/g) || []).length
  spectrum.emotional = Math.min(1, emotionSignals * 0.35)

  // 验证需求信号
  const validationSignals = (msg.match(/对吗|是吧|可以吗|行不行|这样[好行对]|没问题吧|对不对/g) || []).length
  spectrum.validation = Math.min(1, validationSignals * 0.4)

  // 探索需求信号
  const explorationSignals = (msg.match(/有没有.*更|还有.*方法|其他|替代|更好|优化|改进|推荐/g) || []).length
  spectrum.exploration = Math.min(1, explorationSignals * 0.3)

  // 消息长度调节：长消息通常信息/行动需求高
  if (len > 100) { spectrum.information *= 1.2; spectrum.action *= 1.1 }
  // 短消息通常情感/验证需求高
  if (len < 15) { spectrum.emotional *= 1.3; spectrum.validation *= 1.2 }

  // 归一化到 [0, 1]
  for (const key of Object.keys(spectrum) as (keyof IntentSpectrum)[]) {
    spectrum[key] = Math.min(1, Math.max(0, spectrum[key]))
  }

  return spectrum
}

// ── Algorithm: Entropy Feedback (信息熵隐式反馈) ──
// 用信息论量化用户回复的"信息量"
// 高熵 = 用户给了很多新信息 = 对话有效
// 低熵 = "嗯""好""谢谢" = 可能结束或不满意
// 零 = 无回复 = 明确不满
// 基于 Shannon entropy: H = -Σ p(x) log₂ p(x)

export function computeResponseEntropy(userReply: string, prevBotResponse: string): EntropyFeedbackResult {
  if (!userReply || userReply.length < 2) return { entropy: 0, signal: 'disengaged' }

  // 提取用户回复中的独立词汇
  const userWords = new Set((userReply.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase()))
  // 提取 bot 回复中的词汇
  const botWords = new Set((prevBotResponse.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase()))

  // 计算用户回复中的"新信息"比例（不在 bot 回复中的词）
  let newWords = 0
  for (const w of userWords) {
    if (!botWords.has(w)) newWords++
  }
  const noveltyRatio = userWords.size > 0 ? newWords / userWords.size : 0

  // 字符级 Shannon 熵
  const charFreq = new Map<string, number>()
  for (const ch of userReply) {
    charFreq.set(ch, (charFreq.get(ch) || 0) + 1)
  }
  let entropy = 0
  for (const count of charFreq.values()) {
    const p = count / userReply.length
    if (p > 0) entropy -= p * Math.log2(p)
  }

  // 综合评分
  const combinedScore = entropy * 0.5 + noveltyRatio * 0.5

  // 判定
  const signal = combinedScore > 0.5 ? 'engaged'
    : combinedScore > 0.2 ? 'passive'
    : 'disengaged'

  return { entropy: combinedScore, signal }
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

// ── Online Naive Bayes Intent Classifier ──

interface NBClassState {
  classes: Record<string, { wordCounts: Record<string, number>; totalWords: number; docCount: number }>
  totalDocs: number
}

const NB_PATH = resolve(DATA_DIR, 'nb_classifier.json')
let nbClassifier: NBClassState = loadJson<NBClassState>(NB_PATH, { classes: {}, totalDocs: 0 })

function nbTokenize(msg: string): string[] {
  return (msg.match(/[\u4e00-\u9fff]{2,4}|[a-zA-Z]{3,}/gi) || []).map(w => w.toLowerCase())
}

/** Online update: add a confirmed intent sample */
export function updateNBClassifier(msg: string, cls: string) {
  const words = nbTokenize(msg)
  if (words.length === 0) return
  if (!nbClassifier.classes[cls]) {
    nbClassifier.classes[cls] = { wordCounts: {}, totalWords: 0, docCount: 0 }
  }
  const c = nbClassifier.classes[cls]
  c.docCount++
  nbClassifier.totalDocs++
  for (const w of words) {
    c.wordCounts[w] = (c.wordCounts[w] || 0) + 1
    c.totalWords++
  }
  debouncedSave(NB_PATH, nbClassifier)
}

/** Predict intent probabilities via Naive Bayes with Laplace smoothing */
function predictNB(msg: string): Record<string, number> {
  if (nbClassifier.totalDocs < 50) return {}  // need enough data before overriding rule-based classification
  const words = nbTokenize(msg)
  if (words.length === 0) return {}

  const scores: Record<string, number> = {}
  for (const [cls, c] of Object.entries(nbClassifier.classes)) {
    let logProb = Math.log(c.docCount / nbClassifier.totalDocs)
    const vocab = c.totalWords + 1000  // Laplace smoothing denominator
    for (const w of words) {
      const count = c.wordCounts[w] || 0
      logProb += Math.log((count + 1) / vocab)
    }
    scores[cls] = logProb
  }
  return scores
}

/** Apply NB correction to attention gate result */
function nbCorrectAttention(baseType: string, msg: string): string {
  const nbScores = predictNB(msg)
  if (Object.keys(nbScores).length === 0) return baseType

  // Find NB's top prediction
  let bestCls = baseType, bestScore = -Infinity
  for (const [cls, score] of Object.entries(nbScores)) {
    if (score > bestScore) { bestScore = score; bestCls = cls }
  }

  // Only override if NB is significantly more confident than base
  // (NB score for base type is much lower than NB's top)
  const baseScore = nbScores[baseType]
  if (baseScore !== undefined && bestScore - baseScore > 2.0 && bestCls !== baseType) {
    return bestCls
  }
  return baseType
}

// ── Online Passive-Aggressive Classifier (PA-I) ──
// 替代硬编码意图权重，只在犯错时更新，比 NB 更节约计算

interface PAClassifier {
  weights: Record<string, Record<string, number>>  // class → feature → weight
  C: number  // aggressiveness parameter
  samples: number  // total update count
}

const PA_PATH = resolve(DATA_DIR, 'pa_classifier.json')
let paClassifier: PAClassifier = loadJson<PAClassifier>(PA_PATH, { weights: {}, C: 0.5, samples: 0 })

function paPredict(pa: PAClassifier, features: Record<string, number>): string {
  let bestClass = 'general'
  let bestScore = -Infinity
  for (const [cls, w] of Object.entries(pa.weights)) {
    let score = 0
    for (const [feat, val] of Object.entries(features)) {
      score += (w[feat] || 0) * val
    }
    if (score > bestScore) { bestScore = score; bestClass = cls }
  }
  return bestClass
}

function paUpdate(pa: PAClassifier, features: Record<string, number>, trueClass: string, predictedClass: string) {
  if (trueClass === predictedClass) return  // 正确，不更新
  // PA-I update
  const featureNorm = Object.values(features).reduce((s, v) => s + v * v, 0)
  if (featureNorm === 0) return

  // 计算 hinge loss
  let trueScore = 0, predScore = 0
  const wTrue = pa.weights[trueClass] || {}
  const wPred = pa.weights[predictedClass] || {}
  for (const [f, v] of Object.entries(features)) {
    trueScore += (wTrue[f] || 0) * v
    predScore += (wPred[f] || 0) * v
  }
  const loss = Math.max(0, 1 - (trueScore - predScore))
  const tau = Math.min(pa.C, loss / (2 * featureNorm))

  // 更新权重
  if (!pa.weights[trueClass]) pa.weights[trueClass] = {}
  if (!pa.weights[predictedClass]) pa.weights[predictedClass] = {}
  for (const [f, v] of Object.entries(features)) {
    pa.weights[trueClass][f] = (pa.weights[trueClass][f] || 0) + tau * v
    pa.weights[predictedClass][f] = (pa.weights[predictedClass][f] || 0) - tau * v
  }
  pa.samples++
  debouncedSave(PA_PATH, pa)
}

/** Extract feature vector from message for PA classifier */
function extractPAFeatures(msg: string): Record<string, number> {
  const m = msg.toLowerCase()
  const correctionHits = CORRECTION_WORDS.filter(w => m.includes(w)).length
  const emotionHits = EMOTION_ALL.filter(w => m.includes(w)).length
  const negEmotionHits = EMOTION_NEGATIVE.filter(w => m.includes(w)).length
  const techHits = TECH_WORDS.filter(w => m.includes(w)).length
  const casualHits = CASUAL_WORDS.filter(w => m === w || m === w + '的').length
  const len = msg.length
  return {
    correctionHits,
    emotionHits,
    negEmotionHits,
    techHits,
    casualHits,
    lenShort: len < 15 ? 1 : 0,
    lenMedium: len >= 15 && len <= 100 ? 1 : 0,
    lenLong: len > 100 ? 1 : 0,
    lenVeryShort: len < 8 ? 1 : 0,
  }
}

/** PA-corrected attention type: weighted fusion with Bayesian gate */
function paCorrectAttention(baseType: string, msg: string): string {
  const features = extractPAFeatures(msg)
  const paPrediction = paPredict(paClassifier, features)

  // 加权融合：PA 积累够样本后权重升高
  // PA < 50 samples: PA 0.4 + Bayesian 0.6
  // PA >= 50 samples: PA 0.6 + Bayesian 0.4
  const paWeight = paClassifier.samples >= 50 ? 0.6 : 0.4

  // 如果 PA 和 Bayesian 一致，直接用
  if (paPrediction === baseType) return baseType

  // PA 权重足够高且有足够样本时覆盖 Bayesian
  if (paWeight >= 0.6 && paClassifier.samples >= 50) return paPrediction

  // 否则保持 Bayesian 结果
  return baseType
}

// ── Main Entry ──

export function cogProcess(msg: string, lastResponseContent: string, lastPrompt: string, senderId?: string): CogResult {
  const attention = attentionGate(msg)
  // NB correction: refine attention type using online-learned classifier
  attention.type = nbCorrectAttention(attention.type, msg)
  // PA correction: weighted fusion with Bayesian gate
  const paFeatures = extractPAFeatures(msg)
  const paPredicted = paPredict(paClassifier, paFeatures)
  attention.type = paCorrectAttention(attention.type, msg)
  const intent = detectIntent(msg)
  const intentSpectrum = computeIntentSpectrum(msg)
  const complexity = Math.min(1, msg.length / 500)
  const strategy = decideStrategy(attention, intent, msg.length)
  const hints: string[] = []

  // NB online learning: correction → train NB with correct label
  if (attention.type === 'correction') {
    updateNBClassifier(lastResponseContent || msg, 'correction')
  } else if (attention.type === 'emotional') {
    updateNBClassifier(msg, 'emotional')
  } else if (attention.type === 'technical') {
    updateNBClassifier(msg, 'technical')
  } else if (attention.type === 'casual') {
    updateNBClassifier(msg, 'casual')
  }

  // PA online learning: update PA classifier when Bayesian gate gives a confident label
  // PA only updates on mistakes, so feed it the Bayesian-determined label as ground truth
  paUpdate(paClassifier, paFeatures, attention.type, paPredicted)

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
  const entropyFeedback = computeResponseEntropy(msg, lastResponseContent)
  // Entropy feedback supplements implicit feedback: low entropy + disengaged = additional verbosity signal
  if (entropyFeedback.signal === 'disengaged' && !implicit) {
    hints.push('用户回复信息量很低，可能在敷衍或准备结束对话')
  }
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

  return { hints, intent, strategy, attention: attention.type, complexity, spectrum: intentSpectrum, entropyFeedback }
}
