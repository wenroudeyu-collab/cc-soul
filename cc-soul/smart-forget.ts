import { resolve } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import type { SoulModule } from './brain.ts'
import { getParam } from './auto-tune.ts'
import { trigrams, trigramSimilarity } from './memory-utils.ts'
import { DATA_DIR, loadJson, debouncedSave } from './persistence.ts'

/**
 * smart-forget.ts — Intelligent Memory Forgetting (Weibull + ACT-R)
 *
 * Combines two cognitive models to decide which memories should be forgotten:
 *
 * 1. Weibull survival model — age-based decay with shape k=1.5, scope-dependent
 *    scale lambda. Survival probability: S(t) = exp(-(t/λ)^k)
 *
 * 2. ACT-R base-level activation — B = ln(Σ t_i^(-d)), where t_i are time
 *    intervals since each access, d=0.5. Models memory strengthening via
 *    repeated retrieval.
 *
 * Decision rule:
 *   - Forget when: survival < 0.1 AND activation < -1.0
 *   - Consolidate when: survival > 0.8 AND activation > 2.0
 *
 * This module is read-only: it never mutates memory data, only returns
 * suggestions (indices to forget / consolidate).
 *
 * Exported API:
 *   computeForgetScore(mem) → 0-1 forget probability
 *   smartForgetSweep(memories) → { toForget, toConsolidate }
 *   smartForgetModule — SoulModule for brain.ts
 */

// ═══════════════════════════════════════════════════════════════════════════════
// FSRS-4.5 — Free Spaced Repetition Scheduler (replaces Weibull for new memories)
// Paper: https://arxiv.org/abs/2402.07345
// ═══════════════════════════════════════════════════════════════════════════════

export interface FSRSState {
  stability: number    // 记忆稳定度（天数）— 90% 检索概率对应的间隔
  difficulty: number   // 记忆难度 0-1 — 越难越容易忘
  reps: number         // 复习/召回次数
  lapses: number       // 遗忘次数
}

/** FSRS-7 default weights (extended from FSRS-4.5 with w[17] same-day review discount, w[18] curve shape) */
let FSRS_W = [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61, 0.12, 0.1]

/** Retrievability: probability of recall after elapsedDays, given stability S.
 *  R(t,S) = (1 + t/(9·S))^(-1)  — power-law decay, not exponential. */
export function fsrsRetrievability(elapsedDays: number, stability: number): number {
  if (stability <= 0 || !isFinite(stability)) return 1.0
  if (elapsedDays <= 0) return 1.0
  return Math.pow(1 + elapsedDays / (9 * stability), -1)
}

/** Update FSRS state after a recall event.
 *  rating: 1=again(forgot), 2=hard, 3=good, 4=easy */
export function fsrsUpdate(state: FSRSState, rating: 1 | 2 | 3 | 4, elapsedDays: number): FSRSState {
  const s = { ...state }
  const r = fsrsRetrievability(elapsedDays, s.stability)

  if (rating >= 3) {
    // Successful recall → stability grows
    const growthFactor = 1 + Math.exp(FSRS_W[8]) * (11 - s.difficulty * 10) *
      Math.pow(s.stability, -FSRS_W[9]) *
      (Math.exp((1 - r) * FSRS_W[10]) - 1)
    s.stability = Math.max(0.1, s.stability * growthFactor)
    s.reps++
    // Difficulty eases slightly on successful recall
    s.difficulty = Math.max(0, Math.min(1, s.difficulty - 0.02 * (rating - 2)))
  } else {
    // Failed recall / hard → stability shrinks
    s.stability = Math.max(0.1, s.stability * Math.pow(FSRS_W[11], s.difficulty * 10 - 1))
    s.lapses++
    s.reps++
    // Difficulty increases on failure
    s.difficulty = Math.max(0, Math.min(1, s.difficulty + 0.1 * (2 - rating)))
  }

  return s
}

/** Create initial FSRS state for a new memory */
export function fsrsInit(scope?: string): FSRSState {
  // scope-based initial difficulty: corrections are "easy" (never forget), episodes are harder
  const difficultyMap: Record<string, number> = {
    correction: 0.1, fact: 0.3, preference: 0.25, episode: 0.4, emotion: 0.5,
  }
  return {
    stability: scope === 'correction' ? 365 : 1.0,  // 1 day initial stability (corrections: 1 year)
    difficulty: difficultyMap[scope || 'fact'] ?? 0.3,
    reps: 0,
    lapses: 0,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BCM 元可塑性 (Metaplasticity) — 动态遗忘阈值
// Bienenstock-Cooper-Munro (1982)：突触可塑性阈值随整体活动水平滑动
// 活跃度高（用户频繁交互）→ 阈值升高 → 只有重要记忆才保留
// 活跃度低（用户不活跃）→ 阈值降低 → 更多记忆被保留（因为每条都珍贵）
// ═══════════════════════════════════════════════════════════════════════════════

function bcmAdaptiveThreshold(
  baseThreshold: number,
  recentActivityLevel: number  // 最近的消息频率，归一化到 [0, 1]
): number {
  // BCM 滑动阈值：θ = θ_base × (1 + α × (activity - mean_activity))
  // activity > mean → 阈值升高；activity < mean → 阈值降低
  const meanActivity = 0.3  // 基线活跃度（每天约 10 条消息）
  const alpha = 0.5  // 调节灵敏度
  const shift = alpha * (recentActivityLevel - meanActivity)
  return Math.max(0.05, Math.min(0.3, baseThreshold + shift))
}

// ═══════════════════════════════════════════════════════════════════════════════
// FSRS 个性化权重优化 — 从用户 recall hit/miss 数据中学习
// 每个人的遗忘曲线不同，FSRS-5 核心创新：从用户自己的复习数据中优化参数
// ═══════════════════════════════════════════════════════════════════════════════

interface FSRSTrainingExample {
  elapsedDays: number
  stability: number
  recalled: boolean  // 用户是否成功回忆了这条记忆
}

const FSRS_TRAINING_PATH = resolve(DATA_DIR, 'fsrs_training.json')
let fsrsTraining: FSRSTrainingExample[] = loadJson<FSRSTrainingExample[]>(FSRS_TRAINING_PATH, [])

/** 记录一次 recall 结果用于 FSRS 训练 */
export function recordFSRSTraining(elapsedDays: number, stability: number, recalled: boolean) {
  fsrsTraining.push({ elapsedDays, stability, recalled })
  // 保留最近 500 条训练数据
  if (fsrsTraining.length > 500) fsrsTraining = fsrsTraining.slice(-500)
  if (fsrsTraining.length % 20 === 0) {
    debouncedSave(FSRS_TRAINING_PATH, fsrsTraining)
  }
}

/**
 * 优化 FSRS 权重：每 100 条训练数据后执行一次
 * 只优化影响最大的 3 个参数（w[0], w[1], w[8]）
 * w[0]: 初始 stability 的基础
 * w[1]: 初始 stability 的难度调节
 * w[8]: 成功回忆后 stability 增长率
 */
export function optimizeFSRSWeights() {
  if (fsrsTraining.length < 50) return  // 数据不够

  const FSRS_W_LOCAL = [...FSRS_W]  // 复制一份本地权重
  const lr = 0.001  // 学习率
  const epochs = 5

  for (let epoch = 0; epoch < epochs; epoch++) {
    let totalLoss = 0

    for (const example of fsrsTraining) {
      const predictedR = Math.pow(1 + example.elapsedDays / (9 * example.stability), -1)
      const actualR = example.recalled ? 1 : 0
      const error = predictedR - actualR
      totalLoss += error * error

      // 对 w[8]（stability 增长率）做梯度更新
      // predicted 太高但没被回忆 → w[8] 该降低（stability 增长太乐观）
      // predicted 太低但被回忆了 → w[8] 该升高（stability 增长太保守）
      FSRS_W_LOCAL[8] -= lr * error * 0.1
    }

    const rmse = Math.sqrt(totalLoss / fsrsTraining.length)
    if (rmse < 0.2) break  // 足够好了
  }

  // 更新全局权重（保守：只调整 ±20%）
  for (let i = 0; i < FSRS_W.length; i++) {
    if (FSRS_W[i] === 0) continue  // 避免除零
    const ratio = FSRS_W_LOCAL[i] / FSRS_W[i]
    if (ratio > 0.8 && ratio < 1.2) {
      FSRS_W[i] = FSRS_W_LOCAL[i]
    }
  }

  console.log(`[cc-soul][fsrs] personalized weights optimized (n=${fsrsTraining.length}, w[8]=${FSRS_W[8].toFixed(4)})`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface MemoryInput {
  /** Creation timestamp (ms since epoch) */
  ts: number
  /** Number of times this memory has been recalled / accessed */
  recallCount: number
  /** Last access timestamp (ms since epoch) */
  lastAccessed: number
  /** Memory scope: 'fact', 'preference', 'correction', 'episode', etc. */
  scope: string
  /** Optional confidence 0-1 (defaults to 0.5) */
  confidence?: number
  /** FSRS state — new memories use FSRS, old memories without this field fall back to Weibull */
  fsrs?: FSRSState
}

interface SweepResult {
  /** Indices of memories recommended for forgetting */
  toForget: number[]
  /** Indices of memories recommended for consolidation */
  toConsolidate: number[]
}

interface ForgetStats {
  lastSweepTs: number
  lastSweepForget: number
  lastSweepConsolidate: number
  totalSweeps: number
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const MS_PER_DAY = 86400000

/** Weibull shape parameter — per-scope, read from tunable params (auto-tune.ts) */
const WEIBULL_K_DEFAULT: Record<string, number> = {
  fact: 1.2,
  preference: 0.9,
  episode: 1.4,
  correction: Infinity,  // corrections never decay
}

/** Get Weibull k for a scope (learnable EMA → tunable params → hardcoded defaults) */
export function getWeibullK(scope?: string): number {
  const s = scope || 'fact'
  // Check learned EMA params first
  if (_decayParams.scopeK && _decayParams.scopeK[s] !== undefined) return _decayParams.scopeK[s]
  // Then tunable params
  const paramKey = `forget.weibull_k_${s}`
  const tuned = getParam(paramKey)
  if (tuned > 0) return tuned
  return WEIBULL_K_DEFAULT[s] ?? getParam('forget.weibull_k_fact')
}

/** Backward-compatible constant (uses 'fact' default) */
export const WEIBULL_K = 1.2

/** Weibull scale (lambda) in days, by scope — now reads from tunable params */
function getWeibullLambda(scope: string): number {
  if (scope === 'correction') return Infinity
  const paramKey = `forget.weibull_lambda_${scope}`
  const tuned = getParam(paramKey)
  if (tuned > 0) return tuned
  // Fallback for scopes without dedicated param (e.g. emotion)
  const LEGACY_LAMBDA: Record<string, number> = { emotion: 7 }
  return LEGACY_LAMBDA[scope] ?? getParam('forget.weibull_lambda_fact')
}

/** ACT-R decay exponent — tunable */
function getActRDecay(): number { return getParam('forget.act_r_decay') }

/** Forget thresholds — tunable */
function getSurvivalForgetThreshold(): number { return getParam('forget.survival_threshold') }
function getActivationForgetThreshold(): number { return getParam('forget.activation_threshold') }

/** Consolidation thresholds — tunable */
function getSurvivalConsolidateThreshold(): number { return getParam('forget.consolidation_threshold_survival') }
function getActivationConsolidateThreshold(): number { return getParam('forget.consolidation_threshold_activation') }

// ═══════════════════════════════════════════════════════════════════════════════
// ADAPTIVE DECAY — learn lambda multiplier from recall hit/miss feedback
// ═══════════════════════════════════════════════════════════════════════════════

interface DecayParams {
  recallHits: number
  recallMisses: number
  lambdaMultiplier: number
  lastAdjustTs: number
  /** Per-scope learnable Weibull k values */
  scopeK?: Record<string, number>
}

const DECAY_PARAMS_FILENAME = 'decay_params.json'

let _decayParams: DecayParams = { recallHits: 0, recallMisses: 0, lambdaMultiplier: 1.0, lastAdjustTs: 0 }
let _decayParamsPath = ''

function loadDecayParams(dataDir: string) {
  _decayParamsPath = resolve(dataDir, DECAY_PARAMS_FILENAME)
  try {
    if (existsSync(_decayParamsPath)) {
      const raw = readFileSync(_decayParamsPath, 'utf-8').trim()
      if (raw) Object.assign(_decayParams, JSON.parse(raw))
    }
  } catch {}
}

function saveDecayParams() {
  if (!_decayParamsPath) return
  try { writeFileSync(_decayParamsPath, JSON.stringify(_decayParams, null, 2)) } catch {}
}

/** EMA alpha for adaptive lambda adjustment — now reads from auto-tune */
function getEMAAlpha(): number { return getParam('forget.ema_alpha') }

/** Clamp lambda multiplier to [0.5, 2.0] range */
function clampMultiplier(v: number): number { return Math.max(0.5, Math.min(2.0, v)) }

/** Record a recall hit (user later referenced the recalled memory) */
export function recordRecallHit(scope?: string, mem?: any) {
  _decayParams.recallHits++
  // EMA: nudge lambda multiplier toward 1.05 on hit (memory was useful → slow decay)
  _decayParams.lambdaMultiplier = clampMultiplier(
    _decayParams.lambdaMultiplier * (1 - getEMAAlpha()) + 1.05 * getEMAAlpha()
  )
  // EMA: nudge k downward on hit (lower k → flatter hazard → slower forget)
  if (scope && _decayParams.scopeK && _decayParams.scopeK[scope] !== undefined) {
    const kTarget = (WEIBULL_K_DEFAULT[scope] ?? 1.2) * 0.97  // target: 3% lower than default
    _decayParams.scopeK[scope] = _decayParams.scopeK[scope] * (1 - getEMAAlpha()) + kTarget * getEMAAlpha()
  }
  _decayParams.lastAdjustTs = Date.now()
  saveDecayParams()

  // ── FSRS 个性化训练数据收集 ──
  try {
    if (mem && mem.fsrs) {
      const elapsedDays = (Date.now() - (mem.lastAccessed || mem.ts)) / 86400000
      recordFSRSTraining(elapsedDays, mem.fsrs.stability, true)
      if (fsrsTraining.length >= 50 && fsrsTraining.length % 100 === 0) optimizeFSRSWeights()
    }
  } catch {}
}

/** Record a recall miss (recalled memory was ignored by user) */
export function recordRecallMiss(scope?: string, mem?: any) {
  _decayParams.recallMisses++
  // EMA: nudge lambda multiplier toward 0.95 on miss (memory was useless → faster decay)
  _decayParams.lambdaMultiplier = clampMultiplier(
    _decayParams.lambdaMultiplier * (1 - getEMAAlpha()) + 0.95 * getEMAAlpha()
  )
  // EMA: nudge k upward on miss (higher k → steeper hazard → faster forget)
  if (scope && _decayParams.scopeK && _decayParams.scopeK[scope] !== undefined) {
    const kDefault = WEIBULL_K_DEFAULT[scope] ?? 1.2
    _decayParams.scopeK[scope] = _decayParams.scopeK[scope] * (1 - getEMAAlpha()) + (kDefault * 1.03) * getEMAAlpha()
  }
  _decayParams.lastAdjustTs = Date.now()
  saveDecayParams()

  // ── FSRS 个性化训练数据收集 ──
  try {
    if (mem && mem.fsrs) {
      const elapsedDays = (Date.now() - (mem.lastAccessed || mem.ts)) / 86400000
      recordFSRSTraining(elapsedDays, mem.fsrs.stability, false)
      if (fsrsTraining.length >= 50 && fsrsTraining.length % 100 === 0) optimizeFSRSWeights()
    }
  } catch {}
}

/** Get current adaptive lambda multiplier */
export function getLambdaMultiplier(): number {
  return _decayParams.lambdaMultiplier
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEIBULL SURVIVAL MODEL
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Weibull survival probability: S(t) = exp(-(t/λ)^k)
 *
 * @param ageDays — age of memory in days
 * @param lambda — scale parameter in days
 * @param k — shape parameter (>1 means increasing hazard)
 * @returns survival probability in [0, 1]
 */
export function weibullSurvival(ageDays: number, lambda: number, k: number): number {
  if (!isFinite(lambda)) return 1.0  // e.g. correction scope → never decays
  if (ageDays <= 0) return 1.0
  if (lambda <= 0) return 0.0
  return Math.exp(-Math.pow(ageDays / lambda, k))
}

/**
 * Get Weibull lambda for a given scope, adjusted by recall count.
 * More recalls → longer effective half-life (up to 3x).
 */
export function effectiveLambda(scope: string, recallCount: number, emotionIntensity?: number): number {
  const baseLambda = getWeibullLambda(scope)
  if (!isFinite(baseLambda)) return Infinity
  // Each recall extends lambda, capped at configurable max
  const recallMultiplier = Math.min(1 + recallCount * getParam('forget.recall_increment_percent') / 100, getParam('forget.lambda_max_multiplier'))
  // 连续情绪-记忆耦合（替代阶梯乘数）
  // λ(ei) = 1 + α × ei^β，其中 α=1.5, β=2.0
  // ei=0 → 1.0（无影响）
  // ei=0.5 → 1.375（轻微延长）
  // ei=0.8 → 1.96（接近2x）
  // ei=1.0 → 2.5（极强记忆）
  const ei = emotionIntensity ?? 0
  const emotionAlpha = 1.5  // 最大增强幅度
  const emotionBeta = 2.0   // 非线性指数（越大越需要高情绪才有效）
  const emotionMultiplier = 1 + emotionAlpha * Math.pow(ei, emotionBeta)
  return baseLambda * recallMultiplier * emotionMultiplier * _decayParams.lambdaMultiplier
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACT-R BASE-LEVEL ACTIVATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ACT-R base-level activation: B = ln(Σ t_i^(-d))
 *
 * We approximate access history by distributing `recallCount` accesses
 * evenly between creation and last access time.
 *
 * @param mem — memory record
 * @param now — current timestamp
 * @returns activation value (higher = more accessible)
 */
function actRActivation(mem: MemoryInput, now: number): number {
  const n = Math.max(mem.recallCount, 1)
  const createdAgo = Math.max((now - mem.ts) / 1000, 1)            // seconds ago
  const lastAgo = Math.max((now - mem.lastAccessed) / 1000, 1)     // seconds ago

  let sum = 0

  if (n === 1) {
    // Single access at lastAccessed time
    sum = Math.pow(lastAgo, -getActRDecay())
  } else {
    // Distribute accesses evenly from creation to lastAccessed (cap at configurable iterations)
    const cap = Math.min(n, getParam('forget.actr_max_iterations'))
    for (let i = 0; i < cap; i++) {
      const fraction = cap === 1 ? 1 : i / (cap - 1)
      const accessAgo = createdAgo - fraction * (createdAgo - lastAgo)
      const t = Math.max(accessAgo, 1)
      sum += Math.pow(t, -getActRDecay())
    }
  }

  return sum > 0 ? Math.log(sum) : -Infinity
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ensure all memories have FSRS state — auto-initialize for legacy memories without fsrs field.
 * Uses scope and age to produce reasonable initial stability/difficulty.
 */
function ensureFSRS(mem: MemoryInput): { stability: number; difficulty: number } {
  if (mem.fsrs) return mem.fsrs
  // 旧记忆：根据 scope 和年龄初始化 FSRS
  const ageDays = (Date.now() - (mem.ts || Date.now())) / MS_PER_DAY
  const scope = mem.scope || 'fact'
  let stability = scope === 'correction' ? 365 : scope === 'preference' ? 60 : scope === 'episode' ? 7 : 30
  let difficulty = scope === 'correction' ? 1 : scope === 'preference' ? 3 : scope === 'episode' ? 7 : 5
  // 根据 recallCount 调整：被多次召回的记忆更稳定
  const recalls = mem.recallCount || 0
  if (recalls > 0) stability *= (1 + recalls * 0.3)
  return { stability, difficulty }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LECTOR 语义干扰 (Proactive Interference)
// 相似记忆越多 → 干扰越强 → stability 折扣
// ═══════════════════════════════════════════════════════════════════════════════

/** Lazy reference to memoryState (avoid circular import at module level) */
let _memoryStateMod: any = null

function semanticInterference(memContent: string): number {
  // Lazy-load memoryState to avoid circular dependency
  if (!_memoryStateMod) {
    try { _memoryStateMod = require('./memory.ts') } catch { return 1.0 }
  }
  const allMems = _memoryStateMod?.memoryState?.memories
  if (!allMems || allMems.length < 5) return 1.0

  const memTri = trigrams(memContent)
  if (memTri.size === 0) return 1.0

  // 语义空间聚集度：不只数个数，还考虑平均相似度 × 聚集密度
  let totalSim = 0
  let count = 0
  let contradictionPenalty = 0
  // Check last 100 memories for interference
  const recent = allMems.slice(-100)
  for (const other of recent) {
    if (!other || other.scope === 'expired' || other.content === memContent) continue
    const otherTri = trigrams(other.content)
    const sim = trigramSimilarity(memTri, otherTri)
    if (sim < 0.15) continue  // 降低阈值，捕获更多弱关联

    totalSim += sim
    count++

    // 矛盾记忆额外惩罚
    const isContradiction = detectContradictionSignals(memContent, other.content)
    if (isContradiction) contradictionPenalty += 0.2
  }

  if (count === 0) return 1.0  // 独特记忆，无干扰

  // 聚集度 = 平均相似度 × log(相似记忆数) → 越聚集干扰越强
  const avgSim = totalSim / count
  const clustering = avgSim * Math.log1p(count) + contradictionPenalty
  return 1 / (1 + clustering * 0.3)
}

/** 检测两条记忆之间是否有矛盾信号 */
function detectContradictionSignals(a: string, b: string): boolean {
  const CONTRADICTION_PAIRS: [RegExp, RegExp][] = [
    [/喜欢|爱|偏好/, /讨厌|不喜欢|不想/],
    [/在.*工作|在.*做/, /离职|辞职|被裁/],
    [/住在|住/, /搬到|搬去/],
    [/运动|跑步|健身/, /不运动|不跑|放弃/],
    [/学|在学/, /不学|放弃/],
    [/是|用/, /不是|不用|换了/],
  ]
  for (const [patA, patB] of CONTRADICTION_PAIRS) {
    if ((patA.test(a) && patB.test(b)) || (patB.test(a) && patA.test(b))) return true
  }
  return false
}

/**
 * Compute a composite forget score for a single memory.
 *
 * @returns 0-1 probability of forgetting (1 = definitely forget)
 */
export function computeForgetScore(mem: MemoryInput): number {
  const now = Date.now()
  const ageDays = (now - mem.ts) / MS_PER_DAY

  // ── 统一 FSRS 路径：所有记忆（含旧记忆）都走 FSRS ──
  const fsrs = ensureFSRS(mem)
  // LECTOR: 语义干扰折扣 — 相似记忆越多，stability 越低
  const interference = semanticInterference((mem as any).content || '')
  const effectiveStability = fsrs.stability * interference
  const survival = fsrsRetrievability(ageDays, effectiveStability)

  // ACT-R activation
  const activation = actRActivation(mem, now)

  // Confidence bonus: high confidence memories are harder to forget
  const conf = mem.confidence ?? 0.5
  const confidenceBonus = conf * 0.2  // up to 0.2 survival boost

  // Combine: forget probability = (1 - survival) * sigmoid(-activation)
  // sigmoid maps activation → 0-1 (lower activation → higher forget)
  const sigmoid = 1 / (1 + Math.exp(activation))
  const rawForget = (1 - survival - confidenceBonus) * sigmoid

  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, rawForget))
}

/**
 * Batch-scan memories and return indices of those that should be
 * forgotten or consolidated. Does NOT mutate the input array.
 */
export function smartForgetSweep(memories: any[]): SweepResult {
  const now = Date.now()
  const toForget: number[] = []
  const toConsolidate: number[] = []

  // ── BCM 元可塑性：计算最近活跃度，动态调整遗忘阈值 ──
  const oneDayAgo = now - 86400000
  const recentCount = memories.filter(m => m && m.ts > oneDayAgo && m.scope !== 'expired').length
  const activityLevel = Math.min(1, recentCount / 100)

  // BCM 自适应阈值
  const survivalThreshold = bcmAdaptiveThreshold(getSurvivalForgetThreshold(), activityLevel)
  const activationThreshold = getActivationForgetThreshold() * (1 + (activityLevel - 0.3) * 0.3)

  for (let i = 0; i < memories.length; i++) {
    const m = memories[i]
    if (!m || typeof m.ts !== 'number') continue

    const mem: MemoryInput = {
      ts: m.ts ?? now,
      recallCount: m.recallCount ?? m.recall_count ?? 0,
      lastAccessed: m.lastAccessed ?? m.last_accessed ?? m.ts ?? now,
      scope: m.scope ?? m.type ?? 'fact',
      confidence: m.confidence,
    }

    const ageDays = (now - mem.ts) / MS_PER_DAY

    // ── 统一 FSRS 路径 ──
    const fsrs = ensureFSRS({ ...mem, fsrs: (m as any).fsrs })
    const survival = fsrsRetrievability(ageDays, fsrs.stability)
    const activation = actRActivation(mem, now)

    // Forget: low survival AND low activation (BCM adaptive thresholds)
    if (survival < survivalThreshold && activation < activationThreshold) {
      toForget.push(i)
      continue
    }

    // Consolidate: high survival AND high activation (memory is strong)
    if (survival > getSurvivalConsolidateThreshold() && activation > getActivationConsolidateThreshold()) {
      toConsolidate.push(i)
    }
  }

  return { toForget, toConsolidate }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FSRS 主动回顾推荐 (Active Recall Recommendation)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * FSRS 主动回顾推荐：找出即将被遗忘但值得保留的记忆
 * 在最佳时机（retrievability 接近遗忘阈值但还没忘）推荐回顾
 *
 * 选择标准：
 * 1. retrievability 在 0.3-0.6 之间（即将忘但还没完全忘）
 * 2. importance >= 6（值得保留的记忆）
 * 3. 不是 expired/decayed/consolidated
 */
export function getRecallRecommendations(memories: any[], maxCount: number = 3): { content: string; urgency: number }[] {
  const now = Date.now()
  const candidates: { mem: any; retrievability: number; importance: number; urgency: number }[] = []

  for (const m of memories) {
    if (!m || m.scope === 'expired' || m.scope === 'decayed' || m.scope === 'consolidated') continue
    const importance = m.importance ?? 5
    if (importance < 6) continue  // 不重要的不推荐

    const fsrs = m.fsrs || { stability: 30, difficulty: 5 }
    const ageDays = (now - (m.ts || now)) / MS_PER_DAY
    const retrievability = Math.pow(1 + ageDays / (9 * fsrs.stability), -1)

    // 最佳回顾窗口：retrievability 在 0.3-0.6 之间
    if (retrievability >= 0.3 && retrievability <= 0.6) {
      const urgency = (0.6 - retrievability) / 0.3  // 0→1，越接近忘越紧急
      candidates.push({ mem: m, retrievability, importance, urgency })
    }
  }

  // 按紧急度 × 重要度排序
  candidates.sort((a, b) => (b.urgency * b.importance) - (a.urgency * a.importance))

  return candidates.slice(0, maxCount).map(c => ({
    content: c.mem.content.slice(0, 80),
    urgency: c.urgency,
  }))
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL STATS
// ═══════════════════════════════════════════════════════════════════════════════

const stats: ForgetStats = {
  lastSweepTs: 0,
  lastSweepForget: 0,
  lastSweepConsolidate: 0,
  totalSweeps: 0,
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOUL MODULE
// ═══════════════════════════════════════════════════════════════════════════════

export const smartForgetModule: SoulModule = {
  id: 'smart-forget',
  name: '智能遗忘引擎',
  features: ['smart_forget'],
  priority: 20,

  async init(): Promise<void> {
    // Load adaptive decay params
    try {
      const { DATA_DIR } = await import('./persistence.ts')
      loadDecayParams(DATA_DIR)
    } catch {
      // Fallback: homedir-based path
      try {
        const { homedir } = await import('os')
        const p = resolve(homedir(), '.openclaw/plugins/cc-soul/data')
        if (existsSync(p)) loadDecayParams(p)
      } catch {}
    }
    // Initialize per-scope k defaults if not yet stored
    if (!_decayParams.scopeK) {
      _decayParams.scopeK = { ...WEIBULL_K_DEFAULT }
      saveDecayParams()
    }
    console.log(`[smart-forget] initialized — FSRS-7 + LECTOR interference, ACT-R d=0.5, λ-multiplier=${_decayParams.lambdaMultiplier.toFixed(3)} (EMA α=${getEMAAlpha()})`)
  },

  dispose(): void {
    // Nothing to clean up — stateless module
  },

  /** Periodic sweep during heartbeat */
  async onHeartbeat(): Promise<void> {
    // Lazy-import memory state to avoid circular dependency at module level
    let memories: any[] = []
    try {
      // Dynamic import to avoid side-effects at module level
      const memModule = await import('./memory.ts')
      memories = memModule?.memoryState?.memories ?? []
    } catch {
      // If memory module not available, skip
      return
    }

    if (memories.length === 0) return

    const result = smartForgetSweep(memories)
    stats.lastSweepTs = Date.now()
    stats.lastSweepForget = result.toForget.length
    stats.lastSweepConsolidate = result.toConsolidate.length
    stats.totalSweeps++

    // Execute forget: mark expired (reverse order to preserve indices)
    if (result.toForget.length > 0) {
      const maxPerSweep = getParam('forget.max_per_sweep')
      const toForget = result.toForget.slice(0, maxPerSweep)
      for (let i = toForget.length - 1; i >= 0; i--) {
        const idx = toForget[i]
        if (idx >= 0 && idx < memories.length && memories[idx].scope !== 'expired') {
          memories[idx].scope = 'expired'
        }
      }
    }

    // Execute consolidate: promote scope
    if (result.toConsolidate.length > 0) {
      for (const idx of result.toConsolidate) {
        if (idx >= 0 && idx < memories.length && memories[idx].scope !== 'consolidated') {
          memories[idx].scope = 'consolidated'
        }
      }
    }

    if (result.toForget.length > 0 || result.toConsolidate.length > 0) {
      // Persist changes
      try {
        const memModule = await import('./memory.ts')
        memModule.saveMemories()
      } catch {}

      console.log(
        `[smart-forget] sweep #${stats.totalSweeps}: ` +
        `${result.toForget.length} forgotten, ${result.toConsolidate.length} consolidated ` +
        `(out of ${memories.length} memories)`
      )
    }
  },
}
