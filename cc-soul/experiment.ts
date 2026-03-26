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
  status: 'running' | 'concluded' | 'winner_experiment' | 'winner_control'
  config: Record<string, any>
}

let experiments: Experiment[] = loadJson(EXPERIMENTS_PATH, [])

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
  debouncedSave(EXPERIMENTS_PATH, experiments)
}

export function recordExperiment(experimentId: string, quality: number) {
  const exp = experiments.find(e => e.id === experimentId && e.status === 'running')
  if (!exp) return
  exp.experimentMetrics.quality = (exp.experimentMetrics.quality * exp.experimentMetrics.messages + quality) / (exp.experimentMetrics.messages + 1)
  exp.experimentMetrics.messages++
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
    status: 'running',
    config,
  })
  debouncedSave(EXPERIMENTS_PATH, experiments)
  console.log(`[cc-soul][experiment] started: ${name} (${trafficPercent}% traffic, ${durationDays} days)`)
  return id
}

function concludeExperiment(exp: Experiment) {
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
