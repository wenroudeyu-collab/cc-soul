import type { SoulModule } from './brain.ts'

/**
 * evolution.ts — Rules + Hypotheses + Advanced Evolution
 *
 * Ported from handler.ts lines 1023-1099 (rules) + 1384-1480 (hypotheses/advanced).
 */

import { createHash } from 'crypto'
import type { Rule, Hypothesis } from './types.ts'
import { resolve } from 'path'
import { RULES_PATH, HYPOTHESES_PATH, DATA_DIR, loadJson, debouncedSave } from './persistence.ts'
import { addMemory, memoryState, trigrams, trigramSimilarity } from './memory.ts'
import { notifySoulActivity } from './notify.ts'
import { spawnCLI } from './cli.ts'
import { extractJSON } from './utils.ts'
import { getParam } from './auto-tune.ts'
import { appendAudit } from './audit.ts'

// ── Bayesian utilities ──

/** Beta distribution posterior mean */
function betaMean(alpha: number, beta: number): number {
  return alpha / (alpha + beta)
}

/** Wilson score lower bound — 95% CI lower bound without scipy */
function betaLowerBound(alpha: number, beta: number, z = 1.96): number {
  const n = alpha + beta - 2
  if (n <= 0) return 0
  const p = (alpha - 1) / n
  return (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) /
         (1 + z * z / n)
}

/** Enough data for statistical significance? */
function isSignificant(alpha: number, beta: number, minSamples = 8): boolean {
  return (alpha + beta - 2) >= minSamples
}

// ── State ──

const MAX_RULES = 50

export let rules: Rule[] = []
export let hypotheses: Hypothesis[] = []

function md5(s: string): string {
  return createHash('md5').update(s).digest('hex').slice(0, 16)
}

// ── Rules ──

export function loadRules() {
  rules = loadJson<Rule[]>(RULES_PATH, [])
}

function saveRules() {
  debouncedSave(RULES_PATH, rules)
}

// Rule dedup threshold now tunable via auto-tune

/** Compress rules by merging similar pairs (trigram similarity > 0.6) */
function compressRules() {
  const MERGE_THRESHOLD = 0.6
  const merged = new Set<number>()

  for (let i = 0; i < rules.length; i++) {
    if (merged.has(i)) continue
    const triA = trigrams(rules[i].rule)
    for (let j = i + 1; j < rules.length; j++) {
      if (merged.has(j)) continue
      const triB = trigrams(rules[j].rule)
      if (trigramSimilarity(triA, triB) > MERGE_THRESHOLD) {
        // Keep the one with higher hitCount, absorb the other
        const [keep, drop] = rules[i].hits >= rules[j].hits ? [i, j] : [j, i]
        rules[keep].hits += rules[drop].hits
        rules[keep].rule = rules[keep].rule.length >= rules[drop].rule.length
          ? rules[keep].rule
          : rules[drop].rule  // keep the more detailed version
        merged.add(drop)
        console.log(`[cc-soul][evolve] rule compress: merged "${rules[drop].rule.slice(0, 30)}" into "${rules[keep].rule.slice(0, 30)}"`)
        if (drop === i) break
      }
    }
  }

  if (merged.size > 0) {
    const before = rules.length
    // Filter in-place
    const kept = rules.filter((_, idx) => !merged.has(idx))
    rules.length = 0
    rules.push(...kept)
    console.log(`[cc-soul][evolve] rule compress: ${before} → ${rules.length} (merged ${merged.size})`)
  }
}

export function addRule(rule: string, source: string) {
  if (!rule || rule.length < 5) return
  // Exact dedup
  if (rules.some(r => r.rule === rule)) return

  // Semantic dedup: trigram similarity check against existing rules
  const newTrigrams = trigrams(rule)
  const similar = rules.find(r => trigramSimilarity(trigrams(r.rule), newTrigrams) > getParam('evolution.rule_dedup_threshold'))
  if (similar) {
    // Merge: keep the existing rule but bump its hits and update source
    similar.hits++
    console.log(`[cc-soul][evolve] rule dedup: "${rule.slice(0, 40)}" merged into "${similar.rule.slice(0, 40)}"`)
    saveRules()
    return
  }

  rules.push({ rule, source: source.slice(0, 100), ts: Date.now(), hits: 0 })
  appendAudit('rule_add', `${rule.slice(0, 100)} (src: ${source.slice(0, 50)})`)

  // Compress: when rules exceed 40, merge similar pairs via trigram similarity
  if (rules.length > 40) {
    compressRules()
  }

  if (rules.length > MAX_RULES) {
    // Remove least hit oldest rules (in-place to preserve export let reference)
    rules.sort((a, b) => (b.hits * 10 + b.ts / 1e10) - (a.hits * 10 + a.ts / 1e10) || b.ts - a.ts)
    rules.length = MAX_RULES
  }
  saveRules()
}

export function getRelevantRules(msg: string, topN = 3, trackHits = true): Rule[] {
  if (rules.length === 0) return []

  const msgWords = new Set((msg.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase()))
  if (msgWords.size === 0) return rules.slice(0, topN) // return most recent if can't match

  const scored = rules.map(r => {
    const ruleWords = (r.rule.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase())
    const overlap = ruleWords.filter(w => msgWords.has(w)).length
    return { ...r, score: overlap + r.hits * 0.1 }
  })

  scored.sort((a, b) => b.score - a.score)
  const relevant = scored.filter(r => r.score > 0).slice(0, topN)

  // Increment hits + matchedCount (skip when called from prompt-builder to avoid double counting)
  if (trackHits) {
    for (const r of relevant) {
      const orig = rules.find(o => o.rule === r.rule)
      if (orig) {
        orig.hits++
        orig.matchedCount = (orig.matchedCount || 0) + 1
      }
    }
  }

  return relevant
}

// ── Hypotheses ──

export function loadHypotheses() {
  hypotheses = loadJson<Hypothesis[]>(HYPOTHESES_PATH, [])
  // Migration: convert old counter format to Bayesian
  for (const h of hypotheses) {
    if (h.alpha === undefined || h.beta === undefined) {
      h.alpha = 1 + (h.evidence_for || 0)
      h.beta = 1 + (h.evidence_against || 0)
    }
  }
}

export function formHypothesis(pattern: string, observation: string) {
  const id = md5(pattern)
  if (hypotheses.some(h => h.id === id)) return

  hypotheses.push({
    id,
    description: `当遇到"${pattern.slice(0, 30)}"时: ${observation.slice(0, 60)}`,
    alpha: 2,   // prior Beta(1,1) + 1 initial success observation
    beta: 1,
    status: 'active',
    created: Date.now(),
    reflexionStage: 'plan',  // #19: starts at plan stage (reflect already happened)
    verifyCount: 0,
  })

  // 限制数量 (in-place to preserve export let reference)
  if (hypotheses.length > 30) {
    const kept = hypotheses
      .filter(h => h.status !== 'rejected')
      .sort((a, b) => betaMean(b.alpha, b.beta) - betaMean(a.alpha, a.beta) || b.created - a.created)
      .slice(0, 25)
    hypotheses.length = 0
    hypotheses.push(...kept)
  }

  debouncedSave(HYPOTHESES_PATH, hypotheses)
  console.log(`[cc-soul][evolve] 新假设: ${pattern.slice(0, 30)} → ${observation.slice(0, 40)}`)
  notifySoulActivity(`🧬 新假设: ${pattern.slice(0, 30)} → ${observation.slice(0, 40)}`).catch(() => {})
}

// ── #19: Five-stage reflexion loop ──
// Stages: reflect → plan → execute → verify → solidify
// reflexionStage tracks each hypothesis through the pipeline

export function verifyHypothesis(situation: string, wasCorrect: boolean) {
  for (const h of hypotheses) {
    if (h.status === 'rejected') continue

    // Use trigram similarity instead of keyword count — more reliable matching
    const sim = trigramSimilarity(trigrams(h.description), trigrams(situation))
    if (sim < getParam('evolution.hypothesis_match_min_sim')) continue // need minimum similarity

    // Initialize reflexion stage tracking if missing
    if (!h.reflexionStage) h.reflexionStage = 'plan'  // #9: should start at plan, not skip to verify
    if (!h.verifyCount) h.verifyCount = 0

    // Stage transition: execute → verify (first time matched in a real scenario)
    if (h.reflexionStage === 'execute') {
      h.reflexionStage = 'verify'
      console.log(`[cc-soul][evolve] stage execute → verify: ${h.description.slice(0, 40)}`)
    }

    // Bayesian update: Beta distribution α/β
    if (wasCorrect) {
      h.alpha++
    } else {
      h.beta++
    }
    // Legacy counters kept in sync for compatibility
    if (wasCorrect) {
      h.evidence_for = (h.evidence_for || 0) + 1
    } else {
      h.evidence_against = (h.evidence_against || 0) + 1
    }

    const mean = betaMean(h.alpha, h.beta)
    const lb = betaLowerBound(h.alpha, h.beta)
    const n = h.alpha + h.beta - 2
    console.log(`[cc-soul][evolve] 假设更新: "${h.description.slice(0, 40)}" α=${h.alpha} β=${h.beta} mean=${mean.toFixed(3)} CI_lb=${lb.toFixed(3)} n=${n} stage=${h.reflexionStage}`)

    // Stage: verify — count consecutive successes in similar scenarios
    if (wasCorrect && h.reflexionStage === 'verify') {
      h.verifyCount = (h.verifyCount || 0) + 1
      console.log(`[cc-soul][evolve] 验证计数: ${h.verifyCount}/3 for "${h.description.slice(0, 30)}"`)
    } else if (!wasCorrect && h.reflexionStage === 'verify') {
      h.verifyCount = 0 // reset on failure
    }

    // Stage: solidify — 3+ consecutive verifications promote to permanent rule
    if (h.reflexionStage === 'verify' && (h.verifyCount || 0) >= 3 && h.status === 'active') {
      h.status = 'verified'
      h.reflexionStage = 'solidified'
      addRule(h.description, 'reflexion_solidified')
      appendAudit('rule_solidified', h.description.slice(0, 150))
      console.log(`[cc-soul][evolve] 五阶段固化 → 永久规则: ${h.description.slice(0, 40)} (verified ${h.verifyCount}x)`)
      notifySoulActivity(`🔒 反思固化: ${h.description.slice(0, 40)} (验证${h.verifyCount}次)`).catch(() => {})
      continue
    }

    // Promote to rule when statistically significant and lower bound of success rate > 0.6
    if (h.status === 'active' && isSignificant(h.alpha, h.beta) && betaLowerBound(h.alpha, h.beta) > getParam('evolution.hypothesis_verify_ci_lb')) {
      h.status = 'verified'
      h.reflexionStage = 'solidified'
      addRule(h.description, 'hypothesis_verified')
      console.log(`[cc-soul][evolve] 假设验证通过 → 规则: ${h.description.slice(0, 40)} (mean=${mean.toFixed(3)}, CI_lb=${lb.toFixed(3)})`)
      notifySoulActivity(`✅ 假设验证: ${h.description.slice(0, 40)}`).catch(() => {})
    }

    // Reject when statistically significant and upper bound of success rate < 0.4
    // Upper bound of success = 1 - lower bound of failure rate (swap α/β)
    if (h.status === 'active' && isSignificant(h.alpha, h.beta) && (1 - betaLowerBound(h.beta, h.alpha)) < getParam('evolution.hypothesis_reject_ci_ub')) {
      h.status = 'rejected'
      console.log(`[cc-soul][evolve] 假设被否定: ${h.description.slice(0, 40)} (mean=${mean.toFixed(3)})`)
      notifySoulActivity(`❌ 假设否定: ${h.description.slice(0, 40)}`).catch(() => {})
    }
  }
  debouncedSave(HYPOTHESES_PATH, hypotheses)
}

// ── Correction Evolution (basic pattern extraction) ──

function onCorrectionEvolution(userMsg: string) {
  const patterns = [
    /不要(.{2,30})/,
    /别(.{2,20})/,
    /应该(.{2,30})/,
    /正确的是(.{2,30})/,
  ]
  for (const p of patterns) {
    const m = userMsg.match(p)
    if (m) {
      addRule(m[0], userMsg.slice(0, 80))
      break
    }
  }
  addMemory(`纠正: ${userMsg.slice(0, 60)}`, 'correction')
}

// ── Advanced Correction (causal attribution + hypothesis) ──

export function onCorrectionAdvanced(userMsg: string, lastResponse: string) {
  // 基础规则提取
  onCorrectionEvolution(userMsg)

  // 因果归因
  const causalPatterns: { pattern: RegExp; cause: string }[] = [
    { pattern: /太长|太啰嗦|简洁/, cause: '回答太冗长，用户要简洁' },
    { pattern: /跑偏|离题|不是问/, cause: '理解偏了，没回答到点上' },
    { pattern: /不准|不对|错误/, cause: '信息不准确' },
    { pattern: /口气|语气|态度/, cause: '语气不对' },
    { pattern: /太简单|没深度|浅/, cause: '回答太浅' },
  ]

  for (const { pattern, cause } of causalPatterns) {
    if (pattern.test(userMsg)) {
      formHypothesis(userMsg.slice(0, 50), cause)
      break
    }
  }

  // 验证之前的假设：这次被纠正了 = 假设对应的策略失败
  verifyHypothesis(lastResponse, false)
}

// ── Correction Attribution (纠正归因 — LLM 判断出错根因) ──

export function attributeCorrection(userMsg: string, lastResponse: string, augmentsUsed: string[]) {
  spawnCLI(
    `上一次回复: "${lastResponse.slice(0, 300)}"\n` +
    `注入的上下文: ${augmentsUsed.slice(0, 3).join('; ').slice(0, 200)}\n` +
    `用户纠正: "${userMsg.slice(0, 200)}"\n\n` +
    `判断回复出错的原因（只选一个）:\n` +
    `1=模型幻觉 2=记忆误导 3=规则冲突 4=理解偏差 5=领域不足\n` +
    `格式: {"cause":N,"detail":"一句话"}`,
    (output) => {
      try {
        const result = extractJSON(output)
        if (result) {
          const causeNames = ['', '模型幻觉', '记忆误导', '规则冲突', '理解偏差', '领域不足']
          const causeName = causeNames[result.cause] || '未知'
          console.log(`[cc-soul][attribution] cause=${causeName}: ${result.detail}`)
          addMemory(`[纠正归因] ${causeName}: ${result.detail}`, 'correction')
        }
      } catch (e: any) { console.error(`[cc-soul][attribution] parse error: ${e.message}`) }
    }
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY REPLAY — record why we chose each response strategy
// ═══════════════════════════════════════════════════════════════════════════════

const STRATEGY_TRACES_PATH = resolve(DATA_DIR, 'strategy_traces.json')
const MAX_TRACES = 200

interface StrategyTrace {
  timestamp: number
  scenario: string       // user's message (truncated)
  candidates: string[]   // strategies considered
  chosen: string         // which one was picked
  reason: string         // why (attention type, user style, etc.)
  outcome: 'success' | 'corrected' | 'unknown'
  reasoningChain: string[]  // ["注意力: correction", "策略: empathy_first", "消息长度: 42"]
  dataUsed: string[]        // ["记忆: xxx", "规则: yyy", "epistemic: zzz"]
}

let strategyTraces: StrategyTrace[] = []

export function loadStrategyTraces() {
  strategyTraces = loadJson<StrategyTrace[]>(STRATEGY_TRACES_PATH, [])
}

function saveTraces() {
  debouncedSave(STRATEGY_TRACES_PATH, strategyTraces)
}

/**
 * Record a strategy decision with full reasoning context.
 */
export function recordStrategy(scenario: string, chosen: string, reason: string, augmentsUsed?: string[]) {
  strategyTraces.push({
    timestamp: Date.now(),
    scenario: scenario.slice(0, 100),
    candidates: ['direct', 'empathy_first', 'detailed', 'action_oriented', 'opinion_with_reasoning'],
    chosen,
    reason,
    outcome: 'unknown',
    reasoningChain: [
      `注意力: ${reason}`,
      `策略: ${chosen}`,
      `消息长度: ${scenario.length}`,
    ],
    dataUsed: (augmentsUsed || []).slice(0, 5).map(a => a.slice(0, 60)),
  })
  if (strategyTraces.length > MAX_TRACES) {
    const kept = strategyTraces.slice(-Math.floor(MAX_TRACES * 0.8))
    strategyTraces.length = 0
    strategyTraces.push(...kept)
  }
  saveTraces()
}

/**
 * Mark the last strategy's outcome (called on correction or positive feedback).
 */
export function markLastStrategyOutcome(outcome: 'success' | 'corrected') {
  if (strategyTraces.length === 0) return
  strategyTraces[strategyTraces.length - 1].outcome = outcome
  saveTraces()
}

/**
 * Find similar past strategies for current scenario.
 */
export function recallStrategy(msg: string): string {
  if (strategyTraces.length < 5) return ''
  const words = new Set((msg.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase()))

  const matches = strategyTraces
    .filter(t => t.outcome === 'success')
    .filter(t => {
      const tWords = (t.scenario.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase())
      return tWords.filter(w => words.has(w)).length >= 2
    })
    .slice(-3)

  if (matches.length === 0) return ''
  const strategies = matches.map(m => m.chosen)
  const most = strategies.sort((a, b) => strategies.filter(s => s === b).length - strategies.filter(s => s === a).length)[0]
  // Find the best match with reasoning chain for richer context
  const bestMatch = matches.find(m => m.chosen === most) || matches[0]
  const chainStr = bestMatch.reasoningChain && bestMatch.reasoningChain.length > 0
    ? `，因为：${bestMatch.reasoningChain.join(' → ')}`
    : ''
  const dataStr = bestMatch.dataUsed && bestMatch.dataUsed.length > 0
    ? `，参考了：${bestMatch.dataUsed.join('；')}`
    : ''
  const outcomeStr = bestMatch.outcome !== 'unknown' ? `，效果：${bestMatch.outcome}` : ''
  return `[Strategy hint] 上次类似场景用了 ${most} 策略${chainStr}${dataStr}${outcomeStr}`
}

export { strategyTraces }

// ═══════════════════════════════════════════════════════════════════════════════
// META-LEARNING — insights about the learning process itself
// ═══════════════════════════════════════════════════════════════════════════════

const META_INSIGHTS_PATH = resolve(DATA_DIR, 'meta_insights.json')

interface MetaInsight {
  insight: string
  evidence: number
  discoveredAt: number
}

let metaInsights: MetaInsight[] = []

export function loadMetaInsights() {
  metaInsights = loadJson<MetaInsight[]>(META_INSIGHTS_PATH, [])
}

function saveMetaInsights() {
  debouncedSave(META_INSIGHTS_PATH, metaInsights)
}

/**
 * Periodic meta-analysis: analyze the learning system itself.
 * Called from heartbeat (daily cooldown).
 */
let lastMetaAnalysis = 0
export function analyzeMetaLearning() {
  const now = Date.now()
  if (now - lastMetaAnalysis < 24 * 3600000) return // daily
  if (rules.length < 10) return // need enough rules
  lastMetaAnalysis = now

  const insights: string[] = []

  // Insight: rule survival rate
  const oldRules = rules.filter(r => now - r.ts > 7 * 86400000) // >7 days old
  const highHitRules = oldRules.filter(r => r.hits > 5)
  if (oldRules.length > 5) {
    const survivalRate = (highHitRules.length / oldRules.length * 100).toFixed(0)
    insights.push(`${survivalRate}% of rules older than 7 days are actively used (hits>5)`)
  }

  // Insight: correction time pattern
  const correctionMems = memoryState.memories.filter(m => m.scope === 'correction')
  if (correctionMems.length > 10) {
    const nightCorrections = correctionMems.filter(m => {
      const h = new Date(m.ts).getHours()
      return h >= 23 || h < 6
    })
    const nightRatio = nightCorrections.length / correctionMems.length
    if (nightRatio > 0.4) {
      insights.push('Late-night corrections are disproportionately high — consider being more cautious after 11pm')
    }
  }

  // Insight: hypothesis verification speed
  const verifiedHyp = hypotheses.filter(h => h.status === 'verified')
  const rejectedHyp = hypotheses.filter(h => h.status === 'rejected')
  if (verifiedHyp.length + rejectedHyp.length > 5) {
    const verifyRate = (verifiedHyp.length / (verifiedHyp.length + rejectedHyp.length) * 100).toFixed(0)
    insights.push(`Hypothesis verification rate: ${verifyRate}% (${verifiedHyp.length} verified, ${rejectedHyp.length} rejected)`)
  }

  // Store new insights (dedup)
  for (const ins of insights) {
    if (!metaInsights.some(m => m.insight === ins)) {
      metaInsights.push({ insight: ins, evidence: 1, discoveredAt: now })
    }
  }
  if (metaInsights.length > 20) {
    const kept = metaInsights.slice(-15)
    metaInsights.length = 0
    metaInsights.push(...kept)
  }
  saveMetaInsights()

  if (insights.length > 0) {
    console.log(`[cc-soul][meta] ${insights.length} meta-insights: ${insights[0].slice(0, 60)}`)
  }
}

/**
 * Get meta-learning context for structured reflection.
 */
export function getMetaContext(): string {
  if (metaInsights.length === 0) return ''
  return metaInsights.slice(-3).map(m => `[Meta] ${m.insight}`).join('\n')
}

export { metaInsights }

// ═══════════════════════════════════════════════════════════════════════════════
// REFLEXION TRACKING — monitor if reflexion-generated rules actually help
// ═══════════════════════════════════════════════════════════════════════════════

const REFLEXION_TRACKER_PATH = resolve(DATA_DIR, 'reflexion_tracker.json')

interface ReflexionEntry {
  rule: string
  createdAt: number
  correctionsBefore: number   // correction count at creation time
  correctionsAfter: number    // correction count checked later
  messagesAtCreation: number  // total messages at creation
  messagesChecked: number     // total messages at check time
  verdict: 'pending' | 'effective' | 'ineffective' | 'inconclusive'
}

let reflexionTracker: ReflexionEntry[] = []

export function loadReflexionTracker() {
  reflexionTracker = loadJson<ReflexionEntry[]>(REFLEXION_TRACKER_PATH, [])
}

function saveReflexionTracker() {
  debouncedSave(REFLEXION_TRACKER_PATH, reflexionTracker)
}

/**
 * Register a new reflexion-generated rule for tracking.
 * Called from triggerReflexion when a new rule is created.
 */
export function trackReflexionRule(rule: string, currentCorrections: number, currentMessages: number) {
  // Dedup
  if (reflexionTracker.some(e => e.rule === rule)) return
  reflexionTracker.push({
    rule,
    createdAt: Date.now(),
    correctionsBefore: currentCorrections,
    correctionsAfter: 0,
    messagesAtCreation: currentMessages,
    messagesChecked: 0,
    verdict: 'pending',
  })
  // Cap at 50 entries (in-place to preserve export let reference)
  if (reflexionTracker.length > 50) {
    const kept = reflexionTracker.slice(-40)
    reflexionTracker.length = 0
    reflexionTracker.push(...kept)
  }
  saveReflexionTracker()
  console.log(`[cc-soul][reflexion-track] tracking rule: ${rule.slice(0, 50)}`)
}

/**
 * Record quality score for rules that were matched in the current response.
 * Called from handler.ts after scoreResponse, with the rules that were injected.
 */
export function recordRuleQuality(matchedRules: Rule[], qualityScore: number) {
  for (const r of matchedRules) {
    const orig = rules.find(o => o.rule === r.rule)
    if (orig) {
      orig.matchedQualitySum = (orig.matchedQualitySum || 0) + qualityScore
    }
  }
  saveRules()
}

/**
 * Evaluate reflexion rules using per-rule metrics (called from heartbeat, 24h cooldown).
 * Uses matchedCount + matchedQualitySum instead of global correction rate (avoids Simpson's paradox).
 */
let lastReflexionEval = 0

export function evaluateReflexionRules(totalCorrections: number, totalMessages: number) {
  if (Date.now() - lastReflexionEval < 24 * 3600000) return
  lastReflexionEval = Date.now()

  let evaluated = 0
  for (const entry of reflexionTracker) {
    if (entry.verdict !== 'pending') continue
    // Need at least 7 days since creation
    const daysSince = (Date.now() - entry.createdAt) / 86400000
    if (daysSince < 7) continue

    // Find the corresponding rule and use per-rule metrics
    const ruleObj = rules.find(r => r.rule === entry.rule)
    const matched = ruleObj?.matchedCount || 0
    const avgQuality = matched > 0 ? (ruleObj?.matchedQualitySum || 0) / matched : 0

    entry.correctionsAfter = totalCorrections
    entry.messagesChecked = totalMessages

    if (matched < 10) continue // not enough data for this specific rule

    if (avgQuality < 4) {
      entry.verdict = 'ineffective'
      // Demote the rule — reduce its hits so it's more likely to be evicted
      if (ruleObj) ruleObj.hits = Math.max(0, ruleObj.hits - 3)
      console.log(`[cc-soul][reflexion-track] ❌ rule ineffective: ${entry.rule.slice(0, 40)} (matched ${matched}x, avgQ=${avgQuality.toFixed(1)})`)
    } else if (avgQuality >= 7) {
      entry.verdict = 'effective'
      console.log(`[cc-soul][reflexion-track] ✅ rule effective: ${entry.rule.slice(0, 40)} (matched ${matched}x, avgQ=${avgQuality.toFixed(1)})`)
    } else {
      entry.verdict = 'inconclusive'
    }
    evaluated++
  }

  if (evaluated > 0) {
    saveReflexionTracker()
    saveRules()
  }
}

/**
 * Get reflexion tracking summary for meta-learning context.
 */
export function getReflexionSummary(): string {
  const effective = reflexionTracker.filter(e => e.verdict === 'effective').length
  const ineffective = reflexionTracker.filter(e => e.verdict === 'ineffective').length
  const pending = reflexionTracker.filter(e => e.verdict === 'pending').length
  if (effective + ineffective === 0) return ''
  return `[反思规则追踪] 有效:${effective} 无效:${ineffective} 待评:${pending}`
}

// ═══════════════════════════════════════════════════════════════════════════════
// REFLEXION — structured failure analysis → actionable memory
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * When cc gives a low-quality response or gets corrected, generate a structured
 * reflection that becomes an actionable rule + memory for next time.
 */
export function triggerReflexion(question: string, response: string, score: number, correctionMsg?: string, stats?: { corrections: number; totalMessages: number }) {
  // Only trigger on low scores or corrections
  if (score > 5 && !correctionMsg) return

  const prompt = [
    `你的上一次回复质量不高。请反思：`,
    ``,
    `用户问题: "${question.slice(0, 150)}"`,
    `你的回复: "${response.slice(0, 300)}"`,
    `质量评分: ${score}/10`,
    correctionMsg ? `用户纠正: "${correctionMsg.slice(0, 150)}"` : '',
    ``,
    `请分析：`,
    `1. 具体哪里做得不好？`,
    `2. 正确的做法应该是什么？`,
    `3. 下次遇到类似问题应该怎么做？（写成一条可执行的规则）`,
    ``,
    `格式: {"what_went_wrong":"一句话","correct_approach":"一句话","rule":"下次遇到X时，应该Y"}`,
  ].filter(Boolean).join('\n')

  spawnCLI(prompt, (output) => {
    try {
      const result = extractJSON(output)
      if (result && result.rule) {
        // Store reflexion as high-priority memory
        addMemory(
          `[反思规则] ${result.rule}`,
          'reflexion',
          undefined, 'global'
        )

        // Also add as evolution rule for immediate effect
        addRule(result.rule, `reflexion: score=${score}`)

        // #19: Mark related hypotheses as "execute" stage
        for (const h of hypotheses) {
          if (h.reflexionStage === 'plan' && h.status === 'active') {
            const sim = trigramSimilarity(trigrams(h.description), trigrams(result.rule))
            if (sim > getParam('evolution.reflexion_sim_threshold')) {
              h.reflexionStage = 'execute'
              console.log(`[cc-soul][reflexion] stage → execute: ${h.description.slice(0, 40)}`)
            }
          }
        }

        // Track effectiveness of this reflexion rule
        if (stats) {
          trackReflexionRule(result.rule, stats.corrections, stats.totalMessages)
        }

        console.log(`[cc-soul][reflexion] learned: ${result.rule.slice(0, 60)}`)
      }
    } catch (e: any) {
      console.error(`[cc-soul][reflexion] parse error: ${e.message}`)
    }
  }, 30000, 'reflexion')
}

export const evolutionModule: SoulModule = {
  id: 'evolution',
  name: '进化引擎',
  dependencies: ['memory'],
  priority: 50,
  init() { loadRules(); loadHypotheses(); loadStrategyTraces(); loadMetaInsights(); loadReflexionTracker() },
}
