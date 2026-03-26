/**
 * upgrade-experience.ts — Upgrade experience memory + curiosity-driven improvement
 *
 * Feature 1: Remembers past upgrade outcomes (success/rollback/fail) with lessons learned.
 *            Injects experience context into upgrade prompts so the Claude engineer
 *            avoids repeating mistakes and builds on what worked.
 *
 * Feature 2: Generates "curiosity proposals" when diagnostics find no critical issues
 *            but data suggests room for improvement. Enables proactive self-improvement
 *            even when nothing is broken.
 */

import type { SoulModule } from './brain.ts'
import type { UpgradeExperience, InteractionStats, EvalMetrics } from './types.ts'
import { loadJson, saveJson, UPGRADE_EXPERIENCES_PATH, FEEDBACK_STATE_PATH } from './persistence.ts'
import { computeEval } from './quality.ts'
import { memoryState } from './memory.ts'
import { spawnCLI } from './cli.ts'
import { extractJSON } from './utils.ts'

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

export let upgradeExperiences: UpgradeExperience[] = loadJson(UPGRADE_EXPERIENCES_PATH, [])

// Feedback state: tracks when we last asked for user feedback
export const feedbackState: { lastFeedbackAsk: number } = loadJson(FEEDBACK_STATE_PATH, { lastFeedbackAsk: 0 })

const MAX_EXPERIENCES = 50

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 1: UPGRADE EXPERIENCE MEMORY
// ═══════════════════════════════════════════════════════════════════════════════

/** Record an upgrade outcome with metrics impact and lesson learned */
export function recordExperience(
  description: string,
  targetModule: string,
  outcome: UpgradeExperience['outcome'],
  preEval: EvalMetrics | null,
  postEval: EvalMetrics,
) {
  // Compute metrics delta
  const qualityDelta = preEval
    ? (postEval.avgQuality - preEval.avgQuality).toFixed(1)
    : '?'
  const correctionDelta = preEval
    ? (postEval.correctionRate - preEval.correctionRate).toFixed(1)
    : '?'
  const metricsImpact = outcome === 'success'
    ? `quality ${Number(qualityDelta) >= 0 ? '+' : ''}${qualityDelta}, correction rate ${Number(correctionDelta) >= 0 ? '+' : ''}${correctionDelta}%`
    : `quality ${Number(qualityDelta) >= 0 ? '+' : ''}${qualityDelta}, correction rate ${Number(correctionDelta) >= 0 ? '+' : ''}${correctionDelta}% → ${outcome}`

  const experienceId = `${new Date().toISOString().slice(0, 10)}_${Date.now()}`
  const experience: UpgradeExperience = {
    id: experienceId,
    date: new Date().toISOString().slice(0, 10),
    description: description.slice(0, 200),
    targetModule,
    outcome,
    metricsImpact,
    lesson: '', // filled async by CLI
  }

  upgradeExperiences.push(experience)
  if (upgradeExperiences.length > MAX_EXPERIENCES) {
    upgradeExperiences = upgradeExperiences.slice(-MAX_EXPERIENCES)
  }
  saveJson(UPGRADE_EXPERIENCES_PATH, upgradeExperiences)

  // Generate lesson asynchronously via CLI (uses stable ID, not array index)
  generateLesson(experience, experienceId)
}

/** Ask CLI to distill a one-line lesson from the upgrade outcome */
function generateLesson(exp: UpgradeExperience, experienceId: string) {
  const prompt = `一次代码升级的结果：
描述：${exp.description}
目标模块：${exp.targetModule}
结果：${exp.outcome}
指标影响：${exp.metricsImpact}

用一句话总结经验教训（中文，15字以内）。例如："改独立模块比改 handler.ts 安全"
格式：{"lesson":"..."}`

  spawnCLI(prompt, (output) => {
    try {
      const result = extractJSON(output)
      if (result?.lesson) {
        // Find by stable ID instead of array index (index may shift if array is modified)
        const target = upgradeExperiences.find(e => e.id === experienceId)
        if (target) {
          target.lesson = result.lesson.slice(0, 50)
          saveJson(UPGRADE_EXPERIENCES_PATH, upgradeExperiences)
        }
      }
    } catch { /* best effort */ }
  }, 30000)
}

/** Format past experiences for injection into upgrade prompts */
export function getExperienceContext(): string {
  if (upgradeExperiences.length === 0) return ''

  const recent = upgradeExperiences.slice(-10)
  const lines = recent.map(exp => {
    const icon = exp.outcome === 'success' ? '✅' : exp.outcome === 'rolled_back' ? '⚠️' : '❌'
    const lesson = exp.lesson ? ` → 教训：${exp.lesson}` : ''
    return `- ${exp.date}: ${icon} 改 ${exp.targetModule} — ${exp.description.slice(0, 60)} (${exp.metricsImpact})${lesson}`
  })

  const successRate = recent.filter(e => e.outcome === 'success').length
  const rollbackRate = recent.filter(e => e.outcome === 'rolled_back').length

  return [
    `=== 过去的升级经验（近 ${recent.length} 次）===`,
    `成功 ${successRate} 次，回滚 ${rollbackRate} 次`,
    ...lines,
    ``,
    `升级策略建议：`,
    rollbackRate > successRate
      ? `回滚率偏高，优先改独立模块，避免改核心路径`
      : `成功率良好，可以尝试更深层次的改进`,
  ].join('\n')
}

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 2: CURIOSITY-DRIVEN IMPROVEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/** Generate improvement proposals even when nothing is broken */
export function generateCuriosityProposals(stats: InteractionStats): string[] {
  const proposals: string[] = []

  const evalM = computeEval(stats.totalMessages, stats.corrections)

  // Quality ceiling: good but not great
  if (evalM.avgQuality > 7 && evalM.avgQuality < 9) {
    proposals.push(`质量分已达 ${evalM.avgQuality}/10，能不能优化 prompt 再提 1 分？`)
  }

  // Memory tag coverage analysis
  const total = memoryState.memories.length
  if (total > 0) {
    const tagged = memoryState.memories.filter(m => m.tags && m.tags.length > 0).length
    const tagRate = Math.round(tagged / total * 100)
    if (tagRate > 50 && tagRate < 90) {
      proposals.push(`标签覆盖率 ${tagRate}%，如果达到 90% recall 精度会怎样？`)
    }
  }

  // Low correction rate — is it genuinely good or user stopped correcting?
  if (evalM.correctionRate < 2 && stats.totalMessages > 100) {
    proposals.push(`最近纠正率仅 ${evalM.correctionRate}%，是真的好还是用户不说了？`)
  }

  // Memory recall effectiveness
  if (evalM.memoryRecallRate > 0 && evalM.memoryRecallRate < 80) {
    proposals.push(`记忆召回率 ${evalM.memoryRecallRate}%，有没有优化 TF-IDF 权重的空间？`)
  }

  // Success pattern analysis
  proposals.push('最近成功模式集中在哪几种？有没有被忽略的好模式？')

  // Experience-based curiosity: if past upgrades worked on certain modules, explore others
  const upgradedModules = new Set(upgradeExperiences.filter(e => e.outcome === 'success').map(e => e.targetModule))
  if (upgradedModules.size > 0 && upgradedModules.size < 5) {
    const unexplored = ['cognition.ts', 'prompt-builder.ts', 'flow.ts', 'memory.ts']
      .filter(m => !upgradedModules.has(m))
    if (unexplored.length > 0) {
      proposals.push(`之前成功改过 ${[...upgradedModules].join('/')}，${unexplored[0]} 有没有类似优化空间？`)
    }
  }

  return proposals
}

/** Format curiosity proposals for notification (lighter tone than upgrade proposals) */
export function formatCuriosityNotification(proposals: string[]): string {
  const limited = proposals.slice(0, 5)
  const lines = limited.map((p, i) => `${i + 1}. ${p}`)
  return `🔭 灵魂思考（非紧急）：\n${lines.join('\n')}\n\n这些是优化方向，不是紧急问题。回复"探索 N"深入某个方向。`
}

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 3: FEEDBACK STATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const FEEDBACK_INTERVAL_MS = 14 * 86400000 // 14 days

/** Check if it's time to seek periodic feedback */
export function shouldSeekPeriodicFeedback(): boolean {
  return Date.now() - feedbackState.lastFeedbackAsk > FEEDBACK_INTERVAL_MS
}

/** Mark feedback as asked */
export function markFeedbackAsked() {
  feedbackState.lastFeedbackAsk = Date.now()
  saveJson(FEEDBACK_STATE_PATH, feedbackState)
}

/** Get days since last feedback ask */
export function daysSinceLastFeedback(): number {
  if (feedbackState.lastFeedbackAsk === 0) return 999
  return Math.floor((Date.now() - feedbackState.lastFeedbackAsk) / 86400000)
}

// ── SoulModule registration ──

export const upgradeExperienceModule: SoulModule = {
  id: 'upgrade-experience',
  name: '升级经验库',
  priority: 50,
}
