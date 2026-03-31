/**
 * behavior-prediction.ts — 行为预测模块
 *
 * 独立的行为预测核心逻辑：基于 domain 频率的预言模式 + 基于 Memory 模式匹配的行为预测。
 * handler-augments.ts 仅调用此模块并注入结果作为 augment。
 */

import type { Memory } from './types.ts'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { DATA_DIR } from './persistence.ts'
import { detectDomain } from './epistemic.ts'
import { getPersonModel } from './person-model.ts'
import { getValueContext } from './values.ts'

// ── Prediction Mode (预言模式) ──

export interface Prediction {
  prediction: string
  basis: string
  domain: string
  createdAt: number
  expiresAt: number
  status: 'pending' | 'hit' | 'missed'
  hitAt: number | null
  confidence: number
}

const PREDICTIONS_PATH = resolve(DATA_DIR, 'predictions.json')
const PREDICTION_TTL = 7 * 24 * 3600_000

function loadPredictions(): Prediction[] {
  try { return existsSync(PREDICTIONS_PATH) ? JSON.parse(readFileSync(PREDICTIONS_PATH, 'utf-8')) : [] } catch { return [] }
}

function savePredictions(ps: Prediction[]) {
  writeFileSync(PREDICTIONS_PATH, JSON.stringify(ps, null, 2))
}

/**
 * 检查已有预测是否命中（用户消息匹配了某个 pending 预测的 domain）
 */
export function checkPredictions(userMsg: string): { hitAugment: string | null } {
  const ps = loadPredictions()
  const now = Date.now()
  const domain = detectDomain(userMsg)
  let changed = false
  let hitAugment: string | null = null
  for (const p of ps) {
    if (p.status !== 'pending') continue
    if (now > p.expiresAt) { p.status = 'missed'; changed = true; continue }
    if (domain && domain === p.domain) {
      p.status = 'hit'; p.hitAt = now; changed = true
      const total = ps.filter(x => x.status !== 'pending').length
      const hits = ps.filter(x => x.status === 'hit').length
      const rate = total > 0 ? Math.round(hits / total * 100) : 0
      hitAugment = `[预言命中] 你之前的对话模式让我预测到你会问${domain}相关的问题，果然！（预测准确率: ${rate}%）— 在回复中自然地提一句"我就知道你会问这个"`
      break
    }
  }
  if (changed) savePredictions(ps)
  return { hitAugment }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BAYESIAN DOMAIN BELIEF (Beta-Bernoulli model)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 贝叶斯行为预测：用 Beta-Bernoulli 模型估计每个 domain 在当前 context 下被提及的概率
 * 比频率计数更好：
 * - 少量样本时有合理的先验（不会因为 1 次就 100% 预测）
 * - 输出是概率，不是 yes/no
 * - 自动处理新 domain（先验 = uniform）
 */
interface DomainBelief {
  alpha: number  // 成功次数 + 先验
  beta: number   // 失败次数 + 先验
  lastSeen: number
}

const _domainBeliefs = new Map<string, DomainBelief>()

export function updateDomainBelief(domain: string, appeared: boolean) {
  if (!_domainBeliefs.has(domain)) {
    _domainBeliefs.set(domain, { alpha: 1, beta: 1, lastSeen: Date.now() })  // 均匀先验
  }
  const b = _domainBeliefs.get(domain)!

  // 时间衰减：距上次更新超过 7 天，alpha 和 beta 各乘 0.95（让旧数据逐渐失效）
  const ageDays = (Date.now() - b.lastSeen) / 86400000
  if (ageDays > 7) {
    const decay = Math.pow(0.95, ageDays / 7)
    b.alpha = Math.max(1, b.alpha * decay)
    b.beta = Math.max(1, b.beta * decay)
  }

  if (appeared) b.alpha++
  else b.beta++
  b.lastSeen = Date.now()
}

export function predictDomainProbability(domain: string): number {
  const b = _domainBeliefs.get(domain)
  if (!b) return 0.1  // 未知 domain，低先验
  return b.alpha / (b.alpha + b.beta)  // Beta 均值
}

export function getTopPredictions(topN: number = 3): { domain: string; probability: number }[] {
  const predictions: { domain: string; probability: number }[] = []
  for (const [domain, belief] of _domainBeliefs) {
    // 只预测最近 14 天内活跃的 domain
    if (Date.now() - belief.lastSeen > 14 * 86400000) continue
    predictions.push({ domain, probability: predictDomainProbability(domain) })
  }
  return predictions.sort((a, b) => b.probability - a.probability).slice(0, topN)
}

/**
 * 在每条消息后更新所有活跃 domain 的贝叶斯信念
 * detectedDomain: 本条消息检测到的 domain（可能为 null）
 */
export function updateAllDomainBeliefs(detectedDomain: string | null) {
  // 更新检测到的 domain
  if (detectedDomain && detectedDomain !== 'general' && detectedDomain !== '通用' && detectedDomain !== '闲聊') {
    updateDomainBelief(detectedDomain, true)
  }
  // 对其他活跃 domain 更新为 "未出现"
  for (const [domain] of _domainBeliefs) {
    if (domain !== detectedDomain) {
      // 只对最近 14 天内活跃的 domain 更新 beta
      const b = _domainBeliefs.get(domain)!
      if (Date.now() - b.lastSeen < 14 * 86400000) {
        updateDomainBelief(domain, false)
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 基于聊天历史的 domain 频率生成新预测（已升级为贝叶斯估计）
 */
export function generateNewPredictions(chatHistory: { user: string }[]) {
  const recent = chatHistory.slice(-20)
  const freq: Record<string, number> = {}
  for (const h of recent) { const d = detectDomain(h.user); if (d && d !== 'general') freq[d] = (freq[d] || 0) + 1 }
  const ps = loadPredictions()
  const now = Date.now()
  const activePending = ps.filter(p => p.status === 'pending' && now < p.expiresAt)
  const pendingDomains = new Set(activePending.map(p => p.domain))
  let added = false
  // 更新贝叶斯信念（用频率数据喂入）
  for (const [domain, count] of Object.entries(freq)) {
    for (let i = 0; i < count; i++) updateDomainBelief(domain, true)
  }

  for (const [domain, count] of Object.entries(freq)) {
    // 贝叶斯替代硬编码阈值：概率 > 0.3 才生成预测（替代 count < 3）
    const prob = predictDomainProbability(domain)
    if (prob <= 0.3 || pendingDomains.has(domain)) continue
    if (activePending.length >= 5) break
    ps.push({ prediction: `用户近期频繁讨论${domain}，预计下次会问更深入的${domain}问题`, basis: `最近20条消息中出现${count}次${domain}相关话题（贝叶斯概率: ${Math.round(prob * 100)}%）`, domain, createdAt: now, expiresAt: now + PREDICTION_TTL, status: 'pending', hitAt: null, confidence: Math.min(prob + 0.1, 0.9) })
    activePending.push(ps[ps.length - 1])
    added = true
  }
  if (added) savePredictions(ps)
}

// ── Behavior Prediction (行为预测) ──

/** 时段标签 */
type TimeSlot = '早' | '午' | '晚' | '深夜'

function getTimeSlot(hour: number): TimeSlot {
  if (hour >= 6 && hour < 12) return '早'
  if (hour >= 12 && hour < 18) return '午'
  if (hour >= 18 && hour < 23) return '晚'
  return '深夜'
}

/**
 * 基于时段的行为预测 — 分析聊天历史中各时段的 topic 分布，
 * 预测当前时段用户最可能问的话题。
 */
export function getTimeSlotPrediction(chatHistory: { user: string; ts: number }[]): string | null {
  if (chatHistory.length < 10) return null
  const currentSlot = getTimeSlot(new Date().getHours())
  const slotTopics: Record<TimeSlot, Record<string, number>> = { '早': {}, '午': {}, '晚': {}, '深夜': {} }
  for (const h of chatHistory) {
    const hh = new Date(h.ts).getHours()
    const slot = getTimeSlot(hh)
    const dom = detectDomain(h.user)
    slotTopics[slot][dom] = (slotTopics[slot][dom] || 0) + 1
  }
  const currentTopics = slotTopics[currentSlot]
  if (!currentTopics || Object.keys(currentTopics).length === 0) return null
  const sorted = Object.entries(currentTopics).sort((a, b) => b[1] - a[1])
  const topTopic = sorted[0][0]
  // 贝叶斯辅助判断：结合频率和 domain 概率（替代硬编码 >= 3）
  const topicProb = predictDomainProbability(topTopic)
  if (topTopic !== '通用' && topTopic !== '闲聊' && (sorted[0][1] >= 3 || topicProb > 0.3)) {
    return `[预测] 根据你的习惯，这个时段你通常问 ${topTopic} 相关的问题`
  }
  return null
}

/**
 * 综合行为预测入口 — 基于用户消息和记忆进行多维预测。
 *
 * 模式匹配策略：
 * 1. 重复话题检测：用户反复提到同一 scope 的记忆，预测下次提问方向
 * 2. 情绪模式检测：连续负面情绪记忆，预测用户可能需要支持
 * 3. 周期性行为：基于记忆时间戳检测周期性话题
 *
 * @returns augment 字符串，如果无有效预测返回 null
 */
export function getBehaviorPrediction(userMsg: string, memories: Memory[]): string | null {
  if (memories.length < 5) return null

  const now = Date.now()
  const recentWindow = 3 * 24 * 3600_000 // 3 天
  const recentMemories = memories.filter(m => now - m.ts < recentWindow)
  if (recentMemories.length < 3) return null

  // ── 策略 1: 重复话题聚焦 ──
  // 如果最近记忆中某个 scope 出现 >= 4 次，预测用户仍在关注该方向
  const scopeCount: Record<string, number> = {}
  for (const m of recentMemories) {
    if (m.scope && m.scope !== 'event') {
      scopeCount[m.scope] = (scopeCount[m.scope] || 0) + 1
    }
  }
  const topScope = Object.entries(scopeCount).sort((a, b) => b[1] - a[1])[0]
  if (topScope && topScope[1] >= 4) {
    const scopeLabel = topScope[0]
    // 提取最近一条该 scope 的记忆内容作为线索
    const latest = recentMemories.filter(m => m.scope === scopeLabel).slice(-1)[0]
    if (latest) {
      const snippet = latest.content.slice(0, 50)
      return `[行为预测] 用户近期高度关注「${scopeLabel}」类话题（3天内${topScope[1]}条记忆），最近线索: "${snippet}"。回复时可以主动关联这个方向。`
    }
  }

  // ── 策略 2: 情绪趋势预测 ──
  const emotionMemories = recentMemories.filter(m => m.emotion && m.emotion !== 'neutral')
  if (emotionMemories.length >= 3) {
    const negativeCount = emotionMemories.filter(m => m.emotion === 'painful').length
    if (negativeCount >= 2 && negativeCount / emotionMemories.length >= 0.5) {
      return `[行为预测] 用户近期情绪偏低（${negativeCount}/${emotionMemories.length}条情绪记忆为负面），回复时注意语气温和、主动提供情感支持。`
    }
  }

  // ── 策略 3: 领域深化预测 ──
  // 如果用户当前消息的 domain 在记忆中有递进式出现，预测会深入
  const domain = detectDomain(userMsg)
  if (domain && domain !== 'general' && domain !== '通用' && domain !== '闲聊') {
    const domainMemories = recentMemories.filter(m => {
      const mDomain = detectDomain(m.content)
      return mDomain === domain
    })
    // 贝叶斯辅助：结合记忆数量和 domain 概率判断
    const domProb = predictDomainProbability(domain)
    if (domainMemories.length >= 3 || (domainMemories.length >= 2 && domProb > 0.4)) {
      return `[行为预测] 用户在「${domain}」领域已积累${domainMemories.length}条近期记忆（贝叶斯概率: ${Math.round(domProb * 100)}%），可能正在深入学习/探索。回复时可以提升深度、给出进阶建议。`
    }
  }

  return null
}

// ── PPM (Prediction by Partial Matching) Trie for Topic Sequence Prediction ──

interface PPMTrieNode {
  children: Record<string, PPMTrieNode>
  counts: Record<string, number>  // next → count
  total: number
  escape: number  // times we needed to escape to shorter context
}

interface PPMState {
  root: PPMTrieNode
  maxOrder: number
  totalUpdates: number
}

const PPM_PATH = resolve(DATA_DIR, 'ppm_state.json')
let ppmState: PPMState = { root: { children: {}, counts: {}, total: 0, escape: 0 }, maxOrder: 3, totalUpdates: 0 }

function createPPMNode(): PPMTrieNode {
  return { children: {}, counts: {}, total: 0, escape: 0 }
}

function loadPPMState() {
  try {
    if (existsSync(PPM_PATH)) {
      const raw = JSON.parse(readFileSync(PPM_PATH, 'utf-8'))
      if (raw && raw.root) {
        ppmState = raw
      }
    }
    // Migrate from old Markov format if PPM doesn't exist yet
    const MARKOV_PATH = resolve(DATA_DIR, 'markov_state.json')
    if (ppmState.totalUpdates === 0 && existsSync(MARKOV_PATH)) {
      try {
        const old = JSON.parse(readFileSync(MARKOV_PATH, 'utf-8'))
        if (old && old.transitions) {
          // Convert old transitions to PPM trie
          for (const [key, nexts] of Object.entries(old.transitions)) {
            const ctx = key.split('\u2192')
            for (const [next, count] of Object.entries(nexts as Record<string, number>)) {
              for (let i = 0; i < count; i++) ppmUpdate(ctx, next)
            }
          }
          ppmState.totalUpdates = old.totalUpdates || ppmState.totalUpdates
          savePPMState()
        }
      } catch { /* migration is best-effort */ }
    }
  } catch { /* keep default */ }
}

function savePPMState() {
  writeFileSync(PPM_PATH, JSON.stringify(ppmState, null, 2))
}

let _ppmLoaded = false
function ensurePPMLoaded() {
  if (!_ppmLoaded) { loadPPMState(); _ppmLoaded = true }
}

/** PPM update: record a transition across all context orders */
function ppmUpdate(context: string[], next: string, maxOrder = 3) {
  for (let order = 0; order <= Math.min(maxOrder, context.length); order++) {
    const ctx = context.slice(-order)
    let node = ppmState.root
    for (const t of ctx) {
      if (!node.children[t]) node.children[t] = createPPMNode()
      node = node.children[t]
    }
    node.counts[next] = (node.counts[next] || 0) + 1
    node.total++
  }
}

/** PPM predict: try longest context first, escape to shorter on miss */
function ppmPredict(context: string[], maxOrder = 3): { topic: string; confidence: number } | null {
  for (let order = Math.min(maxOrder, context.length); order >= 0; order--) {
    const ctx = context.slice(-order)
    let node = ppmState.root
    let found = true
    for (const t of ctx) {
      if (!node.children[t]) { found = false; break }
      node = node.children[t]
    }
    if (!found || node.total < 3) continue  // 需要至少3个样本

    // 找最可能的下一个
    let bestTopic = ''
    let bestCount = 0
    for (const [topic, count] of Object.entries(node.counts)) {
      if (count > bestCount) { bestCount = count; bestTopic = topic }
    }
    if (bestTopic) {
      const rawConfidence = bestCount / node.total
      // 结合贝叶斯概率调整置信度
      const bayesProb = predictDomainProbability(bestTopic)
      const adjustedConfidence = rawConfidence * 0.7 + bayesProb * 0.3
      return { topic: bestTopic, confidence: adjustedConfidence }
    }
  }
  return null
}

/** Record a topic transition: updates PPM trie at all orders */
export function updateMarkov(topicSequence: string[]) {
  ensurePPMLoaded()
  if (topicSequence.length < 2) return
  const last = topicSequence[topicSequence.length - 1]
  const context = topicSequence.slice(0, -1)

  ppmUpdate(context, last, ppmState.maxOrder)
  ppmState.totalUpdates++

  // Prune: cap trie depth nodes (approximate — count root's direct children)
  const rootChildCount = Object.keys(ppmState.root.children).length
  if (rootChildCount > 200) {
    // Remove least-used root children
    const sorted = Object.entries(ppmState.root.children)
      .map(([k, v]) => ({ key: k, total: v.total }))
      .sort((a, b) => a.total - b.total)
    for (let i = 0; i < 50 && i < sorted.length; i++) {
      delete ppmState.root.children[sorted[i].key]
    }
  }

  savePPMState()
}

/**
 * PPM (Prediction by Partial Matching): try highest order first, escape to shorter.
 * Returns predicted next topic + confidence, or null.
 */
export function predictNextTopic(recentTopics: string[]): { topic: string; confidence: number } | null {
  ensurePPMLoaded()
  if (recentTopics.length === 0 || ppmState.totalUpdates < 5) return null
  return ppmPredict(recentTopics, ppmState.maxOrder)
}

/** Format Markov prediction as augment string */
export function getMarkovPredictionAugment(recentTopics: string[]): string | null {
  const pred = predictNextTopic(recentTopics)
  if (!pred || pred.confidence < 0.4) return null
  return `[序列预测] 根据话题序列模式(${recentTopics.slice(-2).join('→')}→?)，预测下一个话题: ${pred.topic}（置信度: ${Math.round(pred.confidence * 100)}%）`
}

// ── Decision Prediction (决策预测) ──

const DECISION_RE = /该选|该用|要不要|哪个好|怎么选|还是|which|should\s+i|choose|vs|对比|选哪/i

/** Detect if a message is a decision-type question */
export function isDecisionQuestion(msg: string): boolean {
  return DECISION_RE.test(msg)
}

/**
 * Predict what the user would likely decide based on past patterns.
 * Searches memories for similar past decisions, checks value priorities
 * and person-model thinking style. No LLM calls.
 *
 * @returns prediction string or null if insufficient evidence
 */
export function predictUserDecision(situation: string, memories: Memory[], userId?: string): string | null {
  if (memories.length < 5) return null

  const patterns: string[] = []

  // ── 1. Search memories for past decisions (preference + correction scopes) ──
  const sitLower = situation.toLowerCase()
  const decisionMemories = memories.filter(m =>
    (m.scope === 'preference' || m.scope === 'correction' || m.scope === 'opinion') &&
    m.content.length > 5
  )
  // Find memories that share keywords with current situation
  const sitWords = (sitLower.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase())
  const relevant = decisionMemories.filter(m => {
    const mc = m.content.toLowerCase()
    return sitWords.some(w => mc.includes(w))
  }).slice(-5)
  if (relevant.length > 0) {
    patterns.push(`过去相关选择: "${relevant[relevant.length - 1].content.slice(0, 60)}"`)
  }

  // ── 2. Check value priorities ──
  const valueCtx = getValueContext(userId)
  if (valueCtx) patterns.push(valueCtx)

  // ── 3. Check person model for thinking style ──
  const pm = getPersonModel()
  if (pm.thinkingStyle) patterns.push(`思维风格: ${pm.thinkingStyle.slice(0, 60)}`)
  if (pm.values.length > 0) {
    // Find value that's most relevant to the situation
    const relVal = pm.values.find(v => sitWords.some(w => v.toLowerCase().includes(w)))
    if (relVal) patterns.push(`相关价值观: ${relVal.slice(0, 60)}`)
  }

  if (patterns.length === 0) return null

  return `[决策预测] 根据你之前的选择模式，${patterns.join('；')} — 基于这些倾向给出符合用户风格的建议`
}
