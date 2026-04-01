/**
 * cin.ts — Cognitive Interference Network (CIN)
 *
 * cc-soul 原创核心算法。从物理学波干涉原理推导的认知模型。
 * 纯数学实现，零 LLM 依赖。
 *
 * 核心思想：
 *   每条记忆是一个"认知波"，有方向(θ)和振幅(A)。
 *   所有记忆波的叠加 = 认知场 = 对这个人的理解。
 *   新情境作为"探测波"与认知场干涉 = 预测这个人的反应。
 *
 * 三层功能：
 *   理解层：场叠加 → "他是什么样的人"
 *   预测层：探测干涉 → "他会怎么反应"
 *   因果层：时序扫描 → "为什么他会这样"
 *
 * 6 个认知维度：
 *   D1 风险偏好    保守(0°) ←→ 冒险(180°)
 *   D2 社交倾向    独处(0°) ←→ 社交(180°)
 *   D3 决策风格    分析(0°) ←→ 直觉(180°)
 *   D4 沟通方式    委婉(0°) ←→ 直接(180°)
 *   D5 情绪表达    克制(0°) ←→ 外放(180°)
 *   D6 节奏偏好    计划(0°) ←→ 随性(180°)
 */

import type { Memory } from './types.ts'
import { DATA_DIR, loadJson, debouncedSave } from './persistence.ts'
import { resolve } from 'path'

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS & TYPES
// ═══════════════════════════════════════════════════════════════════════════════

const CIN_PATH = resolve(DATA_DIR, 'cin_field.json')
const CAUSAL_PATH = resolve(DATA_DIR, 'cin_causal.json')
const NUM_DIMS = 6

const DIM_NAMES = ['risk', 'social', 'decision', 'communication', 'emotion', 'tempo'] as const
const DIM_LABELS: Record<string, [string, string]> = {
  risk: ['保守', '冒险'],
  social: ['独处', '社交'],
  decision: ['分析', '直觉'],
  communication: ['委婉', '直接'],
  emotion: ['克制', '外放'],
  tempo: ['计划', '随性'],
}

interface CognitiveWave {
  dims: number[]      // 6 维角度 (弧度, 0=左端, π=右端)
  amplitude: number   // 振幅 0-1
  ts: number          // 时间戳
}

interface CognitiveField {
  // 每个维度的场强 (-∞ to +∞)
  // 正 = 偏向左端（保守/独处/分析/委婉/克制/计划）
  // 负 = 偏向右端（冒险/社交/直觉/直接/外放/随性）
  strength: number[]
  // 每个维度的置信度（叠加的波越多越高）
  confidence: number[]
  // 总样本数
  sampleCount: number
  lastUpdated: number
}

interface CausalChain {
  trigger: string       // 触发事件的关键词
  effect: string        // 结果事件的关键词
  count: number         // 观察到的次数
  avgDelay: number      // 平均延迟（毫秒）
  lastSeen: number
}

// 认知状态
type CognitiveState = 'normal' | 'pressure' | 'relaxed' | 'excited' | 'low'

// ═══════════════════════════════════════════════════════════════════════════════
// WAVE EXTRACTION — 从记忆中提取认知波
// ═══════════════════════════════════════════════════════════════════════════════

// D1: 风险偏好
const RISK_CONSERVATIVE = /选了|还是用|不想换|够用了|稳定|成熟|可靠|保守|传统|老方案|不折腾|先不|暂时不|不急|等等再|观望|不冒险|安全|稳妥/
const RISK_ADVENTUROUS = /试试|新的|切换|尝试|体验|升级|换成|学了|研究|折腾|探索|挑战|冒险|大胆|创新|突破|激进|敢于/

// D2: 社交倾向
const SOCIAL_SOLO = /一个人|独自|安静|不想出门|宅|自己|独处|不想社交|取消约|不去了|在家|远程/
const SOCIAL_SOCIAL = /一起|聚|约|出去|活动|party|聚餐|团建|见面|社交|朋友|同事.*聊|热闹|组局/

// D3: 决策风格
const DECISION_ANALYTICAL = /分析|对比|数据|评测|调研|研究了|看了几个|比较|权衡|考虑|理性|逻辑|客观|量化|指标/
const DECISION_INTUITIVE = /感觉|直觉|觉得|随便|差不多|看着办|凭感觉|心里|第一反应|冲动|顺手|随缘|看心情/

// D4: 沟通方式
const COMMUNICATION_INDIRECT = /其实|可能|也许|大概|或许|不知道.*觉得|感觉好像|好像是|似乎|不太确定|委婉|含蓄/
const COMMUNICATION_DIRECT = /说白了|直说|一句话|就是|明确|直接|别废话|简单说|不绕弯|坦白|干脆|直截了当|总之/

// D5: 情绪表达
const EMOTION_CONTROLLED = /没事|还好|一般|正常|无所谓|随便|冷静|理性|不在意|没感觉|淡定|佛系|看淡|算了/
const EMOTION_EXPRESSIVE = /太.*了|超|巨|好开心|好难过|崩溃|绝了|离谱|受不了|激动|兴奋|愤怒|感动|哭|笑死|！！|！！！/

// D6: 节奏偏好
const TEMPO_PLANNED = /计划|安排|日程|提前|准备|规划|目标|清单|todo|deadline|排期|时间表|按步骤|先.*再.*然后/
const TEMPO_SPONTANEOUS = /随便|临时|突然|想到就|说走就走|没计划|看心情|随机|即兴|凑合|走一步看一步|管他/

/**
 * 从一条记忆中提取认知波。
 * 每个维度独立判断方向和强度。
 */
function extractWave(mem: Memory): CognitiveWave | null {
  const c = mem.content
  const dims: number[] = new Array(NUM_DIMS).fill(Math.PI / 2) // 默认中性 (90°)
  let totalSignal = 0

  // D1: 风险
  const r1 = RISK_CONSERVATIVE.test(c) ? 1 : 0
  const r2 = RISK_ADVENTUROUS.test(c) ? 1 : 0
  if (r1 || r2) { dims[0] = r1 > r2 ? 0.3 : r2 > r1 ? 2.8 : Math.PI / 2; totalSignal++ }

  // D2: 社交
  const s1 = SOCIAL_SOLO.test(c) ? 1 : 0
  const s2 = SOCIAL_SOCIAL.test(c) ? 1 : 0
  if (s1 || s2) { dims[1] = s1 > s2 ? 0.3 : s2 > s1 ? 2.8 : Math.PI / 2; totalSignal++ }

  // D3: 决策
  const d1 = DECISION_ANALYTICAL.test(c) ? 1 : 0
  const d2 = DECISION_INTUITIVE.test(c) ? 1 : 0
  if (d1 || d2) { dims[2] = d1 > d2 ? 0.3 : d2 > d1 ? 2.8 : Math.PI / 2; totalSignal++ }

  // D4: 沟通
  const c1 = COMMUNICATION_INDIRECT.test(c) ? 1 : 0
  const c2 = COMMUNICATION_DIRECT.test(c) ? 1 : 0
  if (c1 || c2) { dims[3] = c1 > c2 ? 0.3 : c2 > c1 ? 2.8 : Math.PI / 2; totalSignal++ }

  // D5: 情绪
  const e1 = EMOTION_CONTROLLED.test(c) ? 1 : 0
  const e2 = EMOTION_EXPRESSIVE.test(c) ? 1 : 0
  if (e1 || e2) { dims[4] = e1 > e2 ? 0.3 : e2 > e1 ? 2.8 : Math.PI / 2; totalSignal++ }

  // D6: 节奏
  const t1 = TEMPO_PLANNED.test(c) ? 1 : 0
  const t2 = TEMPO_SPONTANEOUS.test(c) ? 1 : 0
  if (t1 || t2) { dims[5] = t1 > t2 ? 0.3 : t2 > t1 ? 2.8 : Math.PI / 2; totalSignal++ }

  // 无信号的记忆跳过
  if (totalSignal === 0) return null

  // 振幅 = 信号强度 × 情绪权重 × 来源权重
  const emotionBoost = (mem.emotionIntensity || 0.3) > 0.6 ? 1.3 : 1.0
  const sourceBoost = mem.source === 'user_said' ? 1.2 : mem.source === 'ai_inferred' ? 0.7 : 1.0
  const amplitude = Math.min(1, (totalSignal / NUM_DIMS) * emotionBoost * sourceBoost)

  return { dims, amplitude, ts: mem.ts }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIELD COMPUTATION — 认知场叠加
// ═══════════════════════════════════════════════════════════════════════════════

let field: CognitiveField = loadJson<CognitiveField>(CIN_PATH, {
  strength: new Array(NUM_DIMS).fill(0),
  confidence: new Array(NUM_DIMS).fill(0),
  sampleCount: 0,
  lastUpdated: 0,
})
function saveField() { debouncedSave(CIN_PATH, field) }

/**
 * 从所有记忆重建认知场。心跳时调用。
 */
export function rebuildField(memories: Memory[]) {
  const strength = new Array(NUM_DIMS).fill(0)
  const counts = new Array(NUM_DIMS).fill(0)
  let validWaves = 0

  for (const mem of memories) {
    if (mem.scope === 'expired' || mem.scope === 'decayed') continue
    const wave = extractWave(mem)
    if (!wave) continue

    // 时间衰减：越旧的记忆贡献越小
    const ageDays = (Date.now() - wave.ts) / 86400000
    const decay = Math.exp(-ageDays / 90) // 90 天半衰期

    // 叠加：每个维度独立计算 A × cos(θ) × decay
    for (let d = 0; d < NUM_DIMS; d++) {
      const contribution = wave.amplitude * Math.cos(wave.dims[d]) * decay
      strength[d] += contribution
      if (wave.dims[d] !== Math.PI / 2) counts[d]++ // 非中性才计数
    }
    validWaves++
  }

  // 归一化场强度到 [-1, 1]
  const confidence = new Array(NUM_DIMS).fill(0)
  for (let d = 0; d < NUM_DIMS; d++) {
    if (counts[d] > 0) {
      strength[d] = strength[d] / Math.max(1, Math.sqrt(counts[d])) // 除以√n 归一化
      strength[d] = Math.max(-1, Math.min(1, strength[d]))
      confidence[d] = Math.min(1, counts[d] / 20) // 20 条证据 → 置信度 1.0
    }
  }

  field = { strength, confidence, sampleCount: validWaves, lastUpdated: Date.now() }
  saveField()
  console.log(`[cc-soul][CIN] field rebuilt from ${validWaves} waves`)
}

/**
 * 增量更新：新记忆加入时局部更新场，不全量重建。
 */
export function updateFieldIncremental(mem: Memory) {
  const wave = extractWave(mem)
  if (!wave) return

  for (let d = 0; d < NUM_DIMS; d++) {
    if (wave.dims[d] === Math.PI / 2) continue // 中性跳过
    const contribution = wave.amplitude * Math.cos(wave.dims[d])
    // EMA 式增量更新
    const alpha = 0.05
    field.strength[d] = field.strength[d] * (1 - alpha) + contribution * alpha
    field.strength[d] = Math.max(-1, Math.min(1, field.strength[d]))
    field.confidence[d] = Math.min(1, field.confidence[d] + 0.02)
  }
  field.sampleCount++
  field.lastUpdated = Date.now()
  // 不立即保存，等 heartbeat 批量保存
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE DETECTION — 当前认知状态
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 从最近消息检测当前认知状态。
 */
export function detectCognitiveState(recentMemories: Memory[], mood: number): CognitiveState {
  if (recentMemories.length < 3) return 'normal'

  // 压力信号
  const pressureWords = /压力|焦虑|来不及|赶|急|催|延期|加班|熬夜|崩溃|受不了|头疼|烦/
  const relaxWords = /放松|周末|休息|开心|旅行|玩|聚|有趣|舒服|惬意/
  const excitedWords = /太好了|成功|拿到|升|涨|offer|发布|上线|完成|搞定/
  const lowWords = /失眠|累|无聊|没意思|不想|懒|拖|迷茫|失望|不知道/

  let pressure = 0, relax = 0, excited = 0, low = 0
  for (const m of recentMemories.slice(-10)) {
    if (pressureWords.test(m.content)) pressure++
    if (relaxWords.test(m.content)) relax++
    if (excitedWords.test(m.content)) excited++
    if (lowWords.test(m.content)) low++
  }

  // mood 也参与判断
  if (mood < -0.5) pressure += 2
  if (mood > 0.5) relax += 1

  const max = Math.max(pressure, relax, excited, low)
  if (max < 2) return 'normal'
  if (pressure === max) return 'pressure'
  if (relax === max) return 'relaxed'
  if (excited === max) return 'excited'
  if (low === max) return 'low'
  return 'normal'
}

// 状态调制系数：不同状态下各维度的场被放大/衰减
const STATE_MODULATION: Record<CognitiveState, number[]> = {
  normal:   [1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
  pressure: [1.3, 0.8, 1.2, 1.1, 0.7, 1.3], // 压力下更保守、更分析、更计划，更克制情绪
  relaxed:  [0.8, 1.2, 0.9, 0.9, 1.2, 0.7], // 放松时更冒险、更社交、更外放、更随性
  excited:  [0.7, 1.3, 0.8, 1.2, 1.4, 0.6], // 兴奋时更冒险、更社交、更直接、更外放
  low:      [1.2, 0.6, 1.0, 0.8, 0.6, 1.1], // 低落时更保守、更独处、更克制
}

// ═══════════════════════════════════════════════════════════════════════════════
// PREDICTION — 探测波 × 认知场 = 预测
// ═══════════════════════════════════════════════════════════════════════════════

export interface CINPrediction {
  // 每个维度的预测
  dimensions: { name: string; direction: string; strength: number; confidence: number }[]
  // 当前认知状态
  state: CognitiveState
  // 综合策略建议（给 LLM 的提示）
  strategyHint: string
  // 数据充分度
  dataReady: boolean
}

/**
 * 预测：给定当前情境，这个人会怎么反应？
 */
export function predict(query: string, recentMemories: Memory[], mood: number): CINPrediction {
  const state = detectCognitiveState(recentMemories, mood)
  const modulation = STATE_MODULATION[state]

  // 数据充分度检查
  const dataReady = field.sampleCount >= 20

  // 提取探测波
  const probeWave = extractWave({ content: query, scope: 'fact', ts: Date.now() } as Memory)

  const dimensions: CINPrediction['dimensions'] = []

  for (let d = 0; d < NUM_DIMS; d++) {
    const rawStrength = field.strength[d] * modulation[d]
    const conf = field.confidence[d]
    const [leftLabel, rightLabel] = DIM_LABELS[DIM_NAMES[d]]

    // 方向和强度
    let direction: string
    let absStrength: number
    if (rawStrength > 0.1) {
      direction = leftLabel
      absStrength = Math.min(1, Math.abs(rawStrength))
    } else if (rawStrength < -0.1) {
      direction = rightLabel
      absStrength = Math.min(1, Math.abs(rawStrength))
    } else {
      direction = '中性'
      absStrength = 0
    }

    dimensions.push({ name: DIM_NAMES[d], direction, strength: absStrength, confidence: conf })
  }

  // 生成策略提示
  const strategyHint = generateStrategyHint(dimensions, state, query)

  return { dimensions, state, strategyHint, dataReady }
}

/**
 * 根据认知场预测生成 LLM 策略提示。
 */
function generateStrategyHint(dims: CINPrediction['dimensions'], state: CognitiveState, query: string): string {
  const hints: string[] = []

  // 状态提示
  const stateHints: Record<CognitiveState, string> = {
    normal: '',
    pressure: '状态：压力大',
    relaxed: '状态：轻松',
    excited: '状态：兴奋',
    low: '状态：情绪低',
  }
  if (stateHints[state]) hints.push(stateHints[state])

  // 维度提示（只提示置信度高且方向明确的）
  for (const dim of dims) {
    if (dim.confidence < 0.3 || dim.strength < 0.2) continue

    switch (dim.name) {
      case 'risk':
        if (dim.direction === '保守') hints.push('推荐成熟稳定的方案，别推新技术')
        else hints.push('可以推荐新方案，他喜欢尝鲜')
        break
      case 'communication':
        if (dim.direction === '直接') hints.push('说话直接简洁，别绕弯')
        else hints.push('表达委婉一些，给他思考空间')
        break
      case 'emotion':
        if (dim.direction === '外放') hints.push('可以带感情回复，不用太理性')
        else hints.push('保持理性克制，少用感叹号')
        break
      case 'decision':
        if (dim.direction === '分析') hints.push('给数据和对比，他需要依据')
        else hints.push('给结论就行，别列太多数据')
        break
      case 'tempo':
        if (dim.direction === '计划') hints.push('给有步骤的方案，他喜欢有计划')
        else hints.push('灵活建议，别框太死')
        break
    }
  }

  if (hints.length === 0) return ''
  return `[认知场] ${hints.join('；')}`
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAUSAL CHAIN DISCOVERY — 因果链发现
// ═══════════════════════════════════════════════════════════════════════════════

let causalChains: CausalChain[] = loadJson<CausalChain[]>(CAUSAL_PATH, [])
function saveCausal() { debouncedSave(CAUSAL_PATH, causalChains) }

// 因果关键词对
const CAUSAL_TRIGGERS = [
  { trigger: /延期|deadline|ddl/, effect: /熬夜|加班|赶工/, label: '延期→熬夜' },
  { trigger: /熬夜|加班|没睡/, effect: /累|困|效率低|走神/, label: '熬夜→效率低' },
  { trigger: /被骂|被批|挨说/, effect: /压力|焦虑|烦|不开心/, label: '批评→焦虑' },
  { trigger: /升职|加薪|offer/, effect: /开心|高兴|庆祝/, label: '好消息→开心' },
  { trigger: /吵架|冲突|矛盾/, effect: /烦|心情差|不想/, label: '冲突→低落' },
  { trigger: /压力|焦虑|烦/, effect: /失眠|睡不着|睡眠差/, label: '焦虑→失眠' },
  { trigger: /运动|跑步|健身/, effect: /舒服|开心|状态好/, label: '运动→好心情' },
  { trigger: /学了|研究|看了/, effect: /试试|用了|实践/, label: '学习→实践' },
]

/**
 * 扫描记忆时间序列，发现因果链。心跳时调用。
 */
export function discoverCausalChains(memories: Memory[]) {
  const sorted = memories
    .filter(m => m.scope !== 'expired' && m.scope !== 'decayed')
    .sort((a, b) => a.ts - b.ts)

  for (const { trigger, effect, label } of CAUSAL_TRIGGERS) {
    let count = 0
    let totalDelay = 0

    for (let i = 0; i < sorted.length - 1; i++) {
      if (!trigger.test(sorted[i].content)) continue
      // 在 24 小时窗口内找 effect
      for (let j = i + 1; j < sorted.length; j++) {
        const delay = sorted[j].ts - sorted[i].ts
        if (delay > 86400000) break // 超过 24 小时
        if (effect.test(sorted[j].content)) {
          count++
          totalDelay += delay
          break
        }
      }
    }

    if (count >= 2) {
      // 更新或新增
      const existing = causalChains.find(c => c.trigger === label.split('→')[0] && c.effect === label.split('→')[1])
      if (existing) {
        existing.count = count
        existing.avgDelay = totalDelay / count
        existing.lastSeen = Date.now()
      } else {
        causalChains.push({
          trigger: label.split('→')[0],
          effect: label.split('→')[1],
          count,
          avgDelay: totalDelay / count,
          lastSeen: Date.now(),
        })
      }
    }
  }

  // 清理过时的因果链（90 天没出现）
  causalChains = causalChains.filter(c => Date.now() - c.lastSeen < 90 * 86400000)
  saveCausal()
}

/**
 * 获取当前激活的因果链预测。
 */
export function getCausalPrediction(recentMemories: Memory[]): string | null {
  if (causalChains.length === 0) return null

  for (const chain of causalChains) {
    // 检查最近的记忆是否匹配某个因果链的 trigger
    for (const mem of recentMemories.slice(-5)) {
      if (mem.content.includes(chain.trigger)) {
        const hoursAgo = (Date.now() - mem.ts) / 3600000
        const expectedHours = chain.avgDelay / 3600000
        if (hoursAgo < expectedHours * 2) {
          return `[因果预测] 用户最近提到"${chain.trigger}"，历史${chain.count}次显示之后通常会"${chain.effect}"（平均${Math.round(expectedHours)}小时后）`
        }
      }
    }
  }
  return null
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 获取完整的认知分析 augment（给 LLM 的提示）。
 * 在 handler-augments 或 soul-process 中调用。
 */
export function getCINAugment(query: string, recentMemories: Memory[], mood: number): string | null {
  if (field.sampleCount < 10) return null // 冷启动：数据不够不输出

  const prediction = predict(query, recentMemories, mood)
  const causal = getCausalPrediction(recentMemories)

  const parts: string[] = []
  if (prediction.strategyHint) parts.push(prediction.strategyHint)
  if (causal) parts.push(causal)

  return parts.length > 0 ? parts.join('\n') : null
}

/**
 * 获取认知场摘要（给 API /profile 用）。
 */
export function getFieldSummary(): Record<string, { direction: string; strength: number; confidence: number }> {
  const result: Record<string, any> = {}
  for (let d = 0; d < NUM_DIMS; d++) {
    const [left, right] = DIM_LABELS[DIM_NAMES[d]]
    const s = field.strength[d]
    result[DIM_NAMES[d]] = {
      direction: s > 0.1 ? left : s < -0.1 ? right : '中性',
      strength: Math.abs(s),
      confidence: field.confidence[d],
    }
  }
  return result
}

export function getFieldStats() {
  return {
    sampleCount: field.sampleCount,
    lastUpdated: field.lastUpdated,
    causalChains: causalChains.length,
    dimensions: getFieldSummary(),
  }
}
