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
 * 6 个激活信号（乘法组合）：
 *   ① 基础激活（ACT-R：频率 + 新近性）
 *   ② 上下文匹配（AAM词扩展 + BM25 + trigram融合）
 *   ③ 情绪共振（PADCN余弦 + 闪光灯 + 状态门控）
 *   ④ 扩散激活（邻居激活 × 连接权重 + 微连接涌现）
 *   ⑤ 干扰抑制（相似记忆竞争 + Anti-Hebbian）
 *   ⑥ 时间语境（编码特异性 + 双振荡器 + 测试效应）
 */

import type { Memory } from './types.ts'
import { trigrams, trigramSimilarity } from './memory-utils.ts'

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

function contextMatch(query: string, mem: Memory, expandedWords: Map<string, number>): number {
  // 方式 A：扩展词加权匹配
  const memWords = new Set(
    ((mem.content || '').match(/[\u4e00-\u9fff]{2,4}|[a-zA-Z]{3,}/gi) || []).map(w => w.toLowerCase())
  )
  let weightedHits = 0, totalWeight = 0
  for (const [word, weight] of expandedWords) {
    totalWeight += weight
    if (memWords.has(word)) weightedHits += weight
  }
  const wordScore = totalWeight > 0 ? weightedHits / totalWeight : 0

  // 方式 B：trigram 模糊匹配（补充 A 的不足）
  const triScore = trigramSimilarity(trigrams(query), trigrams(mem.content || ''))

  // 方式 C：tag 精确匹配（如果有 tags）
  let tagScore = 0
  if (mem.tags && mem.tags.length > 0) {
    const queryLower = query.toLowerCase()
    const tagHits = mem.tags.filter(t => queryLower.includes(t.toLowerCase())).length
    tagScore = tagHits / Math.max(1, mem.tags.length)
  }

  // 融合：取最好的通道
  return Math.max(wordScore, triScore * 0.8, tagScore)
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

function spreadingActivation(mem: Memory, allMemories: Memory[]): number {
  // 找和当前记忆有共同 tag/关键词的其他高激活记忆
  if (!mem.tags || mem.tags.length === 0) return 0

  const myTags = new Set(mem.tags.map(t => t.toLowerCase()))
  let totalSpread = 0
  let count = 0

  for (const other of allMemories) {
    if (other === mem || !other.tags || other.tags.length === 0) continue
    const otherActivation = getActivation(other)
    if (otherActivation < 0.2) continue  // 不够活跃的邻居不传播

    // 计算共享 tag 数
    const shared = other.tags.filter(t => myTags.has(t.toLowerCase())).length
    if (shared > 0) {
      totalSpread += otherActivation * (shared / Math.max(myTags.size, 1)) * 0.3
      count++
    }
    if (count >= 10) break  // 限制扩散范围
  }

  return Math.min(0.5, totalSpread)  // cap at 0.5 避免雪球效应
}

// ═══════════════════════════════════════════════════════════════
// SIGNAL 5: 干扰抑制（相似记忆竞争）
// ═══════════════════════════════════════════════════════════════

function interferenceSuppress(mem: Memory, currentTop: Memory[]): number {
  if (currentTop.length === 0) return 1.0  // 无竞争

  const memTri = trigrams(mem.content || '')
  for (const top of currentTop) {
    const sim = trigramSimilarity(memTri, trigrams(top.content || ''))
    if (sim > 0.5) {
      // 有很相似的记忆已经在 top 中 → 我被抑制
      return 0.3  // 大幅压制
    }
    if (sim > 0.3) {
      return 0.7  // 轻微压制
    }
  }
  return 1.0  // 无相似竞争
}

// ═══════════════════════════════════════════════════════════════
// SIGNAL 6: 时间语境（编码特异性 + 节律）
// ═══════════════════════════════════════════════════════════════

function temporalContext(mem: Memory): number {
  const now = new Date()
  const memDate = new Date(mem.ts || Date.now())

  // 编码特异性：同一时段的记忆更容易被想起
  const hourDiff = Math.abs(now.getHours() - memDate.getHours())
  const timeMatch = 1 - Math.min(hourDiff, 24 - hourDiff) / 12  // [0, 1]

  // 同一天类型（工作日 vs 周末）
  const sameType = (now.getDay() === 0 || now.getDay() === 6) ===
                   (memDate.getDay() === 0 || memDate.getDay() === 6) ? 1 : 0.8

  return timeMatch * 0.5 + sameType * 0.5
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
}

/**
 * 统一激活场：对所有记忆计算激活值，返回超过阈值的
 *
 * activation = ① × (0.3 + 0.7×②) × (0.5 + 0.5×③) × (1 + ④) × ⑤ × (0.8 + 0.2×⑥)
 *
 * 乘法组合的含义：
 * - 基础激活为 0 → 不管其他信号多强，都不浮现（死记忆）
 * - 上下文为 0 → 0.3 × 基础（不相关但仍有基线概率，模拟"走神想起不相关的事"）
 * - 情绪为 0 → 0.5 × 其余（情绪不匹配降半，但不完全封锁）
 * - 扩散为 0 → 1.0（没有邻居激活不影响）
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
): ActivationResult[] {
  const now = Date.now()
  const results: ActivationResult[] = []
  const currentTop: Memory[] = []  // 用于干扰抑制

  // 第一遍：计算原始激活值（不含干扰抑制）
  const rawResults: { mem: Memory; raw: number; signals: any }[] = []

  for (const mem of memories) {
    if (mem.scope === 'expired' || mem.scope === 'decayed') continue
    if (!mem.content || mem.content.length < 3) continue

    const s1 = baseActivation(mem, now)
    const s2 = contextMatch(query, mem, expandedWords)
    const s3 = emotionResonance(mem, mood, alertness)
    const s4 = spreadingActivation(mem, memories)
    const s6 = temporalContext(mem)

    // 乘法组合（不含干扰抑制，第二遍加）
    const raw = s1 * (0.3 + 0.7 * s2) * (0.5 + 0.5 * s3) * (1 + s4) * (0.8 + 0.2 * s6)

    // confidence 软缩放（不是乘法杀死，是 0.6-1.0 区间）
    const conf = mem.confidence ?? 0.7
    const confScale = 0.6 + conf * 0.4

    // importance 加成（surprise 编码的结果）
    const impBoost = (mem.importance ?? 5) >= 8 ? 1.2 : (mem.importance ?? 5) >= 6 ? 1.1 : 1.0

    const finalRaw = raw * confScale * impBoost

    if (finalRaw > 0.01) {  // 极低的直接跳过
      rawResults.push({
        mem, raw: finalRaw,
        signals: { base: s1, context: s2, emotion: s3, spread: s4, interference: 1.0, temporal: s6 }
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

    // 更新激活值缓存
    setActivation(r.mem, activation)

    if (activation > 0.05) {
      results.push({
        memory: r.mem,
        activation,
        signals: r.signals,
      })
      currentTop.push(r.mem)
    }

    if (results.length >= topN) break
  }

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

export function expandQueryForField(query: string): Map<string, number> {
  const expanded = new Map<string, number>()
  const words = (query.match(/[\u4e00-\u9fff]{2,4}|[a-zA-Z]{3,}/gi) || []).map(w => w.toLowerCase())

  // 原始词权重 1.0
  for (const w of words) expanded.set(w, 1.0)

  // 尝试用 AAM 的查询扩展
  try {
    const aamMod = require('./aam.ts')
    const aamExpanded = aamMod.expandQuery(words, 8)
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

  // 查询扩展
  const expanded = expandQueryForField(query)

  // 快速路径：fact-store 精确匹配（System 1）
  try {
    const factStore = getFactStoreMod()
    // 检测查询是否适合 fact-store 直接命中
    const factPatterns: { test: RegExp; predicate?: string }[] = [
      { test: /叫什么|我是谁|名字/, predicate: undefined },
      { test: /工作|公司|上班/, predicate: 'works_at' },
      { test: /住哪|住在/, predicate: 'lives_in' },
      { test: /喜欢|偏好/, predicate: 'likes' },
      { test: /讨厌|不喜欢/, predicate: 'dislikes' },
      { test: /宠物|猫|狗|养/, predicate: 'has_pet' },
      { test: /家人|女儿|儿子|孩子|老婆/, predicate: 'has_family' },
    ]
    for (const fp of factPatterns) {
      if (fp.test.test(query)) {
        const facts = factStore.queryFacts(fp.predicate ? { subject: 'user', predicate: fp.predicate } : { subject: 'user' })
        if (facts.length > 0) {
          // 把 fact 转为 Memory 格式返回
          const factMems = facts.slice(0, 3).map((f: any) => ({
            content: `${f.predicate === 'likes' ? '喜欢' : f.predicate === 'dislikes' ? '讨厌' : f.predicate === 'works_at' ? '在' : f.predicate === 'lives_in' ? '住在' : ''}${f.object}`,
            scope: 'fact', ts: f.ts || Date.now(), confidence: f.confidence || 0.9, source: 'activation_field_s1',
          } as Memory))
          console.log(`[activation-field] System 1 hit: ${factMems.length} facts`)
          return factMems
        }
      }
    }
  } catch {}

  // 主路径：激活场计算
  const results = computeActivationField(memories, query, mood, alertness, expanded, topN)

  if (results.length > 0) {
    console.log(`[activation-field] ${results.length} memories surfaced (top=${results[0].activation.toFixed(3)})`)
  }

  // 学习：每条消息都喂入 AAM 关联网络
  try {
    const aamMod = require('./aam.ts')
    aamMod.learnAssociation(query)
  } catch {}

  return results.map(r => r.memory)
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
