/**
 * auto-tune.ts — Parameter auto-tuning via Thompson Sampling bandit
 *
 * Each tunable parameter is discretized into 5 arms (0.5x..1.5x of default).
 * A Beta distribution tracks success/failure for each arm. Thompson Sampling
 * selects which arm to play. Learns online from every response quality signal.
 *
 * Replaces the old fixed-duration A/B experiment approach with continuous
 * Bayesian optimization that converges faster and handles non-stationarity.
 */

import { resolve } from 'path'
import { DATA_DIR, loadJson, saveJson, debouncedSave } from './persistence.ts'
import { notifyOwnerDM } from './notify.ts'
import { computeEval } from './quality.ts'
import type { InteractionStats } from './types.ts'

// ══════════════════════════════════════════════════════════════════════════════
// TUNABLE PARAMETERS — centralized config (replaces hardcoded constants)
// ══════════════════════════════════════════════════════════════════════════════

const PARAMS_PATH = resolve(DATA_DIR, 'tunable_params.json')
const TUNE_STATE_PATH = resolve(DATA_DIR, 'auto_tune_state.json')

/** Default values — exactly matching current hardcoded constants */
const DEFAULT_PARAMS: Record<string, number> = {
  // memory.ts
  'memory.recall_top_n': 3,
  'memory.age_decay_rate': 0.02,
  'memory.consolidation_cooldown_hours': 24,
  'memory.session_summary_cooldown_min': 30,
  'memory.contradiction_scan_cooldown_hours': 24,

  // body.ts
  'body.energy_recovery_per_min': 0.015,
  'body.alertness_decay_per_min': 0.008,
  'body.alertness_recovery_per_min': 0.005,
  'body.load_decay_per_min': 0.02,
  'body.mood_decay_factor': 0.98,
  'body.correction_alertness_boost': 0.2,
  'body.correction_mood_penalty': 0.1,
  'body.positive_energy_boost': 0.05,
  'body.positive_mood_boost': 0.08,
  'body.positive_anomaly_reduction': 0.05,
  'body.resilience': 0.3,
  'body.message_energy_base_cost': 0.02,
  'body.message_energy_complexity_cost': 0.03,
  'body.message_load_base': 0.1,
  'body.message_load_complexity': 0.15,
  'body.correction_anomaly_boost': 0.15,
  'body.anomaly_decay_per_min': 0.01,

  // cognition.ts
  'cognition.casual_max_length': 15,
  'cognition.quick_intent_max_length': 20,
  'cognition.detailed_min_length': 200,

  // quality.ts
  'quality.medium_length_bonus': 0.5,
  'quality.long_length_bonus': 0.5,
  'quality.reasoning_bonus': 1.0,
  'quality.code_bonus': 0.5,
  'quality.ai_exposure_penalty': 2.0,
  'quality.relevance_weight': 1.5,

  // flow.ts
  'flow.frustration_shortening_rate': 0.2,
  'flow.frustration_terse': 0.15,
  'flow.frustration_keyword_rate': 0.3,
  'flow.frustration_question_rate': 0.1,
  'flow.frustration_repetition': 0.15,
  'flow.frustration_decay_per_turn': 0.05,
  'flow.stuck_threshold': 0.5,

  // prompt-builder.ts
  'prompt.augment_budget': 3500,


  // evolution.ts
  'evolution.hypothesis_verify_threshold': 5,
  'evolution.hypothesis_reject_threshold': 3,
  'evolution.max_rules': 50,

  // inner-life.ts
  'inner.journal_cooldown_min': 30,
  'inner.reflection_cooldown_hours': 24,
  'inner.dream_idle_min': 60,
  'inner.dream_cooldown_hours': 2,

  // memory.ts — fusion weights
  'memory.fusion_text_weight': 0.5,
  'memory.fusion_vec_weight': 0.5,
  'memory.fusion_multi_source_boost': 1.3,

  // memory.ts — recall scoring
  'memory.trigram_dedup_threshold': 0.7,
  'memory.bm25_k1': 1.2,
  'memory.bm25_b': 0.75,
  'memory.time_decay_halflife_days': 90,

  // evolution.ts — hypothesis thresholds
  'evolution.rule_dedup_threshold': 0.45,
  'evolution.hypothesis_verify_ci_lb': 0.6,
  'evolution.hypothesis_reject_ci_ub': 0.4,
  'evolution.hypothesis_match_min_sim': 0.2,
  'evolution.reflexion_sim_threshold': 0.3,

  // body.ts — emotional contagion
  'body.contagion_max_shift': 0.15,

  // fingerprint.ts — deviation thresholds
  'fingerprint.length_upper_multiplier': 3,
  'fingerprint.length_lower_multiplier': 0.15,
  'fingerprint.hedge_word_limit': 5,

  // graph.ts — stale entity threshold
  'graph.stale_days': 90,

  // persona.ts — blend thresholds
  'persona.blend_gap_threshold': 0.3,
  'persona.attention_trigger_bonus': 0.2,
}

/** The live params — loaded from disk, falls back to defaults */
let params: Record<string, number> = { ...DEFAULT_PARAMS }

export function loadTunableParams() {
  const saved = loadJson<Record<string, number>>(PARAMS_PATH, {})
  params = { ...DEFAULT_PARAMS, ...saved }
  // Save back to add any new default keys
  saveJson(PARAMS_PATH, params)
}

/** Get a tunable parameter value (used by other modules) */
export function getParam(key: string): number {
  return params[key] ?? DEFAULT_PARAMS[key] ?? 0
}

/** Set a parameter (for experiment or manual override) */
export function setParam(key: string, value: number) {
  params[key] = value
  debouncedSave(PARAMS_PATH, params)
}

/** Get all params (for dashboard) */
export function getAllParams(): Record<string, number> {
  return { ...params }
}

/** Reset a param to default */
export function resetParam(key: string) {
  params[key] = DEFAULT_PARAMS[key] ?? 0
  debouncedSave(PARAMS_PATH, params)
}

// ══════════════════════════════════════════════════════════════════════════════
// LEGACY STATE — kept for backward compatibility (old experiment history)
// ══════════════════════════════════════════════════════════════════════════════

interface TuneExperiment {
  paramKey: string
  originalValue: number
  testValue: number
  startedAt: number
  endsAt: number
  preMetrics: { avgQuality: number; correctionRate: number; messages: number }
  postMetrics: { avgQuality: number; correctionRate: number; messages: number }
  status: 'running' | 'adopted' | 'reverted' | 'insufficient_data'
}

interface TuneState {
  currentExperiment: TuneExperiment | null
  history: TuneExperiment[]
  lastTuneCheck: number
  paramQueue: string[]
}

let tuneState: TuneState = loadJson(TUNE_STATE_PATH, {
  currentExperiment: null,
  history: [],
  lastTuneCheck: 0,
  paramQueue: [],
})

function saveTuneState() {
  debouncedSave(TUNE_STATE_PATH, tuneState)
}

// ══════════════════════════════════════════════════════════════════════════════
// THOMPSON SAMPLING BANDIT — data structures
// ══════════════════════════════════════════════════════════════════════════════

interface BanditArm {
  value: number
  alpha: number  // successes + 1 (Beta prior)
  beta: number   // failures + 1 (Beta prior)
  pulls: number
}

interface ParamBanditState {
  key: string
  arms: BanditArm[]
  currentArm: number  // index of currently active arm
  totalPulls: number
}

const BANDIT_STATE_PATH = resolve(DATA_DIR, 'bandit_state.json')
let banditState: Record<string, ParamBanditState> = {}

// ══════════════════════════════════════════════════════════════════════════════
// THOMPSON SAMPLING MATH — pure JS, no dependencies
// ══════════════════════════════════════════════════════════════════════════════

/** Standard normal sample via Box-Muller */
function randn(): number {
  const u1 = Math.random(), u2 = Math.random()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/** Gamma distribution sample via Marsaglia-Tsang method */
function gammaSample(shape: number): number {
  shape = Math.max(0.01, shape)  // guard against NaN from zero/negative shape
  if (shape < 1) return gammaSample(shape + 1) * Math.pow(Math.random(), 1 / shape)
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  while (true) {
    let x: number, v: number
    do { x = randn(); v = 1 + c * x } while (v <= 0)
    v = v * v * v
    const u = Math.random()
    if (u < 1 - 0.0331 * x * x * x * x) return d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

/** Beta distribution sample via two Gamma samples */
function betaSample(alpha: number, beta: number): number {
  const safeAlpha = Math.max(0.01, alpha)
  const safeBeta = Math.max(0.01, beta)
  const x = gammaSample(safeAlpha)
  const y = gammaSample(safeBeta)
  return x / (x + y)
}

/** Thompson Sampling: draw from each arm's posterior, pick the max */
function selectArm(state: ParamBanditState): number {
  let bestIdx = state.currentArm, bestSample = -1
  for (let i = 0; i < state.arms.length; i++) {
    const sample = betaSample(state.arms[i].alpha, state.arms[i].beta)
    if (sample > bestSample) {
      bestSample = sample
      bestIdx = i
    }
  }
  return bestIdx
}

// ══════════════════════════════════════════════════════════════════════════════
// BANDIT INITIALIZATION & PERSISTENCE
// ══════════════════════════════════════════════════════════════════════════════

/** Check if a param key is integer-like */
function isIntegerParam(key: string): boolean {
  return key.includes('cooldown') || key.includes('threshold') ||
         key.includes('max_') || key.includes('top_n') || key.includes('min_')
}

/** Create bandit state for a single parameter */
function initBanditForParam(key: string): ParamBanditState | null {
  const defaultVal = DEFAULT_PARAMS[key]
  if (defaultVal === undefined) return null

  const multipliers = [0.5, 0.75, 1.0, 1.25, 1.5]
  const isInt = isIntegerParam(key)

  return {
    key,
    arms: multipliers.map(m => ({
      value: isInt ? Math.max(1, Math.round(defaultVal * m)) : Math.max(0.001, +(defaultVal * m).toFixed(4)),
      alpha: 1,  // uniform prior
      beta: 1,
      pulls: 0,
    })),
    currentArm: 2, // index 2 = 1.0x = default value
    totalPulls: 0,
  }
}

function loadBanditState() {
  banditState = loadJson<Record<string, ParamBanditState>>(BANDIT_STATE_PATH, {})
  console.log(`[cc-soul][auto-tune] bandit state loaded: ${Object.keys(banditState).length} params tracked`)
}

function saveBanditState() {
  debouncedSave(BANDIT_STATE_PATH, banditState)
}

// ══════════════════════════════════════════════════════════════════════════════
// HIGH-IMPACT PARAMS — prioritized for exploration
// ══════════════════════════════════════════════════════════════════════════════

const HIGH_IMPACT_PARAMS = [
  'memory.recall_top_n',
  'memory.age_decay_rate',
  'body.energy_recovery_per_min',
  'body.resilience',
  'body.mood_decay_factor',
  'quality.reasoning_bonus',
  'quality.relevance_weight',
  'flow.stuck_threshold',
  'flow.frustration_decay_per_turn',
  'prompt.augment_budget',
  'voice.impulse_threshold',
  'evolution.hypothesis_verify_threshold',
  'memory.trigram_dedup_threshold',
  'memory.bm25_k1',
  'evolution.rule_dedup_threshold',
  'body.contagion_max_shift',
  'graph.stale_days',
]

// ══════════════════════════════════════════════════════════════════════════════
// MAIN LOOP — Thompson Sampling replaces fixed A/B experiments
// ══════════════════════════════════════════════════════════════════════════════

const TUNE_CHECK_INTERVAL = 86400000 // check once per day

export function checkAutoTune(stats: InteractionStats) {
  const now = Date.now()

  // ── Finish any legacy running experiment first ──
  if (tuneState.currentExperiment) {
    const exp = tuneState.currentExperiment
    if (now >= exp.endsAt) {
      evaluateLegacyExperiment(stats)
    }
    return
  }

  // ── Cooldown ──
  if (now - tuneState.lastTuneCheck < TUNE_CHECK_INTERVAL) return

  // ── Need enough data ──
  if (stats.totalMessages < 50) return

  tuneState.lastTuneCheck = now

  // ── Initialize bandit state if needed ──
  if (Object.keys(banditState).length === 0) {
    loadBanditState()
  }

  // ── Build candidate list, excluding quality.* params (self-learning in quality.ts) ──
  const allKeys = Object.keys(DEFAULT_PARAMS).filter(k => !k.startsWith('quality.'))
  const exploreCount = 2

  // Ensure all params have bandit state
  for (const key of allKeys) {
    if (!banditState[key]) {
      const state = initBanditForParam(key)
      if (state) banditState[key] = state
    }
  }

  // Sort by fewest pulls (explore least-tested first), HIGH_IMPACT first
  const candidates = allKeys
    .filter(key => banditState[key])
    .map(key => ({ key, pulls: banditState[key].totalPulls }))
    .sort((a, b) => a.pulls - b.pulls)

  const highImpact = candidates.filter(c => HIGH_IMPACT_PARAMS.includes(c.key))
  const others = candidates.filter(c => !HIGH_IMPACT_PARAMS.includes(c.key))

  const toExplore: string[] = []
  for (const c of [...highImpact, ...others]) {
    if (toExplore.length >= exploreCount) break
    toExplore.push(c.key)
  }

  // ── Thompson Sampling: select arm for explored params ──
  for (const key of toExplore) {
    const state = banditState[key]
    if (!state) continue
    const armIdx = selectArm(state)
    state.currentArm = armIdx
    setParam(key, state.arms[armIdx].value)
    console.log(`[cc-soul][auto-tune] bandit explore: ${key} → arm[${armIdx}] = ${state.arms[armIdx].value} (pulls=${state.totalPulls})`)
  }

  saveBanditState()
  saveTuneState()
}

// ══════════════════════════════════════════════════════════════════════════════
// BANDIT REWARD UPDATE — called from handler.ts after each response
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Update bandit rewards after each response.
 * Called from handler.ts with quality score and correction flag.
 */
export function updateBanditReward(qualityScore: number, wasCorrection: boolean) {
  if (Object.keys(banditState).length === 0) return

  // Continuous reward: map score 1-10 to probability 0-1
  let successProb = Math.max(0, Math.min(1, (qualityScore - 1) / 9))

  // Correction penalty: reduce success probability
  if (wasCorrection) {
    successProb = Math.min(successProb, 0.2)
  }

  // Clamp reward to valid [0,1] range after all adjustments
  const reward = Math.max(0, Math.min(1, successProb))

  for (const [key, state] of Object.entries(banditState)) {
    const armIdx = state.currentArm
    if (armIdx < 0 || armIdx >= state.arms.length) continue

    state.arms[armIdx].pulls++
    state.totalPulls++
    // Continuous Beta update
    state.arms[armIdx].alpha += reward
    state.arms[armIdx].beta += (1 - reward)
  }

  saveBanditState()
}

// ══════════════════════════════════════════════════════════════════════════════
// LEGACY EXPERIMENT EVALUATE — handles old running experiments during migration
// ══════════════════════════════════════════════════════════════════════════════

function evaluateLegacyExperiment(stats: InteractionStats) {
  const exp = tuneState.currentExperiment
  if (!exp) return

  const currentEval = computeEval(stats.totalMessages, stats.corrections)
  const windowMessages = stats.totalMessages - exp.preMetrics.messages

  exp.postMetrics = {
    avgQuality: currentEval.avgQuality,
    correctionRate: currentEval.correctionRate,
    messages: windowMessages,
  }

  if (windowMessages < 10) {
    exp.status = 'insufficient_data'
    setParam(exp.paramKey, exp.originalValue)
    notifyOwnerDM(
      `⏳ 调参实验数据不足（${windowMessages} 条消息），已恢复 ${exp.paramKey} = ${exp.originalValue}`
    ).catch(() => {})
  } else {
    const qualityDelta = currentEval.avgQuality - exp.preMetrics.avgQuality
    const correctionDelta = currentEval.correctionRate - exp.preMetrics.correctionRate
    const improved = qualityDelta > 0.2 || correctionDelta < -2
    const regressed = qualityDelta < -0.5 || correctionDelta > 3

    if (improved && !regressed) {
      exp.status = 'adopted'
      notifyOwnerDM(
        `✅ 调参实验成功！\n` +
        `参数: ${exp.paramKey}\n` +
        `${exp.originalValue} → ${exp.testValue} (已采用)\n` +
        `质量: ${exp.preMetrics.avgQuality.toFixed(1)} → ${currentEval.avgQuality.toFixed(1)} (${qualityDelta >= 0 ? '+' : ''}${qualityDelta.toFixed(1)})\n` +
        `纠正率: ${exp.preMetrics.correctionRate.toFixed(1)}% → ${currentEval.correctionRate.toFixed(1)}%`
      ).catch(() => {})
    } else {
      exp.status = 'reverted'
      setParam(exp.paramKey, exp.originalValue)
      notifyOwnerDM(
        `↩️ 调参实验未改善，已恢复\n` +
        `参数: ${exp.paramKey} = ${exp.originalValue}\n` +
        `质量: ${qualityDelta >= 0 ? '+' : ''}${qualityDelta.toFixed(1)}, 纠正率: ${correctionDelta >= 0 ? '+' : ''}${correctionDelta.toFixed(1)}%`
      ).catch(() => {})
    }
  }

  tuneState.history.push({ ...exp })
  if (tuneState.history.length > 100) tuneState.history = tuneState.history.slice(-100)
  tuneState.currentExperiment = null
  saveTuneState()

  console.log(`[cc-soul][auto-tune] legacy experiment ended: ${exp.paramKey} → ${exp.status}`)
}

// ══════════════════════════════════════════════════════════════════════════════
// COMMAND HANDLER — "调参状态" / "调参历史" / "调参 key=value"
// ══════════════════════════════════════════════════════════════════════════════

export function handleTuneCommand(msg: string): boolean {
  const m = msg.trim()

  if (m === '调参状态' || m === 'tune status') {
    // Legacy experiment status
    const exp = tuneState.currentExperiment
    if (exp) {
      const daysLeft = Math.ceil((exp.endsAt - Date.now()) / 86400000)
      console.log(`[cc-soul][auto-tune] legacy experiment running: ${exp.paramKey} ${exp.originalValue}→${exp.testValue}, ${daysLeft}d left`)
    }

    // Bandit status
    const tracked = Object.keys(banditState).length
    if (tracked > 0) {
      const totalPulls = Object.values(banditState).reduce((s, st) => s + st.totalPulls, 0)
      console.log(`[cc-soul][auto-tune] bandit: ${tracked} params tracked, ${totalPulls} total pulls`)

      // Show top 5 most-pulled params with their best arm
      const sorted = Object.values(banditState)
        .filter(st => st.totalPulls > 0)
        .sort((a, b) => b.totalPulls - a.totalPulls)
        .slice(0, 5)
      for (const st of sorted) {
        const bestArm = st.arms.reduce((best, arm, i) =>
          (arm.alpha / (arm.alpha + arm.beta)) > (best.ratio) ? { idx: i, ratio: arm.alpha / (arm.alpha + arm.beta) } : best,
          { idx: 0, ratio: 0 }
        )
        const current = st.arms[st.currentArm]
        console.log(`  ${st.key}: arm[${st.currentArm}]=${current.value} (pulls=${st.totalPulls}, best=arm[${bestArm.idx}] p=${bestArm.ratio.toFixed(2)})`)
      }
    } else {
      console.log(`[cc-soul][auto-tune] bandit: not yet initialized`)
    }
    return true
  }

  if (m === '调参历史' || m === 'tune history') {
    const recent = tuneState.history.slice(-10)
    if (recent.length === 0) {
      console.log('[cc-soul][auto-tune] 无历史记录')
    } else {
      for (const h of recent) {
        const icon = h.status === 'adopted' ? '✅' : h.status === 'reverted' ? '↩️' : '⏳'
        console.log(`  ${icon} ${h.paramKey}: ${h.originalValue}→${h.testValue} (${h.status})`)
      }
    }
    return true
  }

  if (m === 'bandit status' || m === '臂机状态') {
    if (Object.keys(banditState).length === 0) {
      console.log('[cc-soul][auto-tune] bandit state empty (not yet initialized)')
      return true
    }
    for (const [key, state] of Object.entries(banditState)) {
      const arms = state.arms.map((a, i) => {
        const marker = i === state.currentArm ? '*' : ' '
        const winRate = (a.alpha / (a.alpha + a.beta)).toFixed(2)
        return `${marker}[${i}] ${a.value} α=${a.alpha} β=${a.beta} p=${winRate} n=${a.pulls}`
      }).join('  ')
      console.log(`  ${key}: ${arms}`)
    }
    return true
  }

  if (m === '参数列表' || m === 'params' || m === 'tune params') {
    const lines = Object.entries(params)
      .map(([k, v]) => {
        const def = DEFAULT_PARAMS[k]
        const changed = def !== undefined && v !== def ? ` (默认: ${def})` : ''
        return `  ${k} = ${v}${changed}`
      })
    console.log(`[cc-soul][auto-tune] 当前参数:\n${lines.join('\n')}`)
    return true
  }

  // Manual override: "调参 key=value"
  const tuneMatch = m.match(/^调参\s+([\w.]+)\s*=\s*([\d.]+)$/)
  if (tuneMatch) {
    const key = tuneMatch[1]
    const value = parseFloat(tuneMatch[2])
    if (key in params && !isNaN(value)) {
      const old = params[key]
      setParam(key, value)
      notifyOwnerDM(`🔧 手动调参: ${key} = ${old} → ${value}`).catch(() => {})
      return true
    }
  }

  // Reset: "重置参数 key"
  const resetMatch = m.match(/^重置参数\s+([\w.]+)$/)
  if (resetMatch && resetMatch[1] in DEFAULT_PARAMS) {
    resetParam(resetMatch[1])
    notifyOwnerDM(`🔄 已重置: ${resetMatch[1]} = ${DEFAULT_PARAMS[resetMatch[1]]}`).catch(() => {})
    return true
  }

  return false
}

// ══════════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════════

loadTunableParams()
