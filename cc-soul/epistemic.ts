/**
 * epistemic.ts — Knowledge boundary self-awareness
 *
 * Tracks quality and correction rates per domain, auto-detects weak areas.
 * Provides confidence hints for augment injection and soul prompt.
 */

import { resolve } from 'path'
import type { SoulModule } from './brain.ts'
import type { InteractionStats } from './types.ts'
import { DATA_DIR, loadJson, debouncedSave } from './persistence.ts'

const EPISTEMIC_PATH = resolve(DATA_DIR, 'epistemic.json')

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface DomainConfidence {
  domain: string           // "python" | "ios-reverse" | "图片识别" | "闲聊" etc
  totalResponses: number
  qualitySum: number
  corrections: number
  avgQuality: number       // computed
  correctionRate: number   // computed
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

const domains = new Map<string, DomainConfidence>()

// ═══════════════════════════════════════════════════════════════════════════════
// DOMAIN DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

export function detectDomain(msg: string): string {
  const m = msg.toLowerCase()

  // Technical domains (order: specific → general)
  if (['frida', 'hook', 'ida', 'mach-o', 'dyld', 'arm64', 'objc', '逆向', '砸壳', 'tweak', 'substrate', 'theos'].some(w => m.includes(w))) return 'ios-reverse'
  if (['swift', 'xcode', 'swiftui', 'uikit', 'cocoa', 'appkit'].some(w => m.includes(w))) return 'swift'
  if (['python', 'pip', 'flask', 'django', 'def ', 'import ', '.py', 'asyncio', 'pandas'].some(w => m.includes(w))) return 'python'
  if (['typescript', 'javascript', 'node', 'react', 'vue', '.ts', '.js', 'npm', 'pnpm', 'bun'].some(w => m.includes(w))) return 'javascript'
  if (['docker', 'k8s', 'kubernetes', 'nginx', 'linux', 'bash', 'shell', 'systemd', 'ssh'].some(w => m.includes(w))) return 'devops'
  if (['sql', 'mysql', 'postgres', 'mongodb', '数据库', 'redis', 'sqlite'].some(w => m.includes(w))) return 'database'
  if (['图片', 'ocr', '识别', '照片', '截图', '看看这个', '这张图'].some(w => m.includes(w))) return '图片识别'
  if (['git', 'github', 'pr', 'merge', 'branch', 'commit', 'rebase'].some(w => m.includes(w))) return 'git'
  if (['rust', 'cargo', '.rs', 'lifetime', 'borrow checker'].some(w => m.includes(w))) return 'rust'
  if (['go ', 'golang', 'goroutine', '.go', 'func '].some(w => m.includes(w))) return 'golang'

  // Non-technical
  if (msg.length < 20) return '闲聊'
  if (['怎么看', '你觉得', '建议', '应该', '推荐'].some(w => m.includes(w))) return '咨询'

  return '通用'
}

// ═══════════════════════════════════════════════════════════════════════════════
// PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════════

export function loadEpistemic() {
  const raw = loadJson<Record<string, DomainConfidence>>(EPISTEMIC_PATH, {})
  domains.clear()
  for (const [k, v] of Object.entries(raw)) {
    domains.set(k, v)
  }
  console.log(`[cc-soul][epistemic] loaded ${domains.size} domains`)
}

function saveEpistemic() {
  const obj: Record<string, DomainConfidence> = {}
  for (const [k, v] of domains) {
    obj[k] = v
  }
  debouncedSave(EPISTEMIC_PATH, obj)
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

function ensureDomain(domain: string): DomainConfidence {
  let d = domains.get(domain)
  if (!d) {
    d = { domain, totalResponses: 0, qualitySum: 0, corrections: 0, avgQuality: 5, correctionRate: 0 }
    domains.set(domain, d)
  }
  return d
}

function recompute(d: DomainConfidence) {
  d.avgQuality = d.totalResponses > 0
    ? Math.round(d.qualitySum / d.totalResponses * 10) / 10
    : 5
  d.correctionRate = d.totalResponses > 0
    ? Math.round(d.corrections / d.totalResponses * 1000) / 10
    : 0
}

export function trackDomainQuality(msg: string, score: number) {
  const domain = detectDomain(msg)
  const d = ensureDomain(domain)
  d.totalResponses++
  d.qualitySum += score
  recompute(d)
  saveEpistemic()
}

export function trackDomainCorrection(msg: string) {
  const domain = detectDomain(msg)
  const d = ensureDomain(domain)
  d.corrections++
  recompute(d)
  saveEpistemic()
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIDENCE QUERY
// ═══════════════════════════════════════════════════════════════════════════════

export function getDomainConfidence(msg: string): { domain: string; confidence: 'high' | 'medium' | 'low'; hint: string } {
  const domain = detectDomain(msg)
  const d = domains.get(domain)

  // New domain — not enough data
  if (!d || d.totalResponses < 3) {
    return { domain, confidence: 'medium', hint: '' }
  }

  // Low confidence: high correction rate with enough samples
  if (d.correctionRate > 10 && d.totalResponses >= 5) {
    return {
      domain,
      confidence: 'low',
      hint: `[知识边界] "${domain}" 领域纠正率 ${d.correctionRate}%，这个领域我不太确定，你验证一下`,
    }
  }

  // Low confidence: low quality with enough samples
  if (d.avgQuality < 5 && d.totalResponses >= 5) {
    return {
      domain,
      confidence: 'low',
      hint: `[知识边界] "${domain}" 领域平均质量 ${d.avgQuality}/10，我在这方面表现不佳，请仔细核实`,
    }
  }

  // High confidence: good quality with substantial data
  if (d.avgQuality > 7 && d.totalResponses >= 10) {
    return { domain, confidence: 'high', hint: '' }
  }

  return { domain, confidence: 'medium', hint: '' }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEAK DOMAINS — domains with high correction rate or low quality
// ═══════════════════════════════════════════════════════════════════════════════

/** Returns domain names with high correction rate or low quality, sorted by worst first */
export function getWeakDomains(): string[] {
  return [...domains.values()]
    .filter(d => d.totalResponses >= 5 && (d.correctionRate > 10 || d.avgQuality < 5))
    .sort((a, b) => b.correctionRate - a.correctionRate)
    .map(d => d.domain)
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOUL PROMPT SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * P1-#12: getCapabilityScore — 对话能力评分公示
 * 格式化输出每个域的质量分和纠正率
 */
export function getCapabilityScore(): string {
  if (domains.size === 0) return '🎯 能力评分\n═══════════════════════════════\n暂无数据，需要更多对话来建立域置信度。'

  const entries = [...domains.values()]
    .filter(d => d.totalResponses >= 2)
    .sort((a, b) => b.totalResponses - a.totalResponses)

  if (entries.length === 0) return '🎯 能力评分\n═══════════════════════════════\n样本不足，至少每个领域 2 次对话。'

  const lines = [
    '🎯 能力评分',
    '═══════════════════════════════',
    `${'域'.padEnd(15)} ${'质量'.padStart(5)} ${'纠正率'.padStart(7)} ${'样本'.padStart(5)}`,
    '─'.repeat(35),
  ]
  for (const d of entries) {
    const bar = d.avgQuality >= 7 ? '✓' : d.avgQuality < 5 ? '✗' : '~'
    lines.push(`${bar} ${d.domain.padEnd(13)} ${d.avgQuality.toFixed(1).padStart(5)} ${(d.correctionRate + '%').padStart(7)} ${d.totalResponses.toString().padStart(5)}`)
  }

  const overall = entries.reduce((s, d) => s + d.qualitySum, 0) / Math.max(1, entries.reduce((s, d) => s + d.totalResponses, 0))
  lines.push('─'.repeat(35))
  lines.push(`综合质量: ${overall.toFixed(1)}/10`)

  return lines.join('\n')
}

export function getEpistemicSummary(): string {
  if (domains.size === 0) return ''

  const entries = [...domains.values()]
    .filter(d => d.totalResponses >= 3) // only show domains with enough data
    .sort((a, b) => b.totalResponses - a.totalResponses)

  if (entries.length === 0) return ''

  const lines: string[] = []

  // Weak domains (high correction rate or low quality)
  const weak = entries.filter(d =>
    (d.correctionRate > 10 && d.totalResponses >= 5) ||
    (d.avgQuality < 5 && d.totalResponses >= 5),
  )
  if (weak.length > 0) {
    lines.push('⚠ 薄弱领域（回答前要格外谨慎）：')
    for (const d of weak) {
      lines.push(`- ${d.domain}: 质量${d.avgQuality}/10, 纠正率${d.correctionRate}%, 样本${d.totalResponses}`)
    }
  }

  // Strong domains
  const strong = entries.filter(d => d.avgQuality > 7 && d.totalResponses >= 10)
  if (strong.length > 0) {
    lines.push('✓ 擅长领域：')
    for (const d of strong) {
      lines.push(`- ${d.domain}: 质量${d.avgQuality}/10, 样本${d.totalResponses}`)
    }
  }

  return lines.join('\n')
}

// ═══════════════════════════════════════════════════════════════════════════════
// #6 Growth Vectors — quantify agent growth trajectory
// ═══════════════════════════════════════════════════════════════════════════════

export interface GrowthVector {
  dimension: string
  current: number
  trend: 'up' | 'down' | 'stable'
  label: string
}

/**
 * Compute growth vectors from stats, rules, memories, epistemic domains.
 * No extra storage needed — all computed from existing data.
 */
export function getGrowthVectors(): GrowthVector[] {
  // Get dependencies from globalThis or dynamic refs to avoid circular deps + ESM require issue
  let rules: any[] = []
  let stats: any = { totalMessages: 0, corrections: 0 }
  let getDb: any = () => null
  try { rules = (globalThis as any).__ccSoulRules || [] } catch {}
  try { stats = (globalThis as any).__ccSoulStats || stats } catch {}
  try { getDb = (globalThis as any).__ccSoulSqlite?.db ? () => (globalThis as any).__ccSoulSqlite.db : getDb } catch {}

  const vectors: GrowthVector[] = []
  const now = Date.now()
  const WEEK = 7 * 86400000

  // 1. correction_rate: 7-day window vs previous 7-day window
  try {
    const db = getDb()
    if (db) {
      const cur7d = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE scope = 'correction' AND ts > ?").get(now - WEEK) as any)?.c || 0
      const prev7d = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE scope = 'correction' AND ts > ? AND ts <= ?").get(now - 2 * WEEK, now - WEEK) as any)?.c || 0
      const curChats = (db.prepare("SELECT COUNT(*) as c FROM chat_history WHERE ts > ?").get(now - WEEK) as any)?.c || 1
      const prevChats = (db.prepare("SELECT COUNT(*) as c FROM chat_history WHERE ts > ? AND ts <= ?").get(now - 2 * WEEK, now - WEEK) as any)?.c || 1
      const curRate = cur7d / curChats
      const prevRate = prev7d / prevChats
      const trend = curRate < prevRate - 0.02 ? 'up' : curRate > prevRate + 0.02 ? 'down' : 'stable'
      vectors.push({
        dimension: 'correction_rate',
        current: Math.round(curRate * 1000) / 10,
        trend,
        label: `纠正率 ${(curRate * 100).toFixed(1)}%${trend === 'up' ? ' (改善中)' : trend === 'down' ? ' (需注意)' : ''}`,
      })
    }
  } catch {}

  // 2. rule_count: rules growth
  try {
    const ruleCount = (rules as any[]).length
    const recentRules = (rules as any[]).filter((r: any) => now - r.ts < WEEK).length
    const trend = recentRules >= 3 ? 'up' : recentRules === 0 ? 'stable' : 'stable'
    vectors.push({
      dimension: 'rule_count',
      current: ruleCount,
      trend,
      label: `规则 ${ruleCount} 条 (本周+${recentRules})`,
    })
  } catch {}

  // 3. memory_quality: average confidence of active memories
  try {
    const db = getDb()
    if (db) {
      const curAvg = (db.prepare("SELECT AVG(confidence) as avg FROM memories WHERE scope != 'expired' AND scope != 'decayed' AND ts > ?").get(now - WEEK) as any)?.avg
      const prevAvg = (db.prepare("SELECT AVG(confidence) as avg FROM memories WHERE scope != 'expired' AND scope != 'decayed' AND ts > ? AND ts <= ?").get(now - 2 * WEEK, now - WEEK) as any)?.avg
      if (curAvg != null) {
        const cur = Math.round(curAvg * 100) / 100
        const trend = prevAvg != null ? (curAvg > prevAvg + 0.03 ? 'up' : curAvg < prevAvg - 0.03 ? 'down' : 'stable') : 'stable'
        vectors.push({
          dimension: 'memory_quality',
          current: cur,
          trend,
          label: `记忆质量 ${cur.toFixed(2)}${trend === 'up' ? ' (提升)' : trend === 'down' ? ' (下降)' : ''}`,
        })
      }
    }
  } catch {}

  // 4. recall_accuracy: ratio of recalled memories that were subsequently accessed again (proxy for accuracy)
  try {
    const db = getDb()
    if (db) {
      const totalRecalled = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE recallCount > 0 AND scope != 'expired'").get() as any)?.c || 0
      const highRecall = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE recallCount >= 3 AND scope != 'expired'").get() as any)?.c || 0
      const accuracy = totalRecalled > 0 ? highRecall / totalRecalled : 0
      vectors.push({
        dimension: 'recall_accuracy',
        current: Math.round(accuracy * 100),
        trend: accuracy > 0.3 ? 'up' : accuracy < 0.1 ? 'down' : 'stable',
        label: `召回准确率 ${(accuracy * 100).toFixed(0)}% (高频命中 ${highRecall}/${totalRecalled})`,
      })
    }
  } catch {}

  // 5. domain_breadth: number of tracked domains
  try {
    const domainCount = domains.size
    const activeDomains = [...domains.values()].filter(d => d.totalResponses >= 3).length
    vectors.push({
      dimension: 'domain_breadth',
      current: activeDomains,
      trend: activeDomains > 5 ? 'up' : 'stable',
      label: `领域覆盖 ${activeDomains} 个活跃领域 (共 ${domainCount})`,
    })
  } catch {}

  return vectors
}

/**
 * Format growth vectors for display.
 */
export function formatGrowthVectors(): string {
  const vectors = getGrowthVectors()
  if (vectors.length === 0) return '成长轨迹: 数据不足，需要更多对话积累。'
  const trendIcon = (t: string) => t === 'up' ? '📈' : t === 'down' ? '📉' : '➡️'
  const lines = [
    '🌱 成长轨迹',
    '═══════════════════════════════',
    ...vectors.map(v => `  ${trendIcon(v.trend)} ${v.label}`),
  ]
  return lines.join('\n')
}

// ── SoulModule ──
export const epistemicModule: SoulModule = {
  id: 'epistemic',
  name: '知识边界自觉',
  priority: 50,
  init() { loadEpistemic() },
}
