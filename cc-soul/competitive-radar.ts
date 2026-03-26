/**
 * competitive-radar.ts — Competitive feature radar
 *
 * Periodically searches competitor bots for new features, then applies 3-layer filter:
 *   Layer 1: cc-soul already has it? → skip
 *   Layer 2: OpenClaw already has it or should do it (platform-level)? → skip
 *   Layer 3: remaining → notify owner with suggestion
 *
 * Additionally generates a feature comparison matrix across competitors.
 * Runs via rover's tech radar slot (every 14 days) to avoid excessive API usage.
 */

import type { SoulModule } from './brain.ts'
import { resolve } from 'path'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { DATA_DIR, MODULE_DIR, loadJson, debouncedSave } from './persistence.ts'
import { spawnCLI } from './cli.ts'
import { notifyOwnerDM } from './notify.ts'
import { getAllFeatures } from './features.ts'
import { extractJSON } from './utils.ts'

// ══════════════════════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════════════════════

const RADAR_PATH = resolve(DATA_DIR, 'competitive_radar.json')
const HOME = process.env.HOME || ''

interface RadarState {
  lastScan: number
  findings: RadarFinding[]
  dismissedFeatures: string[]  // features owner said "skip" to
  ccSoulInventory: string[]      // dynamically scanned self capabilities
  openclawInventory: string[]    // dynamically scanned platform capabilities
  comparisonMatrix?: string      // latest comparison matrix text
  lastInventoryUpdate: number    // last inventory scan time
}

interface RadarFinding {
  feature: string
  source: string       // which competitor bot
  description: string
  layer: 'new' | 'openclaw_has' | 'cc_soul_has' | 'platform_level'
  suggestedAt: number
  ownerResponse?: 'add' | 'skip' | 'pending'
}

let radarState: RadarState = loadJson(RADAR_PATH, {
  lastScan: 0,
  findings: [],
  dismissedFeatures: [],
  ccSoulInventory: [],
  openclawInventory: [],
  comparisonMatrix: undefined,
  lastInventoryUpdate: 0,
})

const SCAN_INTERVAL = 14 * 86400000 // every 14 days

// ══════════════════════════════════════════════════════════════════════════════
// MODULE DESCRIPTION EXTRACTION — parse first 10 lines for /** */ or // comments
// ══════════════════════════════════════════════════════════════════════════════

function extractModuleDescription(filePath: string): string {
  try {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n').slice(0, 10)

    // Try /** ... */ block comment first
    const joined = lines.join('\n')
    const blockMatch = joined.match(/\/\*\*\s*\n?\s*\*?\s*(.+?)(?:\s*\n|\s*\*\/)/s)
    if (blockMatch) {
      // Extract the first meaningful line from the block comment
      const desc = blockMatch[1]
        .replace(/^\s*\*\s*/gm, '')
        .replace(/^[\w-]+\.ts\s*[-—]\s*/, '')
        .trim()
      if (desc.length > 3) return desc
    }

    // Fallback: first // comment
    for (const line of lines) {
      const m = line.match(/^\s*\/\/\s*(.+)/)
      if (m && m[1].length > 3 && !m[1].startsWith('!') && !m[1].startsWith('eslint')) {
        return m[1].replace(/^[\w-]+\.ts\s*[-—]\s*/, '').trim()
      }
    }
  } catch { /* file unreadable */ }
  return ''
}

// ══════════════════════════════════════════════════════════════════════════════
// CC-SOUL FEATURE INVENTORY — dynamic scan of modules + feature toggles
// ══════════════════════════════════════════════════════════════════════════════

function scanCcSoulInventory(): string[] {
  const inventory: string[] = []

  // 1) Feature toggles with status
  const features = getAllFeatures()
  const enabledFeatures = Object.entries(features)
    .filter(([, v]) => v)
    .map(([k]) => k)
  const disabledFeatures = Object.entries(features)
    .filter(([, v]) => !v)
    .map(([k]) => k)

  if (enabledFeatures.length > 0) {
    inventory.push(`[Feature Toggles ON] ${enabledFeatures.join(', ')}`)
  }
  if (disabledFeatures.length > 0) {
    inventory.push(`[Feature Toggles OFF] ${disabledFeatures.join(', ')}`)
  }

  // 2) Module scan — support both .ts and .js
  const moduleFiles: string[] = []
  try {
    if (existsSync(MODULE_DIR)) {
      moduleFiles.push(
        ...readdirSync(MODULE_DIR)
          .filter(f => (f.endsWith('.ts') || f.endsWith('.js')) && !f.endsWith('.d.ts'))
          .filter(f => !['types.ts', 'types.js'].includes(f))
      )
    }
  } catch { /* MODULE_DIR missing */ }

  for (const file of moduleFiles) {
    const name = file.replace(/\.(ts|js)$/, '')
    const desc = extractModuleDescription(resolve(MODULE_DIR, file))
    inventory.push(desc ? `[Module: ${name}] ${desc}` : `[Module: ${name}]`)
  }

  return inventory
}

function getCcSoulFeatureList(): string {
  const inventory = scanCcSoulInventory()

  // Update state (cheap file scan, do every call)
  radarState.ccSoulInventory = inventory
  radarState.lastInventoryUpdate = Date.now()
  debouncedSave(RADAR_PATH, radarState)

  return ['== cc-soul 已有功能 (动态扫描) ==', ...inventory].join('\n')
}

// ══════════════════════════════════════════════════════════════════════════════
// OPENCLAW FEATURE DETECTION — dynamic scan of plugins + skills + platform base
// ══════════════════════════════════════════════════════════════════════════════

/** Read package.json name+description or SKILL.md first line */
function extractPluginOrSkillDesc(dirPath: string): string {
  // Try package.json
  const pkgPath = resolve(dirPath, 'package.json')
  try {
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      const parts: string[] = []
      if (pkg.name) parts.push(pkg.name)
      if (pkg.description) parts.push(pkg.description)
      if (parts.length > 0) return parts.join(' — ')
    }
  } catch { /* bad JSON */ }

  // Try SKILL.md first line
  const skillMd = resolve(dirPath, 'SKILL.md')
  try {
    if (existsSync(skillMd)) {
      const firstLine = readFileSync(skillMd, 'utf-8').split('\n')[0]
      if (firstLine) return firstLine.replace(/^#+\s*/, '').trim()
    }
  } catch { /* unreadable */ }

  // Try README.md first line
  const readme = resolve(dirPath, 'README.md')
  try {
    if (existsSync(readme)) {
      const firstLine = readFileSync(readme, 'utf-8').split('\n')[0]
      if (firstLine) return firstLine.replace(/^#+\s*/, '').trim()
    }
  } catch { /* unreadable */ }

  return ''
}

function scanDirectory(dirPath: string): { name: string; desc: string }[] {
  const results: { name: string; desc: string }[] = []
  try {
    if (!existsSync(dirPath)) return results
    const items = readdirSync(dirPath).filter(f => !f.startsWith('.'))
    for (const item of items) {
      const fullPath = resolve(dirPath, item)
      try {
        const desc = extractPluginOrSkillDesc(fullPath)
        results.push({ name: item, desc })
      } catch {
        results.push({ name: item, desc: '' })
      }
    }
  } catch { /* dir unreadable */ }
  return results
}

function scanOpenClawInventory(): string[] {
  const inventory: string[] = []

  // Platform-level capabilities (minimal, real platform stuff plugins can't do)
  const platformBase = [
    '实时语音通话(音频编解码/VAD/传输)',
    '视觉输入(图片/视频/多模态路由)',
    'MCP协议(标准化工具接入/鉴权/沙箱)',
    'Canvas/协作编辑(UI渲染层)',
    'Computer Use/GUI操作(系统权限/安全沙箱)',
    '多模型路由(Claude/Gemini/GPT/本地模型)',
    '图片生成(模型调度+渲染管线)',
    'TTS/语音合成(音频管线)',
  ]
  for (const cap of platformBase) {
    inventory.push(`[Platform] ${cap}`)
  }

  // Dynamic: scan plugins
  const pluginsDir = resolve(HOME, '.openclaw/plugins')
  const plugins = scanDirectory(pluginsDir)
  for (const p of plugins) {
    inventory.push(p.desc ? `[Plugin: ${p.name}] ${p.desc}` : `[Plugin: ${p.name}]`)
  }

  // Dynamic: scan skills (two locations)
  const skillDirs = [
    resolve(HOME, '.openclaw/skills'),
    resolve(HOME, '.openclaw/workspace/skills'),
  ]
  for (const skillDir of skillDirs) {
    const skills = scanDirectory(skillDir)
    for (const s of skills) {
      const label = skillDir.includes('workspace') ? 'Workspace Skill' : 'Skill'
      inventory.push(s.desc ? `[${label}: ${s.name}] ${s.desc}` : `[${label}: ${s.name}]`)
    }
  }

  return inventory
}

function getOpenClawFeatures(): string {
  const inventory = scanOpenClawInventory()

  radarState.openclawInventory = inventory
  debouncedSave(RADAR_PATH, radarState)

  return ['== OpenClaw 平台已有/该做的功能 (动态扫描) ==', ...inventory].join('\n')
}

// ══════════════════════════════════════════════════════════════════════════════
// COMPETITOR LIST
// ══════════════════════════════════════════════════════════════════════════════

const COMPETITORS = [
  { name: 'Letta (MemGPT)', query: 'Letta MemGPT stateful agent features 2026' },
  { name: 'Mem0', query: 'Mem0 AI memory layer features 2026' },
  { name: 'Character.AI', query: 'Character.AI new features 2026' },
  { name: 'ChatGPT Memory', query: 'ChatGPT memory features update 2026' },
  { name: 'Claude Memory', query: 'Claude project knowledge memory features 2026' },
  { name: 'Gemini Memory', query: 'Gemini AI memory features 2026' },
  { name: 'Cursor / Windsurf / Copilot', query: 'Cursor Windsurf GitHub Copilot memory context features 2026' },
  { name: 'SillyTavern', query: 'SillyTavern latest release features 2026' },
  { name: 'Kindroid', query: 'Kindroid AI companion features 2026' },
  { name: 'OpenClaw Hub', query: 'OpenClaw skills marketplace soul plugins 2026' },
]

// ══════════════════════════════════════════════════════════════════════════════
// COMPETITOR SCAN — search + 3-layer filter + comparison matrix
// ══════════════════════════════════════════════════════════════════════════════

export function runCompetitiveRadar(force = false) {
  const now = Date.now()
  if (!force && now - radarState.lastScan < SCAN_INTERVAL) return
  radarState.lastScan = now
  debouncedSave(RADAR_PATH, radarState)

  console.log('[cc-soul][radar] starting competitive feature scan...')

  const ccSoulFeatures = getCcSoulFeatureList()
  const openClawFeatures = getOpenClawFeatures()
  const dismissed = radarState.dismissedFeatures.length > 0
    ? `\n已跳过的功能(owner不想要): ${radarState.dismissedFeatures.join(', ')}`
    : ''

  // Pick 4-5 competitors to search this cycle (rotate)
  const cycleIndex = Math.floor(now / SCAN_INTERVAL) % COMPETITORS.length
  const searchTargets: typeof COMPETITORS = []
  for (let i = 0; i < 5; i++) {
    searchTargets.push(COMPETITORS[(cycleIndex + i) % COMPETITORS.length])
  }

  const prompt = [
    '你是一个 AI Bot 竞品分析师。用 WebSearch 搜索以下竞品的最新功能更新:',
    '',
    '搜索目标(全部搜):',
    ...searchTargets.map(c => `- ${c.name}: 搜 "${c.query}"`),
    '',
    '必须用 WebSearch 真正搜索，不要靠记忆。每个竞品至少搜一次。',
    '',
    '搜到功能后，做三层过滤:',
    '',
    ccSoulFeatures,
    '',
    openClawFeatures,
    dismissed,
    '',
    '过滤规则:',
    '1. cc-soul 已经有的功能 → 标记 "cc_soul_has"',
    '2. OpenClaw 平台已有或该做的(语音/视觉/MCP等平台层) → 标记 "platform_level"',
    '3. 以上都不是，且适合作为灵魂/认知/记忆插件来实现的 → 标记 "new"',
    '',
    '输出两部分内容的 JSON:',
    '',
    '第一部分: 过滤后 "new" 的功能建议:',
    '第二部分: 功能对比矩阵 — 列出主要功能维度, 对比 cc-soul 和各竞品',
    '',
    '输出格式:',
    '{',
    '  "findings": [{"feature":"功能名","source":"竞品名","description":"一句话描述","why":"为什么cc-soul该加这个"}],',
    '  "matrix": "功能 | cc-soul | Letta | Mem0 | ChatGPT | Character.AI | ...\\n长期记忆 | ✅ | ✅ | ✅ | ✅ | ❌ | ...\\n..."',
    '}',
    '',
    'matrix 字段是一个 Markdown 表格字符串，每行用 | 分隔。',
    '纵轴是功能维度(至少15行)，横轴是 cc-soul 和搜到的竞品。',
    '用 ✅ ❌ 🔶(部分有) 标记。基于搜索结果如实填写，不确定的标 ❓。',
    '',
    '如果过滤后没有 new 的功能，findings 可以为空数组，但 matrix 仍然要生成。',
  ].join('\n')

  spawnCLI(prompt, (output) => {
    if (!output || output.length < 10) {
      console.log('[cc-soul][radar] scan returned empty')
      return
    }

    try {
      const result = extractJSON(output)
      if (!result) {
        console.log('[cc-soul][radar] no structured output parsed')
        return
      }

      // Process comparison matrix
      if (result.matrix && typeof result.matrix === 'string') {
        radarState.comparisonMatrix = result.matrix
        console.log('[cc-soul][radar] comparison matrix updated')
      }

      // Process findings
      if (!result.findings || !Array.isArray(result.findings)) {
        console.log('[cc-soul][radar] no findings array, matrix-only update')
        debouncedSave(RADAR_PATH, radarState)
        return
      }

      const newFindings: RadarFinding[] = result.findings
        .filter((f: any) => f.feature && f.source && f.description)
        .filter((f: any) => !radarState.dismissedFeatures.includes(f.feature))
        .filter((f: any) => !radarState.findings.some(existing => existing.feature === f.feature))
        .map((f: any) => ({
          feature: f.feature.slice(0, 100),
          source: f.source.slice(0, 50),
          description: f.description.slice(0, 200),
          layer: 'new' as const,
          suggestedAt: Date.now(),
          ownerResponse: 'pending' as const,
        }))

      if (newFindings.length > 0) {
        radarState.findings.push(...newFindings)
        // Keep last 50 findings
        if (radarState.findings.length > 50) {
          radarState.findings = radarState.findings.slice(-50)
        }
      }

      debouncedSave(RADAR_PATH, radarState)

      if (newFindings.length === 0) {
        console.log('[cc-soul][radar] no new features found after 3-layer filter (matrix updated)')
        return
      }

      // Notify owner
      const lines = newFindings.map((f, i) =>
        `${i + 1}. **${f.feature}** (来自 ${f.source})\n   ${f.description}`
      )

      let notification =
        `🔭 竞品雷达扫描完成，发现 ${newFindings.length} 个新功能建议:\n\n` +
        lines.join('\n\n') +
        '\n\n回复 "雷达加 N" 走升级流程添加\n回复 "雷达跳 N" 永久跳过'

      if (radarState.comparisonMatrix) {
        notification += '\n\n回复 "雷达矩阵" 查看完整对比矩阵'
      }

      notifyOwnerDM(notification).catch(() => {})

      console.log(`[cc-soul][radar] found ${newFindings.length} new feature suggestions`)
    } catch (e: any) {
      console.error(`[cc-soul][radar] parse error: ${e.message}`)
    }
  }, 180000, 'competitive-radar')
}

// ══════════════════════════════════════════════════════════════════════════════
// COMMAND HANDLER — "雷达加 N" / "雷达跳 N" / "竞品雷达" / "雷达矩阵"
// ══════════════════════════════════════════════════════════════════════════════

export function handleRadarCommand(msg: string): boolean {
  const m = msg.trim()

  // Manual trigger
  if (m === '竞品雷达' || m === '竞品扫描' || m === 'competitive radar') {
    radarState.lastScan = 0 // reset cooldown
    debouncedSave(RADAR_PATH, radarState)
    runCompetitiveRadar(true)
    return true
  }

  // Show comparison matrix
  if (m === '雷达矩阵' || m === 'radar matrix') {
    if (radarState.comparisonMatrix) {
      console.log(`[cc-soul][radar] 功能对比矩阵:\n${radarState.comparisonMatrix}`)
      notifyOwnerDM(`📊 功能对比矩阵:\n\n${radarState.comparisonMatrix}`).catch(() => {})
    } else {
      console.log('[cc-soul][radar] 暂无对比矩阵，等待下次扫描生成')
      notifyOwnerDM('暂无对比矩阵数据，发送 "竞品雷达" 触发扫描').catch(() => {})
    }
    return true
  }

  // "雷达加 N" — mark feature for upgrade
  const addMatch = m.match(/^雷达加\s*(\d+)$/)
  if (addMatch) {
    const idx = parseInt(addMatch[1]) - 1
    const pending = radarState.findings.filter(f => f.ownerResponse === 'pending')
    if (idx >= 0 && idx < pending.length) {
      pending[idx].ownerResponse = 'add'
      debouncedSave(RADAR_PATH, radarState)
      notifyOwnerDM(
        `✅ 已标记「${pending[idx].feature}」待添加\n` +
        `下次升级分析时会作为改进需求纳入`
      ).catch(() => {})
      return true
    }
  }

  // "雷达跳 N" — permanently skip
  const skipMatch = m.match(/^雷达跳\s*(\d+)$/)
  if (skipMatch) {
    const idx = parseInt(skipMatch[1]) - 1
    const pending = radarState.findings.filter(f => f.ownerResponse === 'pending')
    if (idx >= 0 && idx < pending.length) {
      pending[idx].ownerResponse = 'skip'
      radarState.dismissedFeatures.push(pending[idx].feature)
      // Cap dismissed list
      if (radarState.dismissedFeatures.length > 100) {
        radarState.dismissedFeatures = radarState.dismissedFeatures.slice(-100)
      }
      debouncedSave(RADAR_PATH, radarState)
      notifyOwnerDM(`⏭ 已跳过「${pending[idx].feature}」，以后不再建议`).catch(() => {})
      return true
    }
  }

  // "雷达状态" — show pending findings + inventory summary
  if (m === '雷达状态' || m === 'radar status') {
    const pending = radarState.findings.filter(f => f.ownerResponse === 'pending')
    const added = radarState.findings.filter(f => f.ownerResponse === 'add')
    const lines: string[] = []

    lines.push(`cc-soul 模块数: ${radarState.ccSoulInventory.filter(s => s.startsWith('[Module:')).length}`)
    lines.push(`OpenClaw 插件/Skill 数: ${radarState.openclawInventory.filter(s => !s.startsWith('[Platform]')).length}`)
    lines.push(`对比矩阵: ${radarState.comparisonMatrix ? '有' : '无'}`)
    lines.push(`上次扫描: ${radarState.lastScan ? new Date(radarState.lastScan).toISOString().slice(0, 10) : '从未'}`)
    lines.push('')

    if (pending.length > 0) {
      lines.push(`待决定 (${pending.length}):`)
      pending.forEach((f, i) => lines.push(`  ${i + 1}. ${f.feature} (${f.source}) — ${f.description.slice(0, 60)}`))
    }
    if (added.length > 0) {
      lines.push(`\n待添加 (${added.length}):`)
      added.forEach(f => lines.push(`  ✅ ${f.feature} — ${f.description.slice(0, 60)}`))
    }
    if (pending.length === 0 && added.length === 0) {
      lines.push('无待处理的竞品建议')
    }

    console.log(`[cc-soul][radar] status:\n${lines.join('\n')}`)
    return true
  }

  return false
}

// ══════════════════════════════════════════════════════════════════════════════
// UPGRADE INTEGRATION — provide accepted features as upgrade context
// ══════════════════════════════════════════════════════════════════════════════

/** Get accepted radar features for injection into upgrade analysis */
export function getRadarUpgradeContext(): string {
  const accepted = radarState.findings.filter(f => f.ownerResponse === 'add')
  if (accepted.length === 0) return ''

  return [
    '=== 用户要求添加的竞品功能 ===',
    ...accepted.map(f => `- ${f.feature} (${f.source}): ${f.description}`),
  ].join('\n')
}

/** Mark a feature as implemented (call after successful upgrade) */
export function markFeatureImplemented(featureName: string) {
  const finding = radarState.findings.find(f => f.feature === featureName && f.ownerResponse === 'add')
  if (finding) {
    finding.ownerResponse = 'skip' // done, don't suggest again
    radarState.dismissedFeatures.push(featureName)
    debouncedSave(RADAR_PATH, radarState)
  }
}

/** Get the latest comparison matrix text */
export function getComparisonMatrix(): string {
  // Refresh inventory on every call (cheap file scan)
  scanCcSoulInventory()
  scanOpenClawInventory()
  return radarState.comparisonMatrix || ''
}

// ── SoulModule registration ──

export const competitiveRadarModule: SoulModule = {
  id: 'competitive-radar',
  name: '竞品雷达',
  priority: 50,
  features: ['tech_radar'],
}
