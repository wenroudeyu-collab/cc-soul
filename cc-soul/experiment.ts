import type { SoulModule } from './brain.ts'

/**
 * experiment.ts — A/B testing + gradual evolution for soul features
 *
 * A/B: try new approaches on a percentage of messages, compare metrics.
 * Evolution: phased upgrades that auto-advance based on time + metrics.
 */

import { resolve } from 'path'
import { DATA_DIR, loadJson, debouncedSave } from './persistence.ts'

const EXPERIMENTS_PATH = resolve(DATA_DIR, 'experiments.json')
const EVOLUTIONS_PATH = resolve(DATA_DIR, 'evolutions.json')

// ═══════════════════════════════════════════════════════════════════════════════
// A/B EXPERIMENT
// ═══════════════════════════════════════════════════════════════════════════════

interface Experiment {
  id: string
  name: string               // "新 recall 算法"
  description: string
  startedAt: number
  endsAt: number             // auto-end after N days
  trafficPercent: number     // 10 = 10% of messages use experiment
  controlMetrics: { quality: number; corrections: number; messages: number }
  experimentMetrics: { quality: number; corrections: number; messages: number }
  controlScores: number[]    // 每次 control 的原始分数（序贯检验用）
  experimentScores: number[] // 每次 experiment 的原始分数（序贯检验用）
  status: 'running' | 'concluded' | 'winner_experiment' | 'winner_control'
  conclusion?: string        // 结论描述（序贯检验或常规）
  config: Record<string, any>
}

let experiments: Experiment[] = loadJson(EXPERIMENTS_PATH, [])

// ═══════════════════════════════════════════════════════════════════════════════
// 序贯检验 (Sequential Testing)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 序贯检验：不等固定样本量，每次新数据到来时实时判断能否下结论
 * 基于 O'Brien-Fleming 边界的简化版
 *
 * 优势：可以更早结束实验（节省 token），也能避免过早假结论
 *
 * 每次新样本到达时：
 * 1. 计算累积 Z 统计量
 * 2. 与当前 stage 的边界比较
 * 3. 如果越界 → 下结论；否则继续
 */
interface SequentialTestResult {
  canConclude: boolean
  winner: 'experiment' | 'control' | null
  confidence: number       // [0, 1]
  samplesUsed: number
  earlyStop: boolean       // 是否提前终止（未到最大样本量）
}

/** 标准正态分布 CDF 近似 */
function normalCDF(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.3989422804014327
  const p = d * Math.exp(-x * x / 2) * (0.3193815 * t - 0.3565638 * t * t + 1.781478 * t * t * t - 1.8212560 * t * t * t * t + 1.3302744 * t * t * t * t * t)
  return x > 0 ? 1 - p : p
}

function sequentialTest(
  expScores: number[],
  ctrlScores: number[],
  maxSamples: number = 100,
  _alpha: number = 0.05,
): SequentialTestResult {
  const nExp = expScores.length
  const nCtrl = ctrlScores.length
  const n = Math.min(nExp, nCtrl)

  if (n < 5) return { canConclude: false, winner: null, confidence: 0, samplesUsed: n, earlyStop: false }

  // 计算均值和标准误
  const meanExp = expScores.reduce((s, v) => s + v, 0) / nExp
  const meanCtrl = ctrlScores.reduce((s, v) => s + v, 0) / nCtrl
  const varExp = expScores.reduce((s, v) => s + (v - meanExp) ** 2, 0) / (nExp - 1)
  const varCtrl = ctrlScores.reduce((s, v) => s + (v - meanCtrl) ** 2, 0) / (nCtrl - 1)
  const se = Math.sqrt(varExp / nExp + varCtrl / nCtrl + 1e-9)

  // Z 统计量
  const z = (meanExp - meanCtrl) / se

  // O'Brien-Fleming 边界：随样本量增加而收紧
  // 边界 = z_alpha / sqrt(t)，其中 t = 当前样本/最大样本
  const t = Math.max(0.1, n / maxSamples)
  const z_alpha = 1.96  // 对应 alpha=0.05
  const boundary = z_alpha / Math.sqrt(t)

  // 如果到了最大样本量，用固定边界
  const effectiveBoundary = n >= maxSamples ? z_alpha : boundary

  if (Math.abs(z) > effectiveBoundary) {
    return {
      canConclude: true,
      winner: z > 0 ? 'experiment' : 'control',
      confidence: 1 - 2 * normalCDF(-Math.abs(z)),
      samplesUsed: n,
      earlyStop: n < maxSamples,
    }
  }

  return { canConclude: false, winner: null, confidence: 0, samplesUsed: n, earlyStop: false }
}

export function loadExperiments() {
  experiments = loadJson(EXPERIMENTS_PATH, [])
}

/** Deterministic hash for user-level A/B assignment (consistent across messages) */
function simpleHash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

export function shouldUseExperiment(experimentId: string, userId?: string): boolean {
  const exp = experiments.find(e => e.id === experimentId && e.status === 'running')
  if (!exp) return false
  if (Date.now() > exp.endsAt) {
    concludeExperiment(exp)
    return false
  }
  // User-level hash for consistent assignment (same user always in same group)
  const key = userId || '_default'
  const hash = simpleHash(key + experimentId) % 100
  return hash < exp.trafficPercent
}

export function recordControl(experimentId: string, quality: number) {
  const exp = experiments.find(e => e.id === experimentId && e.status === 'running')
  if (!exp) return
  exp.controlMetrics.quality = (exp.controlMetrics.quality * exp.controlMetrics.messages + quality) / (exp.controlMetrics.messages + 1)
  exp.controlMetrics.messages++
  if (!exp.controlScores) exp.controlScores = []
  exp.controlScores.push(quality)
  debouncedSave(EXPERIMENTS_PATH, experiments)
}

export function recordExperiment(experimentId: string, quality: number) {
  const exp = experiments.find(e => e.id === experimentId && e.status === 'running')
  if (!exp) return
  exp.experimentMetrics.quality = (exp.experimentMetrics.quality * exp.experimentMetrics.messages + quality) / (exp.experimentMetrics.messages + 1)
  exp.experimentMetrics.messages++
  if (!exp.experimentScores) exp.experimentScores = []
  exp.experimentScores.push(quality)
  debouncedSave(EXPERIMENTS_PATH, experiments)
}

export function startExperiment(name: string, description: string, durationDays = 3, trafficPercent = 20, config: Record<string, any> = {}): string {
  const id = `exp_${Date.now()}`
  experiments.push({
    id, name, description,
    startedAt: Date.now(),
    endsAt: Date.now() + durationDays * 86400000,
    trafficPercent,
    controlMetrics: { quality: 0, corrections: 0, messages: 0 },
    experimentMetrics: { quality: 0, corrections: 0, messages: 0 },
    controlScores: [],
    experimentScores: [],
    status: 'running',
    config,
  })
  debouncedSave(EXPERIMENTS_PATH, experiments)
  console.log(`[cc-soul][experiment] started: ${name} (${trafficPercent}% traffic, ${durationDays} days)`)
  return id
}

function concludeExperiment(exp: Experiment) {
  // 序贯检验：实时判断是否可以提前下结论
  const seqResult = sequentialTest(
    exp.experimentScores || [],
    exp.controlScores || [],
    50,  // 最大样本量
  )
  if (seqResult.canConclude) {
    exp.status = seqResult.winner === 'experiment' ? 'winner_experiment' : 'winner_control'
    exp.conclusion = `序贯检验在${seqResult.samplesUsed}个样本时提前终止（置信度${(seqResult.confidence * 100).toFixed(1)}%）`
    debouncedSave(EXPERIMENTS_PATH, experiments)
    console.log(`[cc-soul][experiment] sequential test: ${exp.id} → ${exp.status} (n=${seqResult.samplesUsed}, early=${seqResult.earlyStop})`)
    return
  }

  // 常规结论逻辑（序贯检验未能下结论时 fallback）
  const minSamples = 20 // need at least 20 per group for meaningful comparison
  if (exp.experimentMetrics.messages < minSamples || exp.controlMetrics.messages < minSamples) {
    exp.status = 'concluded' // insufficient data
    console.log(`[cc-soul][experiment] ${exp.name}: insufficient data (need ${minSamples} per group, got ${exp.experimentMetrics.messages}/${exp.controlMetrics.messages})`)
  } else {
    const diff = exp.experimentMetrics.quality - exp.controlMetrics.quality
    // Medium effect size threshold (0.5) instead of 0.3 — reduces false positives
    if (diff > 0.5) {
      exp.status = 'winner_experiment'
    } else if (diff < -0.5) {
      exp.status = 'winner_control'
    } else {
      exp.status = 'concluded' // no significant difference
    }
  }
  debouncedSave(EXPERIMENTS_PATH, experiments)
  console.log(`[cc-soul][experiment] concluded: ${exp.name} -> ${exp.status} (control: ${exp.controlMetrics.quality.toFixed(1)}@${exp.controlMetrics.messages}msg, experiment: ${exp.experimentMetrics.quality.toFixed(1)}@${exp.experimentMetrics.messages}msg)`)
}

export function getExperimentSummary(): string {
  const running = experiments.filter(e => e.status === 'running')
  const recent = experiments.filter(e => e.status !== 'running').slice(-3)
  if (running.length === 0 && recent.length === 0) return ''
  const lines: string[] = []
  if (running.length > 0) {
    lines.push('进行中的实验:')
    for (const e of running) {
      lines.push(`  ${e.name}: ${e.experimentMetrics.messages} 实验 vs ${e.controlMetrics.messages} 对照`)
    }
  }
  if (recent.length > 0) {
    lines.push('最近实验结果:')
    for (const e of recent) {
      lines.push(`  ${e.name}: ${e.status} (${e.experimentMetrics.quality.toFixed(1)} vs ${e.controlMetrics.quality.toFixed(1)})`)
    }
  }
  return lines.join('\n')
}

export function checkExperiments() {
  const now = Date.now()
  for (const exp of experiments) {
    if (exp.status === 'running' && now > exp.endsAt) {
      concludeExperiment(exp)
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GRADUAL EVOLUTION (Phased Upgrades)
// ═══════════════════════════════════════════════════════════════════════════════

interface EvolutionPhase {
  phase: number
  description: string
  status: 'pending' | 'active' | 'completed' | 'failed'
  startedAt: number
  duration: number           // ms to observe before next phase
  metrics: { quality: number; corrections: number } | null
}

interface GradualEvolution {
  id: string
  goal: string               // "提升 recall 精度"
  phases: EvolutionPhase[]
  currentPhase: number
  startedAt: number
  status: 'in_progress' | 'completed' | 'abandoned'
}

let evolutions: GradualEvolution[] = loadJson(EVOLUTIONS_PATH, [])

export function loadEvolutions() {
  evolutions = loadJson(EVOLUTIONS_PATH, [])
}

export function startEvolution(goal: string, phaseDescriptions: string[], phaseDurationDays = 2): string {
  const id = `evo_${Date.now()}`
  const phases: EvolutionPhase[] = phaseDescriptions.map((desc, i) => ({
    phase: i + 1,
    description: desc,
    status: i === 0 ? 'active' : 'pending',
    startedAt: i === 0 ? Date.now() : 0,
    duration: phaseDurationDays * 86400000,
    metrics: null,
  }))
  evolutions.push({ id, goal, phases, currentPhase: 0, startedAt: Date.now(), status: 'in_progress' })
  debouncedSave(EVOLUTIONS_PATH, evolutions)
  console.log(`[cc-soul][evolution] started: ${goal} (${phases.length} phases, ${phaseDurationDays}d each)`)
  return id
}

export function checkEvolutionProgress() {
  const now = Date.now()
  for (const evo of evolutions) {
    if (evo.status !== 'in_progress') continue
    const current = evo.phases[evo.currentPhase]
    if (!current || current.status !== 'active') continue
    if (now - current.startedAt < current.duration) {
      console.log(`[cc-soul][evolution] "${evo.goal}" phase ${current.phase}/${evo.phases.length}: ${current.description} (${Math.round((now - current.startedAt) / 86400000)}d elapsed)`)
      continue
    }
    // Phase time elapsed — mark completed, advance
    current.status = 'completed'
    const next = evo.phases[evo.currentPhase + 1]
    if (next) {
      next.status = 'active'
      next.startedAt = now
      evo.currentPhase++
      console.log(`[cc-soul][evolution] "${evo.goal}" advancing to phase ${next.phase}: ${next.description}`)
    } else {
      evo.status = 'completed'
      console.log(`[cc-soul][evolution] "${evo.goal}" completed all ${evo.phases.length} phases`)
    }
    debouncedSave(EVOLUTIONS_PATH, evolutions)
  }
}

export function getEvolutionSummary(): string {
  const active = evolutions.filter(e => e.status === 'in_progress')
  if (active.length === 0) return ''
  return active.map(e => {
    const p = e.phases[e.currentPhase]
    return `进化: ${e.goal} — 阶段 ${(p?.phase ?? '?')}/${e.phases.length}: ${p?.description ?? '?'}`
  }).join('\n')
}

export const experimentModule: SoulModule = {
  id: 'experiment',
  name: '实验与进化',
  priority: 50,
  init() { loadExperiments(); loadEvolutions() },
}
