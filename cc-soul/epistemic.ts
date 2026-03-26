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
// WEAK DOMAINS — for rover directed learning
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

// ── SoulModule ──
export const epistemicModule: SoulModule = {
  id: 'epistemic',
  name: '知识边界自觉',
  priority: 50,
  init() { loadEpistemic() },
}
