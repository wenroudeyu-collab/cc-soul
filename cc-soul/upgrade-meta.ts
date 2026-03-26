import type { SoulModule } from './brain.ts'

/**
 * upgrade-meta.ts — Meta-learning: learning HOW to upgrade better over time
 *
 * Tracks patterns from past upgrade outcomes (success/rollback/fail) and
 * accumulates structural insights about which modules are safe to change,
 * which description keywords correlate with success, etc.
 *
 * After ~10 upgrades the system knows things like:
 * - "改 memory.ts 成功率 80%, 改 handler.ts 成功率 30%"
 * - "prompt 相关修改需要 A/B 测试"
 * - "recall 优化效果最明显"
 */

import { loadJson, debouncedSave, UPGRADE_META_PATH } from './persistence.ts'

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface UpgradeInsight {
  pattern: string       // e.g. "改独立模块比改 handler.ts 安全"
  evidence: number      // how many times this was observed
  confidence: number    // 0-1
  lastSeen: number
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_INSIGHTS = 20

let metaInsights: UpgradeInsight[] = loadJson(UPGRADE_META_PATH, [])

export function loadUpgradeMeta() {
  metaInsights = loadJson(UPGRADE_META_PATH, [])
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE: learn from each upgrade outcome
// ═══════════════════════════════════════════════════════════════════════════════

/** Called after each upgrade evaluation (success or rollback) */
export function learnFromUpgrade(params: {
  targetModule: string
  description: string
  outcome: 'success' | 'rolled_back' | 'failed'
  metricsChange: string  // e.g. "+0.5 quality" or "-3% correction rate"
}) {
  // Pattern: which modules are safe to change
  if (params.outcome === 'success') {
    addInsight(`改 ${params.targetModule} 通常安全`, 1)
    if (params.targetModule !== 'handler.ts') {
      addInsight('改独立模块比改 handler.ts 成功率高', 0.8)
    }
  } else {
    addInsight(`改 ${params.targetModule} 有风险，需要额外验证`, 0.7)
    if (params.targetModule === 'handler.ts') {
      addInsight('handler.ts 修改风险高，优先改其他模块', 0.9)
    }
  }

  // Pattern: description keywords and outcomes
  if (params.description.includes('recall') && params.outcome === 'success') {
    addInsight('recall 算法优化效果通常明显', 0.7)
  }
  if (params.description.includes('prompt') && params.outcome === 'rolled_back') {
    addInsight('prompt 修改效果不稳定，建议 A/B 测试', 0.6)
  }
  if (params.description.includes('memory') && params.outcome === 'success') {
    addInsight('memory 相关优化成功率较高', 0.7)
  }
  if (params.description.includes('quality') && params.outcome === 'rolled_back') {
    addInsight('quality 评分机制修改容易引入副作用', 0.6)
  }

  // Pattern: metrics-based insights
  if (params.metricsChange.includes('+') && params.outcome === 'success') {
    addInsight('指标正向变化的升级值得保留', 0.8)
  }
  if (params.outcome === 'rolled_back') {
    addInsight('观察期发现问题及时回滚是正确策略', 0.9)
  }

  debouncedSave(UPGRADE_META_PATH, metaInsights)
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL: insight accumulation with EMA confidence update
// ═══════════════════════════════════════════════════════════════════════════════

function addInsight(pattern: string, confidence: number) {
  const existing = metaInsights.find(i => i.pattern === pattern)
  if (existing) {
    existing.evidence++
    existing.confidence = existing.confidence * 0.7 + confidence * 0.3 // EMA
    existing.lastSeen = Date.now()
  } else {
    metaInsights.push({ pattern, evidence: 1, confidence, lastSeen: Date.now() })
  }
  // Keep top N by evidence * confidence score
  if (metaInsights.length > MAX_INSIGHTS) {
    metaInsights.sort((a, b) => b.evidence * b.confidence - a.evidence * a.confidence)
    metaInsights = metaInsights.slice(0, MAX_INSIGHTS)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC: get meta-learning context for upgrade prompts
// ═══════════════════════════════════════════════════════════════════════════════

/** Returns formatted meta-learning context for injection into engineer prompts */
export function getUpgradeMetaContext(): string {
  const relevant = metaInsights.filter(i => i.evidence >= 2 && i.confidence > 0.5)
  if (relevant.length === 0) return ''

  return '## 升级经验（meta-learning）\n' +
    relevant.map(i =>
      `- ${i.pattern} (${i.evidence}次观察, 信心${(i.confidence * 100).toFixed(0)}%)`
    ).join('\n')
}

/** Returns raw insights for diagnostic report */
export function getMetaInsights(): UpgradeInsight[] {
  return metaInsights
}

export const upgradeMetaModule: SoulModule = {
  id: 'upgrade-meta',
  name: '升级元学习',
  priority: 50,
  init() { loadUpgradeMeta() },
}
