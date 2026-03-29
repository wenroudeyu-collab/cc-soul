import type { SoulModule } from './brain.ts'

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

/** Weibull shape parameter */
const WEIBULL_K = 1.5

/** Weibull scale (lambda) in days, by scope */
const WEIBULL_LAMBDA: Record<string, number> = {
  fact: 30,
  preference: 90,
  correction: Infinity,   // corrections never decay via Weibull
  episode: 14,
  emotion: 7,
}
const WEIBULL_LAMBDA_DEFAULT = 30

/** ACT-R decay exponent */
const ACT_R_DECAY = 0.5

/** Forget thresholds */
const SURVIVAL_FORGET_THRESHOLD = 0.1
const ACTIVATION_FORGET_THRESHOLD = -1.0

/** Consolidation thresholds */
const SURVIVAL_CONSOLIDATE_THRESHOLD = 0.8
const ACTIVATION_CONSOLIDATE_THRESHOLD = 2.0

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
function weibullSurvival(ageDays: number, lambda: number, k: number): number {
  if (!isFinite(lambda)) return 1.0  // e.g. correction scope → never decays
  if (ageDays <= 0) return 1.0
  if (lambda <= 0) return 0.0
  return Math.exp(-Math.pow(ageDays / lambda, k))
}

/**
 * Get Weibull lambda for a given scope, adjusted by recall count.
 * More recalls → longer effective half-life (up to 3x).
 */
function effectiveLambda(scope: string, recallCount: number): number {
  const baseLambda = WEIBULL_LAMBDA[scope] ?? WEIBULL_LAMBDA_DEFAULT
  if (!isFinite(baseLambda)) return Infinity
  // Each recall extends lambda by ~15%, capped at 3x
  const multiplier = Math.min(1 + recallCount * 0.15, 3.0)
  return baseLambda * multiplier
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
    sum = Math.pow(lastAgo, -ACT_R_DECAY)
  } else {
    // Distribute accesses evenly from creation to lastAccessed
    for (let i = 0; i < n; i++) {
      const fraction = n === 1 ? 1 : i / (n - 1)
      const accessAgo = createdAgo - fraction * (createdAgo - lastAgo)
      const t = Math.max(accessAgo, 1)
      sum += Math.pow(t, -ACT_R_DECAY)
    }
  }

  return sum > 0 ? Math.log(sum) : -Infinity
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute a composite forget score for a single memory.
 *
 * @returns 0-1 probability of forgetting (1 = definitely forget)
 */
export function computeForgetScore(mem: MemoryInput): number {
  const now = Date.now()
  const ageDays = (now - mem.ts) / MS_PER_DAY

  // Weibull survival
  const lambda = effectiveLambda(mem.scope, mem.recallCount)
  const survival = weibullSurvival(ageDays, lambda, WEIBULL_K)

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
    const lambda = effectiveLambda(mem.scope, mem.recallCount)
    const survival = weibullSurvival(ageDays, lambda, WEIBULL_K)
    const activation = actRActivation(mem, now)

    // Forget: low survival AND low activation
    if (survival < SURVIVAL_FORGET_THRESHOLD && activation < ACTIVATION_FORGET_THRESHOLD) {
      toForget.push(i)
      continue
    }

    // Consolidate: high survival AND high activation (memory is strong)
    if (survival > SURVIVAL_CONSOLIDATE_THRESHOLD && activation > ACTIVATION_CONSOLIDATE_THRESHOLD) {
      toConsolidate.push(i)
    }
  }

  return { toForget, toConsolidate }
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

  init(): void {
    console.log('[smart-forget] initialized — Weibull k=1.5, ACT-R d=0.5')
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
      const MAX_FORGET_PER_SWEEP = 20
      const toForget = result.toForget.slice(0, MAX_FORGET_PER_SWEEP)
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
