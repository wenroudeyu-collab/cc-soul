/**
 * activation-field.ts — NAM: Neural Activation Memory（神经激活记忆）
 *
 * cc-soul 原创核心算法。记忆不是被"搜索"的，是自己"冒出来"的。
 * 将传统搜索（BM25/Trigram/向量）统一为单一激活场模型。
 * 无需外部模型，从用户交互中自主学习语义关联。
 *
 * 一个系统，4 种频率：
 *   每条消息（<30ms）：更新激活值 → 编码 + 召回
 *   每分钟：自然衰减 → 遗忘
 *   每小时：FSRS检查 + 巩固 + Anti-Hebbian清理
 *   每天：蒸馏 + 周期学习 + FSRS个性化
 *
 * 7 个激活信号（乘法组合）：
 *   ① 基础激活（ACT-R：频率 + 新近性）
 *   ② 上下文匹配（BM25F多字段加权 + AAM词扩展 + trigram融合）
 *   ③ 情绪共振（PADCN余弦 + 闪光灯 + 状态门控）
 *   ④ 扩散激活（邻居激活 × 连接权重 + 微连接涌现）
 *   ⑤ 干扰抑制（相似记忆竞争 + Anti-Hebbian + RIF持久衰减）
 *   ⑥ 时间语境（编码特异性 + recallContexts匹配 + 双振荡器 + 测试效应）
 *   ⑦ 时序共现（PAM有向链接：用户说A后常说B → 说A时含B的记忆boost）
 */

import type { Memory } from './types.ts'
import { trigrams, trigramSimilarity, tokenize as _utilTokenize } from './memory-utils.ts'
import { expandQuery as _aamExpandQuery, learnAssociation as _aamLearn, isKnownWord as _aamIsKnownWord, getTemporalSuccessors as _aamGetTemporalSuccessors, getAAMNeighbors as _aamGetAAMNeighbors, isJunkToken as _aamIsJunkToken } from './aam.ts'
// 顶层 import 替代运行时 require（修复 benchmark ESM 环境下 require is not defined）
import { extractTimeRange as _extractTimeRange, _primingCache as _primingCacheRef } from './memory-recall.ts'
import { extractTagsLocal as _extractTagsLocal } from './memory.ts'

// ═══════════════════════════════════════════════════════════════
// ActivationTrace — 召回路径溯源（服务于 AAM 正负反馈、decision-log、A/B 归因、MAGMA 验证）
// ═══════════════════════════════════════════════════════════════

export interface TraceStep {
  stage: 'candidate_selection' | 'signal_boost' | 'signal_suppress'
  via: string  // 'bm25' | 'aam_hop1' | 'aam_hop2' | 'graph' | 'cin' | 'system1_fact' | 'priming' | 'emotion' | 'recency' | 'interference' | 'mmr' | 'base_activation' | 'temporal' | 'confidence' | 'importance'
  word?: string
  rawScore: number
}

export interface ActivationTrace {
  memory: Memory
  score: number
  path: TraceStep[]
}

export interface RejectionRecord {
  content: string
  originalRank: number
  finalRank: number
  reason: 'interference' | 'mmr_dedup' | 'below_threshold' | 'budget_cut'
}

// 内存缓存：最近 3 轮的 trace，用 Date.now() 作 key
const _traceBuffer = new Map<number, { traces: ActivationTrace[]; rejections: RejectionRecord[] }>()

// ── Recall Thermostat: learn which signals correlate with engaged memories ──
const _signalBuffer: { engaged: boolean; signals: { base: number; context: number; emotion: number; spread: number; temporal: number } }[] = []

export function recordRecallEngagement(engaged: boolean, signals: Record<string, number>): void {
  _signalBuffer.push({ engaged, signals: {
    base: signals.base || 0, context: signals.context || 0,
    emotion: signals.emotion || 0, spread: signals.spread || 0,
    temporal: signals.temporal || 0,
  }})
  if (_signalBuffer.length > 200) _signalBuffer.shift()

  if (_signalBuffer.length % 50 === 0 && _signalBuffer.length >= 50) {
    adjustSignalWeights()
  }
}

let _baseWeight = 0.3
let _contextWeight = 0.7
export function getSignalWeights(): { base: number; context: number } {
  return { base: _baseWeight, context: _contextWeight }
}

function adjustSignalWeights(): void {
  const good = _signalBuffer.filter(s => s.engaged)
  const bad = _signalBuffer.filter(s => !s.engaged)
  if (good.length < 10 || bad.length < 5) return

  const avgGoodContext = good.reduce((s, g) => s + g.signals.context, 0) / good.length
  const avgBadContext = bad.reduce((s, b) => s + b.signals.context, 0) / bad.length
  const avgGoodBase = good.reduce((s, g) => s + g.signals.base, 0) / good.length
  const avgBadBase = bad.reduce((s, b) => s + b.signals.base, 0) / bad.length

  const contextDelta = avgGoodContext - avgBadContext
  const baseDelta = avgGoodBase - avgBadBase

  // Conservative adjustment: ±0.02 per cycle, clamped to [0.15, 0.45] for base
  _baseWeight = Math.max(0.15, Math.min(0.45, _baseWeight + baseDelta * 0.02))
  _contextWeight = 1 - _baseWeight

  try { require('./decision-log.ts').logDecision('recall_thermostat', 'weight_adjust', `base=${_baseWeight.toFixed(3)}, ctx=${_contextWeight.toFixed(3)}, samples=${_signalBuffer.length}`) } catch {}
}

/** 获取最近 30 秒内的 trace（供 feedback 回溯用） */
export function getRecentTrace(): { traces: ActivationTrace[]; rejections: RejectionRecord[] } | null {
  const now = Date.now()
  const recent = [..._traceBuffer.entries()]
    .filter(([ts]) => now - ts < 30_000)
    .sort(([a], [b]) => b - a)
  return recent[0]?.[1] ?? null
}

/** 清理过期 trace（保留最近 3 轮） */
function pruneTraceBuffer() {
  if (_traceBuffer.size <= 3) return
  const sorted = [..._traceBuffer.keys()].sort((a, b) => a - b)
  while (sorted.length > 3) {
    _traceBuffer.delete(sorted.shift()!)
  }
}

// ═══════════════════════════════════════════════════════════════
// 对话惯性记忆（Conversational Momentum Memory）— cc-soul 原创
// EMA-based topic momentum: 持续讨论的话题维持高激活，即使偏题也不会骤降
// ═══════════════════════════════════════════════════════════════

const _topicMomentum = new Map<string, number>()  // topic → momentum score

// 按话题类型的衰减率（通过 detectDomain 判断）
const MOMENTUM_DECAY: Record<string, number> = {
  technical: 0.9,   // 工作项目：惯性持续 ~2 周
  emotional: 0.7,   // 生活琐事：~5 天
  default: 0.7,
}

/** 每条消息更新 momentum（在 activationRecall 中调用） */
function updateMomentum(query: string): void {
  // 检测 domain
  let domain = 'default'
  try {
    const { detectDomain } = require('./cognition.ts')
    domain = detectDomain(query) || 'default'
  } catch {}

  // 提取话题关键词
  const words = (query.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}/gi) || []).map(w => w.toLowerCase())

  // 每个关键词 +1
  for (const w of words) {
    const current = _topicMomentum.get(w) || 0
    _topicMomentum.set(w, current + 1)
  }

  // EMA 衰减（每次调用都衰减全量）
  const decayRate = MOMENTUM_DECAY[domain] || MOMENTUM_DECAY.default
  for (const [topic, score] of _topicMomentum) {
    const decayed = score * decayRate
    if (decayed < 0.1) _topicMomentum.delete(topic)
    else _topicMomentum.set(topic, decayed)
  }
}

/** 获取记忆的 momentum 加成（capped at +50%） */
export function getMomentumBoost(memContent: string): number {
  const words = (memContent.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}/gi) || []).map(w => w.toLowerCase())
  let totalMomentum = 0
  for (const w of words) {
    totalMomentum += _topicMomentum.get(w) || 0
  }
  if (words.length === 0) return 0
  // 归一化：每词平均 momentum × 0.1，上限 +50%
  return Math.min(0.5, (totalMomentum / words.length) * 0.1)
}

// ═══════════════════════════════════════════════════════════════
// ACTIVATION STATE — 每条记忆的实时激活值
// ═══════════════════════════════════════════════════════════════

const _activations = new Map<string, number>()  // memory content hash → activation value [0, 1]

// ── Lazy-loaded fact-store module ──
let _factStoreMod: any = null
function getFactStoreMod() {
  if (!_factStoreMod) try { _factStoreMod = require('./fact-store.ts') } catch {}
  return _factStoreMod
}

function memKey(mem: Memory): string {
  return `${(mem.content || '').slice(0, 50)}\0${mem.ts || 0}`
}

function getActivation(mem: Memory): number {
  return _activations.get(memKey(mem)) || 0
}

function setActivation(mem: Memory, value: number) {
  _activations.set(memKey(mem), Math.max(0, Math.min(1, value)))
}

// ═══════════════════════════════════════════════════════════════
// SIGNAL 1: 基础激活（ACT-R）
// ═══════════════════════════════════════════════════════════════

function baseActivation(mem: Memory, now: number): number {
  const n = Math.max(mem.recallCount || 1, 1)
  const createdAgo = Math.max((now - (mem.ts || now)) / 1000, 1)
  const lastAgo = Math.max((now - (mem.lastAccessed || mem.ts || now)) / 1000, 1)

  // ACT-R: B = ln(Σ t_i^(-d)), d=0.5
  let sum = 0
  const cap = Math.min(n, 50)
  if (cap === 1) {
    sum = Math.pow(lastAgo, -0.5)
  } else {
    for (let i = 0; i < cap; i++) {
      const fraction = i / (cap - 1)
      const accessAgo = createdAgo - fraction * (createdAgo - lastAgo)
      sum += Math.pow(Math.max(accessAgo, 1), -0.5)
    }
  }
  const rawB = sum > 0 ? Math.log(sum) : -5

  // 归一化到 [0, 1]，sigmoid 映射
  return 1 / (1 + Math.exp(-rawB - 1))
}

// ═══════════════════════════════════════════════════════════════
// SIGNAL 2: 上下文匹配（AAM 词扩展 + 关键词重叠 + trigram）
// ═══════════════════════════════════════════════════════════════

// ── 动态 IDF 缓存（在 computeActivationField 中一次性计算，避免 O(n²)）──
let _idfCache: Map<string, number> | null = null

/** 从 memory pool 计算动态 IDF：出现在越多记忆中的词权重越低 */
function buildIdfCache(memories: Memory[]): Map<string, number> {
  const docFreq = new Map<string, number>()
  const N = memories.length
  for (const mem of memories) {
    const content = mem.content || ''
    const seen = new Set<string>()
    // English 2+ letter words + numbers
    const enWords = content.match(/[a-zA-Z]{2,}|\d+/gi) || []
    for (const w of enWords) seen.add(w.toLowerCase())
    // CJK 2-char
    const cjk = content.match(/[\u4e00-\u9fff]+/g) || []
    for (const seg of cjk) {
      if (seg.length >= 2 && seg.length <= 4) seen.add(seg)
      for (let i = 0; i <= seg.length - 2; i++) seen.add(seg.slice(i, i + 2))
    }
    for (const w of seen) docFreq.set(w, (docFreq.get(w) || 0) + 1)
  }
  const idf = new Map<string, number>()
  for (const [word, df] of docFreq) {
    // IDF = log(N / df)，归一化到 [0.1, 1.0]
    const raw = Math.log(N / Math.max(1, df))
    const maxIdf = Math.log(N)  // 只出现 1 次的词
    idf.set(word, maxIdf > 0 ? Math.max(0.1, raw / maxIdf) : 1.0)
  }
  return idf
}

// ═══════════════════════════════════════════════════════════════
// Query-Type Adaptive Parameters（查询类型自适应 k1/b）
// ═══════════════════════════════════════════════════════════════

type QueryType = 'precise' | 'temporal' | 'broad'

interface QueryTypeParams { k1: number; b: number; temporalBoost: number }

const QUERY_TYPE_FACTORS: Record<QueryType, QueryTypeParams> = {
  precise:  { k1: 2.0,  b: 0.75, temporalBoost: 1.0 },
  temporal: { k1: 1.2,  b: 0.5,  temporalBoost: 2.0 },
  broad:    { k1: 0.8,  b: 0.3,  temporalBoost: 1.0 },
}

const PRECISE_RE = /什么|哪个|哪里|几[个岁号]|多少|谁是|who|what|where|when|how\s*many/i
const TEMPORAL_RE = /上次|之前|以前|上周|昨天|前天|上个月|最近|last|before|ago/i

let _currentQueryType: QueryType = 'broad'

function detectQueryType(query: string): QueryType {
  if (PRECISE_RE.test(query)) return 'precise'
  if (TEMPORAL_RE.test(query)) return 'temporal'
  return 'broad'
}

/** Get adaptive k1/b — uses auto-tune base × query-type factor */
function getAdaptiveParams(queryType: QueryType): QueryTypeParams {
  let baseK1 = 1.2, baseB = 0.75
  try {
    const { getParam } = require('./auto-tune.ts')
    baseK1 = getParam('memory.bm25_k1')
    baseB = getParam('memory.bm25_b')
  } catch {}
  const factor = QUERY_TYPE_FACTORS[queryType]
  return {
    k1: baseK1 * (factor.k1 / 1.2),  // normalize: default factor k1=1.2 → multiplier=1.0
    b: baseB * (factor.b / 0.75),     // normalize: default factor b=0.75 → multiplier=1.0
    temporalBoost: factor.temporalBoost,
  }
}

function contextMatch(query: string, mem: Memory, expandedWords: Map<string, number>): number {
  const content = mem.content || ''
  const contentLower = content.toLowerCase()

  // ── 方式 A：扩展词加权匹配（IDF 加权版）──
  const memWords = new Set<string>()
  const cjkSegs = content.match(/[\u4e00-\u9fff]+/g) || []
  for (const seg of cjkSegs) {
    if (seg.length >= 2 && seg.length <= 4) memWords.add(seg)
    if (seg.length > 4) {
      for (let i = 0; i <= seg.length - 2; i++) {
        const frag = seg.slice(i, i + 2)
        if (expandedWords.has(frag)) memWords.add(frag)
      }
      for (let len = 3; len <= Math.min(4, seg.length); len++) {
        for (let i = 0; i <= seg.length - len; i++) memWords.add(seg.slice(i, i + len))
      }
    }
    if (seg.length > 2 && seg.length <= 4) {
      for (let i = 0; i <= seg.length - 2; i++) memWords.add(seg.slice(i, i + 2))
    }
  }
  const enWords = content.match(/[a-zA-Z]{2,}|\d+/gi) || []
  for (const w of enWords) memWords.add(w.toLowerCase())

  // IDF 加权匹配 + BM25+ delta：高频词权重降低，长文档不被过度惩罚
  // k1 controls term saturation: higher = exact match matters more (precise queries)
  // b controls length normalization: higher = penalize long docs more
  const adaptiveParams = getAdaptiveParams(_currentQueryType)
  const BM25_DELTA = adaptiveParams.k1  // BM25+ lower-bound: precise→2.0, broad→0.8
  const lengthNorm = 1 - adaptiveParams.b + adaptiveParams.b * (memWords.size / Math.max(expandedWords.size, 1))
  // ── 双层计分：防止滑动窗口碎片词稀释分母 ──
  // Tier 1: AAM 扩展的质量词（同义词/概念词/3+字词）
  // Tier 2: 全部词（含 2-char 滑动窗口碎片）
  let tier1Hits = 0, tier1Total = 0
  let tier2Hits = 0, tier2Total = 0
  let tier1Count = 0, tier2Count = 0
  for (const [word, weight] of expandedWords) {
    const idfWeight = _idfCache?.get(word) ?? 1.0
    const effectiveWeight = weight * idfWeight
    // Tier 1: AAM 扩展词（weight >= 0.7）或 3+ 字且 weight >= 0.5
    const isTier1 = weight >= 0.7 || (weight >= 0.5 && word.length >= 3)
    const saturation = (adaptiveParams.k1 + 1) / (lengthNorm + adaptiveParams.k1)
    const hitValue = effectiveWeight * saturation + BM25_DELTA
    const maxValue = effectiveWeight * ((adaptiveParams.k1 + 1) / (1 + adaptiveParams.k1)) + BM25_DELTA
    if (isTier1) {
      tier1Total += maxValue
      tier1Count++
      if (memWords.has(word)) tier1Hits += hitValue
    }
    tier2Total += maxValue
    tier2Count++
    if (memWords.has(word)) tier2Hits += hitValue
  }
  const tier1Score = tier1Total > 0 ? tier1Hits / tier1Total : 0
  const tier2Score = tier2Total > 0 ? tier2Hits / tier2Total : 0
  // Tier 1 命中直接用，Tier 2 打 7 折（碎片词匹配不应得高分）
  const rawWordScore = Math.max(tier1Score, tier2Score * 0.7)
  // 最低门槛：覆盖率门槛随 query type 调整（broad 更宽松）
  const minCoverage = _currentQueryType === 'broad' ? 0.01 : 0.03
  const wordScore = rawWordScore < minCoverage ? 0 : rawWordScore

  // ── 方式 B：n-gram 短语匹配（连续词序列比独立词匹配更强）──
  // 从 query 提取 2-gram 和 3-gram，如果在记忆中完整出现则大幅加分
  const queryLower = query.toLowerCase()
  const queryTokens = (queryLower.match(/[\u4e00-\u9fff]{2,4}|[a-zA-Z]{2,}|\d+/gi) || []).map(w => w.toLowerCase())
  let phraseScore = 0
  if (queryTokens.length >= 2) {
    let phraseHits = 0, phrasePossible = 0
    // 2-gram
    for (let i = 0; i < queryTokens.length - 1; i++) {
      const bigram = queryTokens[i] + ' ' + queryTokens[i + 1]
      // 也检查无空格连续（中文）
      const bigramNoSpace = queryTokens[i] + queryTokens[i + 1]
      phrasePossible++
      if (contentLower.includes(bigram) || contentLower.includes(bigramNoSpace)) phraseHits++
    }
    // 3-gram
    for (let i = 0; i < queryTokens.length - 2; i++) {
      const trigram = queryTokens[i] + ' ' + queryTokens[i + 1] + ' ' + queryTokens[i + 2]
      phrasePossible++
      if (contentLower.includes(trigram)) phraseHits += 2  // 3-gram 命中权重更高
    }
    phraseScore = phrasePossible > 0 ? phraseHits / phrasePossible : 0
  }

  // ── 方式 C：trigram 模糊匹配 ──
  const triScore = trigramSimilarity(trigrams(query), trigrams(content))

  // BM25F 字段加权移到 rerank 阶段（只对 top-50），此处只算内容基础分
  return Math.max(wordScore, phraseScore * 1.2, triScore * 0.8)
}

// ═══════════════════════════════════════════════════════════════
// SIGNAL 3: 情绪共振（PADCN 余弦 + 闪光灯 + 状态门控）
// ═══════════════════════════════════════════════════════════════

function emotionResonance(mem: Memory, currentMood: number, currentAlertness: number): number {
  let score = 0.5  // 中性基线

  // 状态门控（Godden & Baddeley）：编码时和当前的情绪差距越大，越难召回
  if (mem.situationCtx?.mood !== undefined) {
    const moodDist = Math.abs(currentMood - mem.situationCtx.mood)
    const alertDist = Math.abs(currentAlertness - (mem.situationCtx.energy || 0.5))
    const stateDist = Math.sqrt(moodDist * moodDist + alertDist * alertDist)
    const gate = 1 / (1 + Math.exp(stateDist * 3 - 1.5))
    score *= Math.max(0.2, gate)
  }

  // 情绪一致性（Bower 1981）：心情好时更容易想起好事
  if (currentMood > 0.3 && mem.emotion === 'warm') score *= 1.4
  if (currentMood < -0.3 && mem.emotion === 'painful') score *= 1.4

  // 闪光灯效应（Cahill & McGaugh）：高情绪强度的记忆始终更容易浮现
  const ei = mem.emotionIntensity || 0
  if (ei >= 0.8) score *= 1.5
  else if (ei >= 0.5) score *= 1.2

  return Math.min(1, score)
}

// ═══════════════════════════════════════════════════════════════
// SIGNAL 4: 扩散激活（邻居激活值传播）
// ═══════════════════════════════════════════════════════════════

// ── AAM neighbor cache (lazy-loaded, avoids import side effects) ──
let _aamGetNeighbors: ((word: string, topK?: number) => { word: string; pmiScore: number; fanOut: number }[]) | null | false = null
function getAAMNeighborsFn(): typeof _aamGetNeighbors {
  if (_aamGetNeighbors === false) return null  // import failed before
  if (_aamGetNeighbors) return _aamGetNeighbors
  try {
    _aamGetNeighbors = _aamGetAAMNeighbors || false
    return _aamGetNeighbors || null
  } catch { _aamGetNeighbors = false; return null }
}

function spreadingActivation(mem: Memory, allMemories: Memory[], query?: string): number {
  const hasTags = mem.tags && mem.tags.length > 0
  const myTags = hasTags ? new Set(mem.tags!.map(t => t.toLowerCase())) : new Set<string>()
  let totalSpread = 0
  let count = 0

  // ── Path A: tag-based spreading (original) ──
  if (hasTags) {
    for (const other of allMemories) {
      if (other === mem || !other.tags || other.tags.length === 0) continue
      const otherActivation = getActivation(other)
      if (otherActivation < 0.2) continue

      const shared = other.tags.filter(t => myTags.has(t.toLowerCase())).length
      if (shared > 0) {
        totalSpread += otherActivation * (shared / Math.max(myTags.size, 1)) * 0.3
        count++
      }
      if (count >= 10) break
    }
  }

  // ── Path B: AAM co-occurrence fallback (when tags empty/insufficient) ──
  // Extract keywords from memory, look up AAM neighbors, match against query
  if (count < 3 && query) {
    const fn = getAAMNeighborsFn()
    if (fn) {
      // Extract keywords from memory content
      const memKeywords = (mem.content || '').match(/[\u4e00-\u9fff]{2,4}|[a-zA-Z]{3,}/gi) || []
      const queryLower = query.toLowerCase()
      const queryWords = new Set(
        (queryLower.match(/[\u4e00-\u9fff]{2,4}|[a-zA-Z]{3,}/gi) || []).map(w => w.toLowerCase())
      )

      let aamBoost = 0
      const visited = new Set<string>()  // avoid double-counting

      for (const kw of memKeywords.slice(0, 5)) {
        const kwLower = kw.toLowerCase()
        // 1-hop: direct AAM neighbors
        const neighbors = fn(kwLower, 5)
        for (const n of neighbors) {
          if (visited.has(n.word)) continue
          visited.add(n.word)
          if (queryWords.has(n.word)) {
            // Fan effect: high-fanout nodes contribute less
            const fanDamping = 1 / Math.sqrt(Math.max(1, n.fanOut))
            aamBoost += n.pmiScore / 5 * fanDamping  // normalize PMI to ~[0,1]
          }

          // 2-hop: neighbors of neighbors (with 0.3 damping)
          const hop2 = fn(n.word, 3)
          for (const n2 of hop2) {
            if (visited.has(n2.word)) continue
            visited.add(n2.word)
            if (queryWords.has(n2.word)) {
              const fanDamping2 = 1 / Math.sqrt(Math.max(1, n2.fanOut))
              aamBoost += n2.pmiScore / 5 * fanDamping2 * 0.3  // 2-hop damping
            }
          }
        }
      }

      totalSpread += Math.min(0.3, aamBoost)  // cap AAM contribution
    }
  }

  return Math.min(0.5, totalSpread)  // cap at 0.5 避免雪球效应
}

// ═══════════════════════════════════════════════════════════════
// SIGNAL 5: 干扰抑制（相似记忆竞争）
// ═══════════════════════════════════════════════════════════════

function interferenceSuppress(mem: Memory, currentTop: Memory[]): number {
  if (currentTop.length === 0) return 1.0  // 无竞争

  // Summary/consolidated memories get relaxed thresholds to avoid
  // session summaries suppressing each other when they share person names
  const isSummary = mem.scope === 'fact' || mem.scope === 'consolidated'
    || (mem.content || '').startsWith('[summary]')
    || (mem.content || '').startsWith('[Session')

  const memTri = trigrams(mem.content || '')
  for (const top of currentTop) {
    const sim = trigramSimilarity(memTri, trigrams(top.content || ''))
    if (isSummary) {
      // Relaxed: only suppress at very high similarity
      if (sim > 0.7) return 0.5
      if (sim > 0.5) return 0.8
    } else {
      // Original thresholds
      if (sim > 0.5) return 0.3  // 大幅压制
      if (sim > 0.3) return 0.7  // 轻微压制
    }
  }
  return 1.0  // 无相似竞争
}

// ═══════════════════════════════════════════════════════════════
// SIGNAL 6: 时间语境（编码特异性 + 节律 + recallContexts 匹配）
// ═══════════════════════════════════════════════════════════════

interface TimeRange { fromMs: number; toMs: number }

function temporalContext(mem: Memory, timeRange?: TimeRange | null, queryWords?: Set<string>): number {
  // Triple Query Decomposition: 如果有明确时间范围，用范围过滤代替新近性衰减
  if (timeRange) {
    const ts = mem.ts || 0
    return (ts >= timeRange.fromMs && ts <= timeRange.toMs) ? 1.0 : 0
  }

  const now = new Date()
  const memDate = new Date(mem.ts || Date.now())

  // 编码特异性（时间维度）：同一时段的记忆更容易被想起
  const hourDiff = Math.abs(now.getHours() - memDate.getHours())
  const timeMatch = 1 - Math.min(hourDiff, 24 - hourDiff) / 12  // [0, 1]

  // 同一天类型（工作日 vs 周末）
  const sameType = (now.getDay() === 0 || now.getDay() === 6) ===
                   (memDate.getDay() === 0 || memDate.getDay() === 6) ? 1 : 0.8

  // 编码特异性（语境维度，Tulving 1983）：
  // 如果记忆曾在类似查询语境下被召回过，此次更容易再次浮现
  let encodingSpecificity = 0
  if (queryWords && queryWords.size > 0 && mem.recallContexts && mem.recallContexts.length > 0) {
    for (const ctx of mem.recallContexts) {
      const ctxWords = (ctx.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}/gi) || []).map(w => w.toLowerCase())
      const overlap = ctxWords.filter(w => queryWords.has(w)).length
      if (overlap >= 2) {
        encodingSpecificity = Math.min(0.3, overlap * 0.08)  // 2词+0.16, 3词+0.24, cap 0.3
        break
      }
    }
  }

  const base = timeMatch * 0.5 + sameType * 0.5 + encodingSpecificity
  // Temporal query type → boost temporal signal (capped at 1.0)
  const tBoost = QUERY_TYPE_FACTORS[_currentQueryType]?.temporalBoost ?? 1.0
  return Math.min(1, base * tBoost)
}

// ═══════════════════════════════════════════════════════════════
// 核心：统一激活值计算
// ═══════════════════════════════════════════════════════════════

export interface ActivationResult {
  memory: Memory
  activation: number
  signals: {
    base: number
    context: number
    emotion: number
    spread: number
    interference: number
    temporal: number
  }
  path?: TraceStep[]
}

/**
 * 统一激活场：对所有记忆计算激活值，返回 top-N
 *
 * activation = (0.3×① + 0.7×②) × (0.5 + 0.5×③) × (1 + ④) × ⑤ × (0.8 + 0.2×⑥)
 *              ╰── 加法融合 ──╯   ╰──────── 乘法调制 ────────╯
 *
 * 加法融合（base + context）：
 * - 解决 ACT-R 衰减碾压 context 的问题：base 365x 动态范围 vs context 20x
 * - 0.3/0.7 权重：长期陪伴场景，相关性比新近性重要
 * - 旧但相关的记忆 (base=0.002, ctx=0.9) → 0.3×0.002 + 0.7×0.9 = 0.63
 * - 新但无关的记忆 (base=0.73, ctx=0.05) → 0.3×0.73 + 0.7×0.05 = 0.25
 *
 * 乘法调制（emotion × spread × interference × temporal）：
 * - 情绪为 0 → 0.5×（降半，但不封锁）
 * - 扩散为 0 → 1.0（没有邻居不影响）
 * - 干扰为 0.3 → 被强竞争者压制到 30%
 * - 时间为 0 → 0.8（时间不匹配轻微降低）
 */
export function computeActivationField(
  memories: Memory[],
  query: string,
  mood: number,
  alertness: number,
  expandedWords: Map<string, number>,
  topN: number = 10,
  timeRange?: TimeRange | null,
): ActivationResult[] {
  const now = Date.now()

  // 构建动态 IDF 缓存（一次性，供 contextMatch 使用）
  _idfCache = buildIdfCache(memories)
  const results: ActivationResult[] = []
  const currentTop: Memory[] = []  // 用于干扰抑制

  // 构建查询词集合（供 encoding specificity + temporal co-occurrence 使用）
  const queryWordSet = new Set<string>()
  const queryLower = query.toLowerCase()
  const qCjk = queryLower.match(/[\u4e00-\u9fff]{2,4}/g) || []
  for (const s of qCjk) queryWordSet.add(s)
  const qEn = queryLower.match(/[a-zA-Z]{3,}/gi) || []
  for (const w of qEn) queryWordSet.add(w.toLowerCase())

  // Signal 7: 预计算 temporal co-occurrence successors（PAM directed）
  let temporalSuccessors: Set<string> | null = null
  try {
    if (_aamGetTemporalSuccessors) {
      temporalSuccessors = new Set<string>()
      for (const qw of queryWordSet) {
        const succs = _aamGetTemporalSuccessors(qw, 5)
        if (succs) for (const s of succs) temporalSuccessors.add(s.word)
      }
    }
  } catch {}

  // 第一遍：计算原始激活值（不含干扰抑制）
  const rawResults: { mem: Memory; raw: number; signals: any; path: TraceStep[] }[] = []

  for (const mem of memories) {
    if (mem.scope === 'expired' || mem.scope === 'decayed') continue
    if (!mem.content || mem.content.length < 3) continue

    const s1 = baseActivation(mem, now)
    const s2 = contextMatch(query, mem, expandedWords)
    // 下限保护：完全无关的记忆不该靠 base 底分混进 top N
    if (s2 < 0.005) continue
    const s3 = emotionResonance(mem, mood, alertness)
    const s4 = spreadingActivation(mem, memories, query)
    const s6 = temporalContext(mem, timeRange, queryWordSet)

    // ── 加法融合（base + context）× 乘法调制（emotion × spread × temporal）──
    // 核心改变：base 和 context 从乘法改为加法
    // 原因：乘法下 base 的 365x 动态范围碾压 context 的 20x，旧但相关的记忆永远输给新但无关的
    // 加法下：score = 0.3×base + 0.7×context，context 有独立贡献，不被 base 乘没
    // 权重由 Recall Thermostat 动态调节（默认 0.3/0.7）
    const { base: wBase, context: wCtx } = getSignalWeights()
    const baseContextScore = wBase * s1 + wCtx * s2

    // 其余信号保持乘法调制（它们的范围温和，不存在碾压问题）
    const raw = baseContextScore * (0.5 + 0.5 * s3) * (1 + s4) * (0.8 + 0.2 * s6)

    // confidence 软缩放（不是乘法杀死，是 0.6-1.0 区间）
    const conf = mem.confidence ?? 0.7
    const confScale = 0.6 + conf * 0.4

    // importance 加成（surprise 编码的结果）
    const impBoost = (mem.importance ?? 5) >= 8 ? 1.2 : (mem.importance ?? 5) >= 6 ? 1.1 : 1.0

    // Signal 7: PAM Temporal Co-occurrence（有向共现加成）
    // 用户先说 A 再说 B → 下次说 A 时，含 B 的记忆获得 boost
    let s7 = 0
    if (temporalSuccessors && temporalSuccessors.size > 0) {
      const memContentLower = (mem.content || '').toLowerCase()
      const memW = (memContentLower.match(/[\u4e00-\u9fff]{2,4}|[a-zA-Z]{3,}/gi) || [])
      let hits = 0
      for (const w of memW) {
        if (temporalSuccessors.has(w.toLowerCase())) hits++
        if (hits >= 3) break  // cap contribution
      }
      s7 = Math.min(0.15, hits * 0.05)  // each hit +0.05, max +0.15
    }

    // 对话惯性加成（momentum boost）
    const momentum = getMomentumBoost(mem.content || '')
    const momentumScale = 1 + momentum  // capped at 1.5 by getMomentumBoost

    const finalRaw = raw * confScale * impBoost * momentumScale * (1 + s7)

    // 构建 trace path
    const path: TraceStep[] = [
      { stage: 'candidate_selection', via: s2 > 0.3 ? 'aam_context' : 'bm25', rawScore: s2 },
      { stage: 'signal_boost', via: 'base_activation', rawScore: s1 },
    ]
    if (s3 > 0.6) path.push({ stage: 'signal_boost', via: 'emotion', rawScore: s3 })
    if (s4 > 0.05) path.push({ stage: 'signal_boost', via: 'spread', rawScore: s4 })
    if (s6 > 0.7) path.push({ stage: 'signal_boost', via: 'temporal', rawScore: s6 })
    if (confScale > 0.8) path.push({ stage: 'signal_boost', via: 'confidence', rawScore: confScale })
    if (impBoost > 1.0) path.push({ stage: 'signal_boost', via: 'importance', rawScore: impBoost })
    if (momentum > 0.05) path.push({ stage: 'signal_boost', via: 'momentum', rawScore: momentum })
    if (s7 > 0.01) path.push({ stage: 'signal_boost', via: 'temporal_cooccur', rawScore: s7 })

    if (finalRaw > 0.001) {  // 候选门槛极低，靠排序筛选而非硬阈值
      rawResults.push({
        mem, raw: finalRaw,
        signals: { base: s1, context: s2, emotion: s3, spread: s4, interference: 1.0, temporal: s6 },
        path,
      })
    }
  }

  // 排序
  rawResults.sort((a, b) => b.raw - a.raw)

  // 第二遍：加入干扰抑制（已选的会压制后续的相似记忆）
  for (const r of rawResults) {
    const s5 = interferenceSuppress(r.mem, currentTop)
    const activation = r.raw * s5
    r.signals.interference = s5

    // trace: 记录干扰抑制
    if (s5 < 1.0) r.path.push({ stage: 'signal_suppress', via: 'interference', rawScore: s5 })

    // 更新激活值缓存
    setActivation(r.mem, activation)

    // 阈值：只过滤绝对零分（排序已经保证质量，不需要严格阈值）
    if (activation > 0.001) {
      results.push({
        memory: r.mem,
        activation,
        signals: r.signals,
        path: r.path,
      })
      currentTop.push(r.mem)
    }

    if (results.length >= topN) break
  }

  // ── Retrieval-Induced Forgetting (Anderson et al. 1994) ──
  // 被选中的记忆强化激活，竞争失败但相似的 runner-up 降低激活值
  // 与 interferenceSuppress 不同：interference 是当轮排序压制，RIF 是跨轮持久衰减
  if (results.length > 0) {
    const selectedContents = new Set(results.map(r => (r.memory.content || '').slice(0, 50)))
    const selectedWords = new Set<string>()
    for (const r of results) {
      const ws = ((r.memory.content || '').match(/[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}/gi) || [])
      for (const w of ws) selectedWords.add(w.toLowerCase())
    }
    // runner-ups: rawResults 中排名靠后、未入选、但与选中记忆词重叠高的
    const rifStart = Math.min(results.length, rawResults.length)
    const rifEnd = Math.min(rifStart + 30, rawResults.length)
    for (let i = rifStart; i < rifEnd; i++) {
      const r = rawResults[i]
      if (selectedContents.has((r.mem.content || '').slice(0, 50))) continue
      if (r.mem.scope === 'core_memory' || r.mem.scope === 'correction') continue
      const mw = ((r.mem.content || '').match(/[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}/gi) || [])
      let overlap = 0
      for (const w of mw) { if (selectedWords.has(w.toLowerCase())) overlap++ }
      if (mw.length > 0 && overlap / mw.length > 0.4) {
        // 持久性轻微降低激活值（-5%）
        const curAct = getActivation(r.mem)
        if (curAct > 0.05) setActivation(r.mem, curAct * 0.95)
      }
    }
  }

  // 记录 trace + rejection log
  const turnTs = Date.now()
  const traces: ActivationTrace[] = results.map(r => ({
    memory: r.memory, score: r.activation, path: r.path || []
  }))

  // Rejection log：top-20 中没进 results 的
  const rejections: RejectionRecord[] = []
  const selectedSet = new Set(results.map(r => memKey(r.memory)))
  for (let i = 0; i < Math.min(20, rawResults.length); i++) {
    if (!selectedSet.has(memKey(rawResults[i].mem))) {
      rejections.push({
        content: (rawResults[i].mem.content || '').slice(0, 30),
        originalRank: i + 1,
        finalRank: -1,
        reason: rawResults[i].signals.interference < 1.0 ? 'interference' : 'below_threshold',
      })
    }
  }

  _traceBuffer.set(turnTs, { traces, rejections })
  pruneTraceBuffer()

  return results
}

// ═══════════════════════════════════════════════════════════════
// 每分钟 tick：自然衰减
// ═══════════════════════════════════════════════════════════════

export function decayAllActivations(factor: number = 0.995) {
  for (const [key, val] of _activations) {
    const newVal = val * factor
    if (newVal < 0.01) {
      _activations.delete(key)
    } else {
      _activations.set(key, newVal)
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 查询扩展（复用 AAM 的 PMI 网络）
// ═══════════════════════════════════════════════════════════════

// 英文停用词（高频功能词，不应作为查询关键词）
const EN_STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were',
  'not', 'but', 'have', 'has', 'had', 'will', 'can', 'you', 'your', 'they',
  'them', 'their', 'what', 'when', 'where', 'which', 'who', 'whom', 'how',
  'did', 'does', 'would', 'could', 'should', 'been', 'being', 'its', 'she',
  'her', 'his', 'him', 'all', 'also', 'than', 'then', 'some', 'such',
  'about', 'after', 'before', 'between', 'into', 'through', 'during',
  'each', 'very', 'just', 'other', 'more', 'most', 'only', 'over',
])

export function expandQueryForField(query: string): Map<string, number> {
  const expanded = new Map<string, number>()

  // CJK: 2-char sliding window（跟 AAM tokenizer 一致）
  const cjkSegs = query.match(/[\u4e00-\u9fff]+/g) || []
  for (const seg of cjkSegs) {
    // 2-char sliding window
    for (let i = 0; i <= seg.length - 2; i++) expanded.set(seg.slice(i, i + 2), 1.0)
    // 完整 3-4 字词也加入（如 "减肥期"）
    if (seg.length >= 3 && seg.length <= 4) expanded.set(seg, 1.0)
  }
  // English: 2+ letter words + numbers, 停用词降权
  const enWords = query.match(/[a-zA-Z]{2,}|\d+/gi) || []
  for (const w of enWords) {
    const wl = w.toLowerCase()
    expanded.set(wl, EN_STOP_WORDS.has(wl) ? 0.1 : 1.0)
  }

  // 短查询：单字 CJK 也加入（在 AAM 扩展之前，确保"车"等单字能参与扩展）
  if (query.length < 15) {
    const singleChars = query.match(/[\u4e00-\u9fff]/g) || []
    for (const ch of singleChars) {
      if (!expanded.has(ch)) expanded.set(ch, 0.5)
    }
  }

  // AAM 查询扩展（同义词 + 概念层级 + 共字关联 + PMI）
  // 直接 import，不用 require（ESM 兼容）
  const KNOWN_SINGLE_CJK = new Set('吃喝睡走跑坐站看听说写读洗穿买卖车钱房书药酒茶'.split(''))
  const queryWords: string[] = []
  for (const [w, wt] of expanded) {
    if ((wt as number) < 0.3) continue
    if (w.length === 1 && /[\u4e00-\u9fff]/.test(w)) {
      if (KNOWN_SINGLE_CJK.has(w)) queryWords.push(w)
    } else if (w.length < 2) {
      // skip
    } else if (/[a-zA-Z]/.test(w) || w.length >= 3) {
      queryWords.push(w)
    } else {
      if (_aamIsKnownWord(w)) queryWords.push(w)
    }
  }
  try {
    const aamExpanded = _aamExpandQuery(queryWords, 20)
    for (const { word, weight } of aamExpanded) {
      if (!expanded.has(word)) expanded.set(word, weight)
    }
  } catch {}

  // 短查询降低门槛：单字 CJK 也加入
  if (query.length < 10) {
    const singleChars = query.match(/[\u4e00-\u9fff]/g) || []
    for (const ch of singleChars) {
      if (!expanded.has(ch)) expanded.set(ch, 0.3)
    }
  }

  // Single-char CJK that are synonym table keys → promote to expansion candidates
  try {
    for (const [w, wt] of [...expanded.entries()]) {
      if (w.length === 1 && /[\u4e00-\u9fff]/.test(w) && (wt as number) <= 0.3) {
        if (_aamIsKnownWord(w)) {
          expanded.set(w, 0.8)
        }
      }
    }
  } catch {}

  return expanded
}

// ═══════════════════════════════════════════════════════════════
// 统一入口：替代 recall()
// ═══════════════════════════════════════════════════════════════

export function activationRecall(
  memories: Memory[],
  query: string,
  topN: number = 5,
  mood: number = 0,
  alertness: number = 0.5,
): Memory[] {
  if (!query || memories.length === 0) return []

  // 查询类型检测（adaptive k1/b）
  _currentQueryType = detectQueryType(query)

  // 查询扩展
  const expanded = expandQueryForField(query)

  // 更新对话惯性 momentum
  updateMomentum(query)

  // ── Triple Query Decomposition（三层查询分解）──
  // 1. 时间通道：提取时间范围（精确时间过滤，替代新近性衰减）
  let timeRange: TimeRange | null = null
  try {
    timeRange = _extractTimeRange(query)  // 顶层 import，ESM 安全
  } catch {}

  // 2. 关键词通道：去停用词后的 BM25 关键词（更精准的词法匹配）
  let lexicalQuery = query
  try {
    const keywords: string[] = _extractTagsLocal(query)  // 顶层 import，ESM 安全
    if (keywords.length > 0) lexicalQuery = keywords.join(' ')
  } catch {}

  // 3. 实体通道：图谱实体（已在下方 graph expansion 中处理）
  // 4. AAM 通道：保持使用完整原始 query（联想需要完整语境）

  // 快速路径：fact-store 动态匹配（System 1）
  // 零硬编码：遍历所有已存三元组，用查询词匹配 object/predicate/subject
  try {
    const factStore = getFactStoreMod()
    const allFacts = factStore.getAllFacts() as { subject: string; predicate: string; object: string; ts?: number; confidence?: number; validUntil?: number }[]
    const allFactMems: Memory[] = []
    const queryLowerS1 = query.toLowerCase()
    // 提取查询关键词（CJK 2-gram + 英文 2+ 字母 + 数字）
    const queryTokensS1 = new Set((queryLowerS1.match(/[\u4e00-\u9fff]{2,4}|[a-zA-Z]{2,}|\d+/gi) || []).map(w => w.toLowerCase()))
    // AAM 扩展词也参与匹配
    for (const [w] of expanded) queryTokensS1.add(w.toLowerCase())

    for (const fact of allFacts) {
      if (fact.validUntil && fact.validUntil < Date.now()) continue  // 已失效
      const objLower = (fact.object || '').toLowerCase()
      const predLower = (fact.predicate || '').toLowerCase()

      // 匹配策略：查询词出现在 object 或 predicate 中
      let matched = false
      // 1. 查询整体包含 object（"我的猫叫什么" 包含 "猫"）
      for (const token of queryTokensS1) {
        if (objLower.includes(token) || token.includes(objLower)) { matched = true; break }
        if (predLower.includes(token)) { matched = true; break }
      }
      // 2. object 的词出现在查询中（"PostgreSQL" 出现在查询"我用什么数据库"→ 通过 AAM 扩展匹配）
      if (!matched) {
        const objTokens = (objLower.match(/[\u4e00-\u9fff]{2,4}|[a-zA-Z]{2,}|\d+/gi) || [])
        for (const ot of objTokens) {
          if (queryTokensS1.has(ot.toLowerCase())) { matched = true; break }
        }
      }

      if (matched) {
        allFactMems.push({
          content: `[事实] ${fact.predicate}: ${fact.object}`,
          scope: 'fact', ts: fact.ts || Date.now(), confidence: fact.confidence || 0.9, source: 'activation_field_s1',
          recallCount: 10, lastAccessed: Date.now(), importance: 9,
        } as Memory)
      }
    }
    // 去重（同一 predicate 只取最新 2 条）
    const predCount = new Map<string, number>()
    const dedupFacts: Memory[] = []
    for (const m of allFactMems) {
      const pred = m.content.split(':')[0] || ''
      const count = predCount.get(pred) || 0
      if (count < 2) { dedupFacts.push(m); predCount.set(pred, count + 1) }
    }
    if (dedupFacts.length > 0) {
      console.log(`[activation-field] System 1 dynamic: ${dedupFacts.length} facts matched from ${allFacts.length} total`)
    }
    if (allFactMemsFinal.length > 0) {
      // System 1 做增强不做短路：facts + 激活场补充
      const fieldResults = computeActivationField(memories, lexicalQuery, mood, alertness, expanded, topN, timeRange)
      const seen = new Set(allFactMemsFinal.map(m => m.content))
      for (const r of fieldResults) {
        if (!seen.has(r.memory.content)) { allFactMemsFinal.push(r.memory); seen.add(r.memory.content) }
      }
      return allFactMemsFinal.slice(0, topN)
    }
  } catch {}

  // ── P5c: cascadeRecall 管线式集成 ──
  // Step 1: AAM 扩展查询词（增强召回率）
  // expanded 已经是 Map<string, number>，直接合并 AAM 扩展词
  try {
    const aamExpansion = _aamExpandQuery(
      (query.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}/gi) || []).map((w: string) => w.toLowerCase()),
      5
    )
    if (aamExpansion.length > 0) {
      for (const exp of aamExpansion) {
        if (!expanded.has(exp.word)) {
          expanded.set(exp.word, exp.weight)
        }
      }
    }
  } catch {}

  // Step 2: 激活场计算（用扩展后的查询，候选集更完整）
  let results = computeActivationField(memories, lexicalQuery, mood, alertness, expanded, topN * 2, timeRange)
  // 过采样 2x，给 Step 3 的 rerank 留空间

  // ── PRF: Pseudo-Relevance Feedback（伪相关反馈二次召回）──
  // 仅在首轮几乎无结果时触发（阈值 0.03），避免大量计算
  if (results.length > 0 && results[0].activation < 0.03) {
    const prfTopN = Math.min(3, results.length)
    const prfKeywords = new Map<string, number>()  // word → IDF weight

    // 从 top-3 结果提取词并用 IDF 加权
    for (let i = 0; i < prfTopN; i++) {
      const content = results[i].memory.content || ''
      const words = (content.match(/[\u4e00-\u9fff]{2,4}|[a-zA-Z]{3,}/gi) || [])
      for (const w of words) {
        const wl = w.toLowerCase()
        if (EN_STOP_WORDS.has(wl)) continue
        const idf = _idfCache?.get(wl) ?? 0.5
        prfKeywords.set(wl, Math.max(prfKeywords.get(wl) || 0, idf))
      }
    }

    // 取 top-5 IDF 最高的词
    const sortedPrfWords = [...prfKeywords.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)

    // 合并到查询扩展词（不覆盖已有的）
    let prfAdded = 0
    for (const [word, idf] of sortedPrfWords) {
      if (!expanded.has(word)) {
        expanded.set(word, idf * 0.5)  // PRF 扩展词降权 50%
        prfAdded++
      }
    }

    if (prfAdded > 0) {
      // 二次召回（PRF flag 内置：只跑 1 轮，不递归）
      const prfResults = computeActivationField(memories, lexicalQuery, mood, alertness, expanded, topN * 2, timeRange)

      // 合并 + 去重（by content）
      const seen = new Set(results.map(r => r.memory.content))
      for (const r of prfResults) {
        if (!seen.has(r.memory.content)) {
          results.push(r)
          seen.add(r.memory.content)
        }
      }
      // 重新排序
      results.sort((a, b) => b.activation - a.activation)
      console.log(`[activation-field] PRF: +${prfAdded} keywords, ${prfResults.length} second-pass → ${results.length} merged`)
    }
  }

  // Step 3: CIN 已内置于 computeActivationField 的 6 信号中（contextMatch + interferenceSuppress）
  // 不需要额外 rerank，激活场本身就是多信号融合

  // Step 4: CWRF — 如果有多个独立通道结果，用置信度加权融合
  // （activation field 是统一路径，CWRF 应用于 recallWithScores 的 5 通道融合中）

  // ── 启动效应（Priming Effect）：最近提到的词降低识别阈值 ──
  try {
    if (_primingCacheRef && _primingCacheRef.size > 0) {
      const now = Date.now()
      const PRIMING_WINDOW = 5 * 60 * 1000
      for (const r of results) {
        const words = (r.memory.content.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}/gi) || [])
        let hits = 0
        for (const w of words) {
          const ts = _primingCache.get(w.toLowerCase())
          if (ts && now - ts < PRIMING_WINDOW) hits++
        }
        if (hits > 0 && words.length > 0) {
          const boost = Math.min(0.3, hits / words.length)
          r.score *= (1 + boost)
          try { require('./decision-log.ts').logDecision('priming', (r.memory.content || '').slice(0, 30), `hits=${hits}/${words.length}, boost=${boost.toFixed(2)}`) } catch {}
        }
      }
      results.sort((a, b) => b.score - a.score)
    }
  } catch {}

  // ── BM25F 字段加权 rerank（仅 top-50，避免全量计算）──
  const queryLower = lexicalQuery.toLowerCase()
  const SCOPE_KW: Record<string, string[]> = {
    correction: ['纠正','错了','不对','correct','fix'], preference: ['喜欢','偏好','prefer','like'],
    fact: ['事实','知道','记住','fact','know'], event: ['发生','经历','event','happen'],
  }
  const EMO_KW: Record<string, string[]> = {
    warm: ['开心','高兴','快乐','happy'], painful: ['难过','伤心','痛苦','sad'],
    important: ['重要','关键','important'], funny: ['搞笑','好笑','哈哈','funny'],
  }
  for (let i = 0; i < Math.min(50, results.length); i++) {
    const m = results[i].memory
    let bonus = 0
    if (m.tags?.length) { bonus += (m.tags.filter((t: string) => queryLower.includes(t.toLowerCase())).length / m.tags.length) * 3.0 }
    const sk = SCOPE_KW[m.scope || '']; if (sk?.some((k: string) => queryLower.includes(k))) bonus += 1.5
    const ek = EMO_KW[m.emotion || '']; if (ek?.some((k: string) => queryLower.includes(k))) bonus += 2.0
    results[i].score *= (1 + Math.min(0.3, bonus / 6.5))
  }
  results.sort((a, b) => b.score - a.score)

  // 截断到 topN
  const topResults = results.slice(0, topN)

  if (topResults.length > 0) {
    console.log(`[activation-field] cascade: ${expanded.size} expanded words → ${results.length} candidates → ${topResults.length} selected`)
  }

  // 学习：每条消息都喂入 AAM 关联网络 + 时序共现
  try {
    _aamLearn(query, Math.abs(mood))
  } catch {}

  // ── System 1→2：零 LLM 召回质量低时，LLM 兜底 ──
  // 异步模式 B：不阻塞当前返回，LLM 结果异步写入，下一轮受益
  if (topResults.length === 0 || (topResults.length > 0 && topResults[0].score < 0.1)) {
    try {
      const { hasLLM } = require('./cli.ts')
      if (hasLLM()) {
        const { spawnCLI } = require('./cli.ts')
        // LLM query rewriting: 让 LLM 扩展查询词，结果存入 AAM 供下次使用
        spawnCLI(
          `用户问了"${query.slice(0, 100)}"，请列出3-5个相关的关键词或同义词，每行一个，只输出关键词不要解释`,
          (output: string) => {
            if (!output) return
            const keywords = output.split('\n').map(l => l.trim()).filter(l => l.length >= 2 && l.length <= 20)
            // 存入 AAM 共现网络，让下次召回能用这些扩展词
            try {
              const aam = require('./aam.ts')
              const queryWords = (query.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}/gi) || [])
              for (const kw of keywords) {
                for (const qw of queryWords) {
                  aam.learnAssociation?.(qw + ' ' + kw)
                }
              }
            } catch {}
            try { require('./decision-log.ts').logDecision('system2_escalation', query.slice(0, 30), `expanded: ${keywords.join(',')}`) } catch {}
          },
          10000  // 10s timeout, low priority
        )
      }
    } catch {}
  }

  return topResults.map(r => r.memory)
}

// ═══════════════════════════════════════════════════════════════
// 调试/透明度
// ═══════════════════════════════════════════════════════════════

export function explainActivation(result: ActivationResult): string {
  const s = result.signals
  const parts = [
    `base=${s.base.toFixed(2)}`,
    `ctx=${s.context.toFixed(2)}`,
    `emo=${s.emotion.toFixed(2)}`,
    `spread=${s.spread.toFixed(2)}`,
    `inhib=${s.interference.toFixed(2)}`,
    `time=${s.temporal.toFixed(2)}`,
  ]
  return `activation=${result.activation.toFixed(3)} [${parts.join(' ')}]`
}

export function getFieldStats(): { totalActivated: number; avgActivation: number } {
  const values = [..._activations.values()]
  return {
    totalActivated: values.filter(v => v > 0.05).length,
    avgActivation: values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0,
  }
}
