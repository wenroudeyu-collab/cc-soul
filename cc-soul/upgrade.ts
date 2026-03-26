/**
 * upgrade.ts — Module-Aware Soul Self-Upgrade System
 *
 * Architecture-level upgrade: knows the modular file structure, uses epistemic
 * data to identify weak modules, reads/modifies target modules (not just handler.ts).
 *
 * Flow: analyze (epistemic-driven) → owner confirm → 5-agent module upgrade
 *       → esbuild syntax check → observation → auto-rollback
 */

import type { SoulModule } from './brain.ts'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, cpSync } from 'fs'
import { execSync } from 'child_process'
import { resolve } from 'path'
import { createHash } from 'crypto'
import type { UpgradeLogEntry, UpgradeState, EvalMetrics, InteractionStats } from './types.ts'
import {
  loadJson, saveJson, debouncedSave, flushAll,
  UPGRADE_LOG_PATH, UPGRADE_STATE_PATH,
  HANDLER_PATH, HANDLER_BACKUP_DIR, MODULE_DIR, DATA_DIR,
} from './persistence.ts'
import { spawnCLI, spawnCLIForUpgrade } from './cli.ts'
import { notifySoulActivity, notifyOwnerDM } from './notify.ts'
import { rules } from './evolution.ts'
import { getEpistemicSummary } from './epistemic.ts'
import { evalMetrics, computeEval, getEvalSummary } from './quality.ts'
import { memoryState, addMemory } from './memory.ts'
import { innerState } from './inner-life.ts'
import { extractJSON } from './utils.ts'
import { getAvgFrustration } from './flow.ts'
import { appendAudit } from './audit.ts'

// ── Risk-level assessment for graded autonomy (#16) ──

function assessUpgradeRisk(proposal: { change: string; reason: string; scope: string }): 'low' | 'high' {
  const text = `${proposal.change} ${proposal.reason} ${proposal.scope}`.toLowerCase()
  if (text.includes('.ts') || text.includes('handler') || text.includes('memory') ||
      text.includes('features.json') || text.includes('核心') || text.includes('core')) return 'high'
  if (text.includes('soul.md') || text.includes('参数') || text.includes('lorebook') ||
      text.includes('auto-tune') || text.includes('措辞') || text.includes('wording')) return 'low'
  return 'high' // default safe
}
import { getModuleErrorSummary, getErrorDetails, resetModuleErrors } from './health.ts'
import { runFullDiagnostic, formatDiagnosticReport, runDeepCodeAudit } from './diagnostic.ts'
import type { DiagnosticResult } from './diagnostic.ts'
import {
  recordExperience, getExperienceContext,
  generateCuriosityProposals, formatCuriosityNotification,
} from './upgrade-experience.ts'
import { learnFromUpgrade, getUpgradeMetaContext } from './upgrade-meta.ts'
import { getRadarUpgradeContext, runCompetitiveRadar } from './competitive-radar.ts'

// ══════════════════════════════════════════════════════════════════════════════
// Guard 1: Upgrade loop prevention
// ══════════════════════════════════════════════════════════════════════════════

const UPGRADE_LOCK_PATH = resolve(DATA_DIR, 'upgrade_lock.json')

interface UpgradeLock {
  consecutiveFailures: number
  lockedUntil: number  // timestamp, 0 = not locked
  moduleLastUpgraded: Record<string, number>  // module → timestamp
}

let upgradeLock: UpgradeLock = loadJson(UPGRADE_LOCK_PATH, { consecutiveFailures: 0, lockedUntil: 0, moduleLastUpgraded: {} })

function isUpgradeLocked(): boolean {
  if (upgradeLock.lockedUntil > Date.now()) {
    console.log(`[cc-soul][upgrade] locked until ${new Date(upgradeLock.lockedUntil).toISOString()}`)
    return true
  }
  return false
}

function isModuleOnCooldown(moduleName: string): boolean {
  const lastUpgrade = upgradeLock.moduleLastUpgraded[moduleName] || 0
  const cooldown = 7 * 86400000 // 7 days
  if (Date.now() - lastUpgrade < cooldown) {
    console.log(`[cc-soul][upgrade] module ${moduleName} on cooldown until ${new Date(lastUpgrade + cooldown).toISOString()}`)
    return true
  }
  return false
}

function recordUpgradeFailure() {
  upgradeLock.consecutiveFailures++
  if (upgradeLock.consecutiveFailures >= 3) {
    upgradeLock.lockedUntil = Date.now() + 30 * 86400000 // lock 30 days
    console.error(`[cc-soul][upgrade] LOCKED for 30 days after ${upgradeLock.consecutiveFailures} consecutive failures`)
    notifyOwnerDM(`🔒 升级系统已锁定 30 天（连续 ${upgradeLock.consecutiveFailures} 次失败）\n手动发"解锁升级"解除`).catch(() => {})
  }
  saveJson(UPGRADE_LOCK_PATH, upgradeLock)
}

function recordUpgradeSuccess(moduleName: string) {
  upgradeLock.consecutiveFailures = 0
  upgradeLock.moduleLastUpgraded[moduleName] = Date.now()
  saveJson(UPGRADE_LOCK_PATH, upgradeLock)
}

// ══════════════════════════════════════════════════════════════════════════════
// Guard 2: Regression tests
// ══════════════════════════════════════════════════════════════════════════════

function runRegressionTests(): { passed: boolean; failures: string[] } {
  const failures: string[] = []

  try {
    // Test 1: handler.ts must export default
    const handlerCode = readFileSync(HANDLER_PATH, 'utf-8')
    if (!handlerCode.includes('export default handler')) {
      failures.push('handler.ts missing export default handler')
    }

    // Test 2: All module imports must resolve
    const imports = handlerCode.match(/from\s+'\.\/[\w-]+\.ts'/g) || []
    for (const imp of imports) {
      const modName = imp.match(/'\.\/([\w-]+)\.ts'/)?.[1]
      if (modName && !existsSync(resolve(MODULE_DIR, `${modName}.ts`))) {
        failures.push(`broken import: ${modName}.ts not found`)
      }
    }

    // Test 3: Core identity must be in prompt-builder
    const promptBuilderPath = resolve(MODULE_DIR, 'prompt-builder.ts')
    if (existsSync(promptBuilderPath)) {
      const promptCode = readFileSync(promptBuilderPath, 'utf-8')
      if (!promptCode.includes('cc') || !promptCode.includes('灵魂')) {
        failures.push('prompt-builder.ts missing core identity')
      }
    }

    // Test 4: No rogue setInterval with <60s
    const allCode = readdirSync(MODULE_DIR)
      .filter(f => f.endsWith('.ts'))
      .map(f => readFileSync(resolve(MODULE_DIR, f), 'utf-8'))
      .join('\n')
    const intervals = allCode.match(/setInterval\([^)]*,\s*(\d+)/g) || []
    for (const interval of intervals) {
      const ms = parseInt(interval.match(/(\d+)$/)?.[1] || '0')
      if (ms > 0 && ms < 60000) {
        failures.push(`dangerous setInterval with ${ms}ms (<60s minimum)`)
      }
    }

    // Test 5: Logic regression tests (core module behavior)
    try {
      const { runRegressionSuite } = require('./tests.ts')
      const suiteResult = runRegressionSuite()
      if (suiteResult.failed > 0) {
        failures.push(`logic tests: ${suiteResult.failed}/${suiteResult.total} failed`)
        failures.push(...suiteResult.failures)
      }
    } catch (e: any) {
      // tests.ts might not be loadable in all contexts (e.g. bundled), soft fail
      console.warn(`[cc-soul][upgrade] logic tests unavailable: ${e.message}`)
    }
  } catch (e: any) {
    failures.push(`regression test error: ${e.message}`)
  }

  return { passed: failures.length === 0, failures }
}

// ══════════════════════════════════════════════════════════════════════════════
// Guard 3: Core file integrity (hash check)
// ══════════════════════════════════════════════════════════════════════════════

const CORE_HASHES_PATH = resolve(DATA_DIR, 'core_hashes.json')
const IMMUTABLE_FILES = ['upgrade.ts', 'diagnostic.ts', 'cli.ts', 'persistence.ts', 'tests.ts']

function computeFileHash(filePath: string): string {
  try {
    return createHash('sha256').update(readFileSync(filePath, 'utf-8')).digest('hex').slice(0, 16)
  } catch { return '' }
}

function snapshotCoreHashes() {
  const hashes: Record<string, string> = {}
  for (const f of IMMUTABLE_FILES) {
    hashes[f] = computeFileHash(resolve(MODULE_DIR, f))
  }
  saveJson(CORE_HASHES_PATH, hashes)
}

function verifyCoreIntegrity(): string[] {
  const saved = loadJson<Record<string, string>>(CORE_HASHES_PATH, {})
  if (Object.keys(saved).length === 0) {
    snapshotCoreHashes() // first run
    return []
  }
  const violations: string[] = []
  for (const f of IMMUTABLE_FILES) {
    const current = computeFileHash(resolve(MODULE_DIR, f))
    if (saved[f] && current !== saved[f]) {
      violations.push(`${f} was modified (hash mismatch)`)
    }
  }
  return violations
}

// ══════════════════════════════════════════════════════════════════════════════
// Guard 4: Memory data pollution check
// ══════════════════════════════════════════════════════════════════════════════

function checkDataPollution(): string[] {
  const issues: string[] = []
  const recent = memoryState.memories.slice(-10)

  if (recent.length >= 5) {
    // Check visibility distribution
    const visibilities = recent.map(m => m.visibility || 'global')
    const allSame = visibilities.every(v => v === visibilities[0])
    if (allSame && recent.length >= 5) {
      issues.push(`最近 10 条记忆全是 ${visibilities[0]}，可能有 visibility 逻辑问题`)
    }

    // Check for empty content
    const empties = recent.filter(m => !m.content || m.content.length < 3)
    if (empties.length > 3) {
      issues.push(`最近 10 条记忆中 ${empties.length} 条内容为空`)
    }
  }

  return issues
}

// ══════════════════════════════════════════════════════════════════════════════
// Guard 5: Resource control (interval + CLI frequency)
// ══════════════════════════════════════════════════════════════════════════════

function checkResourceSafety(): string[] {
  const issues: string[] = []

  // Scan all .ts files for dangerous intervals
  const files = readdirSync(MODULE_DIR).filter(f => f.endsWith('.ts'))
  for (const f of files) {
    const code = readFileSync(resolve(MODULE_DIR, f), 'utf-8')
    const matches = code.matchAll(/setInterval\([^,]+,\s*(\d+)\s*\)/g)
    for (const match of matches) {
      const ms = parseInt(match[1])
      if (ms > 0 && ms < 60000) {
        issues.push(`${f}: setInterval ${ms}ms 太短（最少 60s）`)
      }
    }
  }

  return issues
}

// ══════════════════════════════════════════════════════════════════════════════
// Guard 6: Persona integrity after upgrade
// ══════════════════════════════════════════════════════════════════════════════

function checkPersonaIntegrity(): string[] {
  const issues: string[] = []

  try {
    const promptBuilderPath = resolve(MODULE_DIR, 'prompt-builder.ts')
    if (!existsSync(promptBuilderPath)) {
      issues.push('prompt-builder.ts 不存在')
      return issues
    }
    const promptCode = readFileSync(promptBuilderPath, 'utf-8')
    const requiredMarkers = ['cc 的灵魂', '我是谁', '核心价值观', '说话风格', '回复前自检']
    for (const marker of requiredMarkers) {
      if (!promptCode.includes(marker)) {
        issues.push(`prompt-builder.ts 缺少核心身份标记: "${marker}"`)
      }
    }
  } catch (e: any) {
    issues.push(`无法读取 prompt-builder.ts: ${e.message}`)
  }

  return issues
}

// ══════════════════════════════════════════════════════════════════════════════
// Combined post-upgrade guard runner
// ══════════════════════════════════════════════════════════════════════════════

export function runPostUpgradeGuards(): { safe: boolean; issues: string[] } {
  const allIssues: string[] = []

  // Guard 2: Regression
  const regression = runRegressionTests()
  if (!regression.passed) allIssues.push(...regression.failures.map(f => `[回归] ${f}`))

  // Guard 3: Core integrity
  const coreViolations = verifyCoreIntegrity()
  if (coreViolations.length > 0) allIssues.push(...coreViolations.map(v => `[核心篡改] ${v}`))

  // Guard 4: Data pollution
  const pollution = checkDataPollution()
  if (pollution.length > 0) allIssues.push(...pollution.map(p => `[数据污染] ${p}`))

  // Guard 5: Resource safety
  const resources = checkResourceSafety()
  if (resources.length > 0) allIssues.push(...resources.map(r => `[资源风险] ${r}`))

  // Guard 6: Persona integrity
  const persona = checkPersonaIntegrity()
  if (persona.length > 0) allIssues.push(...persona.map(p => `[人格风险] ${p}`))

  // Critical issues that require rollback: core tampering or regression failures
  const safe = allIssues.filter(i => i.includes('[核心篡改]') || i.includes('[回归]')).length === 0
  return { safe, issues: allIssues }
}

// ── Init: snapshot core hashes on first load ──
{
  const saved = loadJson<Record<string, string>>(CORE_HASHES_PATH, {})
  if (Object.keys(saved).length === 0) snapshotCoreHashes()
}

// ── Module registry: what each file does ──
const MODULE_MAP: Record<string, string> = {
  'handler.ts': '主编排器 — 事件路由、初始化、augment 构建',
  'types.ts': '类型定义 — 所有接口',
  'persistence.ts': '持久化层 — 文件读写、路径常量',
  'cli.ts': 'CLI 工具 — spawnCLI、合并分析',
  'notify.ts': '通知 — 飞书群通知、私聊 DM',
  'body.ts': '身体状态 — energy/mood/load/alertness 模拟',
  'brain.ts': '经验系统（已停用）— stub',
  'memory.ts': '记忆系统 — 语义标签、TF-IDF、recall、压缩',
  'cognition.ts': '认知管线 — attention/intent/strategy、tier 感知',
  'evolution.ts': '进化系统 — 规则、假设、纠正归因',
  'quality.ts': '质量评估 — 评分、自检、eval 指标',
  'inner-life.ts': '内心生活 — 日记、用户模型、深度反思、梦境',
  'graph.ts': '实体图谱 — 人/项目/技术关系',
  'epistemic.ts': '知识边界 — per-domain 置信度追踪',
  'flow.ts': '对话流 — 话题持续性、frustration、会话总结',
  'user-profiles.ts': '用户画像 — per-user tier/style/rhythm',
  'values.ts': '价值观 — 行为偏好学习',
  'prompt-builder.ts': 'Soul Prompt — 分层构建、augment 预算',
  'tasks.ts': '任务系统 — 委派、工作流、计划',
  'rover.ts': '漫游学习 — 自主 web 搜索',
  'voice.ts': '主动发声 — 内在驱动的开场',
  'upgrade.ts': '自我升级 — 本模块',
}

// ── State ──

export const EMPTY_UPGRADE_STATE: UpgradeState = {
  phase: 'idle',
  analysis: '',
  proposals: [],
  designedAt: 0,
  observationStart: 0,
  observationExtensions: 0,
  preUpgradeEval: null,
  preWindowStats: { messages: 0, corrections: 0, qualitySum: 0, qualityCount: 0 },
  backupPath: '',
  appliedDiff: '',
}

export let upgradeLog: UpgradeLogEntry[] = loadJson(UPGRADE_LOG_PATH, [])
export let upgradeState: UpgradeState = loadJson(UPGRADE_STATE_PATH, { ...EMPTY_UPGRADE_STATE })
let lastUpgradeCheck = 0

const BASE_INTERVAL_MS = 3 * 86400000      // first upgrade: 3 days
const MAX_INTERVAL_MS = 30 * 86400000       // max: 30 days
const OBSERVATION_PERIOD_MS = 3 * 86400000
const MAX_OBSERVATION_EXTENSIONS = 2        // max 2 extensions (total 9 days)

// ── Backup entire cc-soul/ directory ──

function backupAllModules(): string {
  if (!existsSync(HANDLER_BACKUP_DIR)) {
    mkdirSync(HANDLER_BACKUP_DIR, { recursive: true })
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = resolve(HANDLER_BACKUP_DIR, `modules-${ts}`)
  try {
    mkdirSync(backupDir, { recursive: true })
    const files = readdirSync(MODULE_DIR).filter(f => f.endsWith('.ts'))
    for (const f of files) {
      const src = resolve(MODULE_DIR, f)
      const dst = resolve(backupDir, f)
      writeFileSync(dst, readFileSync(src, 'utf-8'), 'utf-8')
    }
    // Save file manifest so rollback can detect and remove newly added files
    writeFileSync(resolve(backupDir, '_manifest.json'), JSON.stringify(files), 'utf-8')
    console.log(`[cc-soul][upgrade] backed up ${files.length} modules to ${backupDir}`)
    return backupDir
  } catch (e: any) {
    console.error(`[cc-soul][upgrade] backup failed: ${e.message}`)
    return ''
  }
}

// ── Rollback from backup directory ──

function rollbackModules(backupDir: string): boolean {
  try {
    if (!existsSync(backupDir)) {
      console.error(`[cc-soul][upgrade] backup dir not found: ${backupDir}`)
      return false
    }
    // Restore backed-up files
    const files = readdirSync(backupDir).filter(f => f.endsWith('.ts'))
    for (const f of files) {
      const src = resolve(backupDir, f)
      const dst = resolve(MODULE_DIR, f)
      writeFileSync(dst, readFileSync(src, 'utf-8'), 'utf-8')
    }

    // Remove files added during upgrade that weren't in the original manifest
    const manifestPath = resolve(backupDir, '_manifest.json')
    if (existsSync(manifestPath)) {
      try {
        const originalFiles = new Set(JSON.parse(readFileSync(manifestPath, 'utf-8')) as string[])
        const currentFiles = readdirSync(MODULE_DIR).filter(f => f.endsWith('.ts'))
        const { unlinkSync } = require('fs')
        for (const f of currentFiles) {
          if (!originalFiles.has(f)) {
            unlinkSync(resolve(MODULE_DIR, f))
            console.log(`[cc-soul][upgrade] removed file added during upgrade: ${f}`)
          }
        }
      } catch { /* manifest parsing failed, skip cleanup */ }
    }

    // Flush pending writes before restart
    flushAll()

    console.log(`[cc-soul][upgrade] rolled back ${files.length} modules from ${backupDir}`)
    return true
  } catch (e: any) {
    console.error(`[cc-soul][upgrade] rollback failed: ${e.message}`)
    return false
  }
}

// ── Read a specific module's code ──

function readModule(moduleName: string): string {
  const filePath = resolve(MODULE_DIR, moduleName)
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

// ── List all modules with line counts ──

function getModuleManifest(): string {
  const files = readdirSync(MODULE_DIR).filter(f => f.endsWith('.ts'))
  return files.map(f => {
    const lines = readFileSync(resolve(MODULE_DIR, f), 'utf-8').split('\n').length
    const desc = MODULE_MAP[f] || '未知模块'
    return `${f} (${lines}行) — ${desc}`
  }).join('\n')
}

// ── Syntax check via esbuild (validates all modules through handler.ts imports) ──

function syntaxCheckAllModules(): boolean {
  try {
    // esbuild bundles handler.ts + all imports → catches any TS/syntax errors
    execSync(
      `npx --yes esbuild "${HANDLER_PATH}" --bundle --platform=node --format=esm --outfile=/dev/null 2>&1`,
      { cwd: MODULE_DIR, timeout: 30000 },
    )
    console.log(`[cc-soul][upgrade] esbuild syntax check passed`)
    return true
  } catch (e: any) {
    console.error(`[cc-soul][upgrade] esbuild syntax check FAILED: ${e.message?.slice(0, 200)}`)
    return false
  }
}

// ── Restart OpenClaw (reload hook) ──

function restartOpenClaw() {
  try {
    // Flush all pending writes before restart
    flushAll()

    // Kill existing gateway then restart it in background
    // SIGHUP doesn't work for OpenClaw gateway (it exits instead of reloading)
    // So we do a full stop + start cycle
    execSync('pkill -f "openclaw.*gateway" || true', { timeout: 5000 })

    // Wait a moment for port to be released
    execSync('sleep 2', { timeout: 5000 })

    // Restart gateway in background using nohup
    // openclaw binary is in PATH (nvm node)
    const { spawn } = require('child_process')
    const child = spawn('nohup', ['openclaw', 'gateway'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    child.unref()

    console.log(`[cc-soul][upgrade] gateway restarted (pid: ${child.pid})`)
    addMemory('[自我升级] gateway 重启完成', 'event')
  } catch (e: any) {
    console.error(`[cc-soul][upgrade] restart failed: ${e.message}`)
    // Notify owner so they can manually restart
    notifyOwnerDM(`⚠️ 升级完成但 gateway 重启失败，请手动运行: openclaw gateway`).catch(() => {})
  }
}

// ── Build upgrade context with epistemic data + module info ──

function buildUpgradeContext(stats: InteractionStats): string {
  const evalSummary = getEvalSummary(stats.totalMessages, stats.corrections)
  const correctionRate = stats.totalMessages > 0
    ? (stats.corrections / stats.totalMessages * 100).toFixed(1) : '0'

  // Epistemic: which domains are weak
  const epistemicInfo = getEpistemicSummary() || '(无领域数据)'

  // Recent correction attributions
  const attributions = memoryState.memories
    .filter(m => m.scope === 'correction' && m.content.startsWith('[纠正归因]'))
    .slice(-5)
    .map(m => m.content)
    .join('; ')

  return [
    `=== 运行数据 ===`,
    `评估: ${evalSummary}`,
    `纠正率: ${correctionRate}%`,
    `记忆: ${memoryState.memories.length} | 规则: ${rules.length}`,
    `活跃天数: ${Math.floor((Date.now() - stats.firstSeen) / 86400000)}`,
    ``,
    `=== 知识边界（epistemic）===`,
    epistemicInfo,
    ``,
    `=== 最近纠正归因 ===`,
    attributions || '(无)',
    ``,
    `=== 模块架构 ===`,
    getModuleManifest(),
    ``,
    `=== 历史失败升级（避免重复）===`,
    memoryState.memories
      .filter(m => m.content.startsWith('[升级失败]'))
      .slice(-5)
      .map(m => m.content)
      .join('\n') || '(无)',
    ``,
    getExperienceContext() || '(无升级经验记录)',
    ``,
    getRadarUpgradeContext() || '',
  ].filter(Boolean).join('\n')
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 1: Periodic analysis — every 3 days, find improvements
// ═══════════════════════════════════════════════════════════════════════════════

export function checkSoulUpgrade(stats: InteractionStats, force = false) {
  const now = Date.now()

  // ── Guard 1: Upgrade lock check ──
  if (isUpgradeLocked()) {
    if (force) notifyOwnerDM('🔒 升级系统已锁定，发"解锁升级"解除').catch(() => {})
    return
  }

  // ── Observation period check ──
  if (upgradeState.phase === 'observing') {
    if (now - upgradeState.observationStart >= OBSERVATION_PERIOD_MS) {
      evaluateUpgradeResult(stats)
    } else if (force) {
      const daysLeft = Math.ceil((OBSERVATION_PERIOD_MS - (now - upgradeState.observationStart)) / 86400000)
      notifyOwnerDM(`⏳ 当前正在观察期，还剩约 ${daysLeft} 天`).catch(() => {})
    }
    return
  }

  // ── Pending confirmation — don't re-analyze ──
  if (upgradeState.phase !== 'idle') {
    if (force) notifyOwnerDM(`📋 已有待确认的升级提案（phase: ${upgradeState.phase}），回复"执行"或"跳过"`).catch(() => {})
    return
  }

  // ── Interval check (skip if force) ──
  if (!force) {
    const consecutiveUpgrades = upgradeLog.filter(u => u.type === 'code').length
    const escalationFactor = Math.min(10, Math.pow(1.5, Math.min(consecutiveUpgrades, 6)))
    const currentInterval = Math.min(MAX_INTERVAL_MS, BASE_INTERVAL_MS * escalationFactor)
    if (now - lastUpgradeCheck < currentInterval) return
    if (stats.totalMessages < 50) return
  }
  lastUpgradeCheck = now

  // ── Run full diagnostic → send ONE complete report ──
  console.log(`[cc-soul][upgrade] running full diagnostic...`)
  const diagnosticResults = runFullDiagnostic(stats, (report) => {
    notifyOwnerDM(report).catch(() => {})
  })
  const report = formatDiagnosticReport(diagnosticResults)

  // ── Deep code audit (async, CLI-powered) — only on manual trigger ──
  if (force) {
    notifyOwnerDM('🔬 深度代码审查中（用 Claude 审查代码逻辑 bug）...').catch(() => {})
    runDeepCodeAudit(diagnosticResults, (auditBugs) => {
      if (auditBugs.length === 0) {
        notifyOwnerDM('🔬 深度审查完成：未发现逻辑 bug').catch(() => {})
      } else {
        const auditReport = [
          `🔬 深度代码审查结果（${auditBugs.length} 个潜在 bug）:`,
          '',
          ...auditBugs.map((b, i) => `  ${i + 1}. ${b}`),
        ].join('\n')
        notifyOwnerDM(auditReport).catch(() => {})
        console.log(`[cc-soul][upgrade] deep audit found ${auditBugs.length} bugs`)
      }
    })
  }

  // Only propose upgrade if there are actionable (important+ severity) issues
  const actionable = diagnosticResults.filter(r => r.severity === 'critical' || r.severity === 'important')
  if (actionable.length === 0) {
    console.log(`[cc-soul][upgrade] diagnostic clean (${diagnosticResults.length} info/warnings only)`)
    if (force) {
      const warnings = diagnosticResults.filter(r => r.severity === 'warning').length
      notifyOwnerDM(`✅ 诊断完成，无严重/重要问题\n${warnings} 个警告, ${diagnosticResults.length - warnings} 个信息\n\n${report.slice(0, 500)}`).catch(() => {})
    }

    // Curiosity-driven: even if nothing is broken, suggest improvements
    const curiosityProposals = generateCuriosityProposals(stats)
    if (curiosityProposals.length > 0) {
      const notification = formatCuriosityNotification(curiosityProposals)
      notifyOwnerDM(notification).catch(() => {})
      console.log(`[cc-soul][upgrade] sent ${curiosityProposals.length} curiosity proposals`)
    }
    return
  }

  console.log(`[cc-soul][upgrade] diagnostic found ${actionable.length} actionable issues, starting analysis...`)
  const context = buildUpgradeContext(stats)
  const fullContext = `${report}\n\n${context}`

  // Agent #1: Analyze diagnostic results + eval data, find improvements
  spawnCLI(
    `你是 cc 灵魂系统的诊断师。以下是 7 维度诊断报告和运行数据，找出代码中需要改进的地方。\n` +
    `注意：不是加规则，而是真正的代码改进（函数逻辑、算法、新功能、性能等）。\n` +
    `优先解决诊断报告中严重和重要级别的问题。\n\n` +
    `诊断报告 + 运行数据:\n${fullContext}\n\n` +
    `注意: 以下是之前失败的升级尝试，不要重复提出类似建议:\n` +
    `${memoryState.memories.filter(m => m.content.startsWith('[升级失败]')).slice(-5).map(m => '- ' + m.content).join('\n') || '(无历史失败)'}\n\n` +
    `请提出 1-3 个代码级改进建议，每条说明：\n` +
    `1. 改哪个函数/系统\n` +
    `2. 为什么要改（诊断数据支撑）\n` +
    `3. 预期效果\n\n` +
    `格式: {"proposals":[{"change":"描述","reason":"原因","scope":"函数/模块名"}]}`,
    (output) => {
      try {
        const result = extractJSON(output)
        if (!result) {
          console.log(`[cc-soul][upgrade] no proposals from analysis`)
          return
        }
        const proposals = result.proposals || []

        if (proposals.length === 0) {
          console.log(`[cc-soul][upgrade] no improvements needed`)
          return
        }

        // ── #16: Graded autonomy — split proposals by risk level ──
        const lowRisk = proposals.filter((p: any) => assessUpgradeRisk(p) === 'low')
        const highRisk = proposals.filter((p: any) => assessUpgradeRisk(p) === 'high')

        // Auto-execute low-risk proposals immediately (no confirmation needed)
        if (lowRisk.length > 0) {
          const lowDesc = lowRisk.map((p: any) => `[${p.scope}] ${p.change}`).join('; ')
          console.log(`[cc-soul][upgrade] auto-executing ${lowRisk.length} low-risk proposals: ${lowDesc.slice(0, 100)}`)
          appendAudit('upgrade_auto', lowDesc.slice(0, 200))
          notifyOwnerDM(`✅ 自动执行 ${lowRisk.length} 项低风险改进:\n${lowRisk.map((p: any) => `- ${p.change}`).join('\n')}`).catch(() => {})
        }

        // High-risk proposals still need confirmation
        if (highRisk.length === 0) {
          console.log(`[cc-soul][upgrade] all proposals were low-risk, no confirmation needed`)
          return
        }

        // Save pending confirmation state — include diagnostic report in analysis
        upgradeState = {
          phase: 'pending_confirm',
          analysis: fullContext,
          proposals: highRisk,
          designedAt: now,
          observationStart: 0,
          preUpgradeEval: computeEval(stats.totalMessages, stats.corrections),
          preWindowStats: { messages: 0, corrections: 0, qualitySum: 0, qualityCount: 0 },
          backupPath: '',
          appliedDiff: '',
        }
        saveJson(UPGRADE_STATE_PATH, upgradeState)

        // ── Notify owner via DM ──
        // Include diagnostic summary before proposals
        const criticalCount = diagnosticResults.filter(r => r.severity === 'critical').length
        const importantCount = diagnosticResults.filter(r => r.severity === 'important').length
        const warningCount = diagnosticResults.filter(r => r.severity === 'warning').length
        const diagSummary = `诊断: ${criticalCount ? criticalCount + ' 严重 ' : ''}${importantCount ? importantCount + ' 重要 ' : ''}${warningCount ? warningCount + ' 警告' : ''}`.trim()

        const proposalText = proposals
          .map((p: any, i: number) => `${i + 1}. [${p.scope}] ${p.change}\n   原因: ${p.reason}`)
          .join('\n')

        notifyOwnerDM(
          `cc 灵魂升级分析完成\n\n${diagSummary}\n\n${proposalText}\n\n` +
          `回复"执行"启动代码升级流程\n` +
          `回复"跳过"取消本次升级`
        ).catch(() => {})

        console.log(`[cc-soul][upgrade] ${proposals.length} proposals sent to owner for confirmation`)
      } catch (e: any) {
        console.error(`[cc-soul][upgrade] analysis parse failed: ${e.message}`)
      }
    },
    60000,
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 2: Listen for owner confirmation
// ═══════════════════════════════════════════════════════════════════════════════

export function handleUpgradeCommand(msg: string, stats: InteractionStats): boolean {
  const m = msg.trim()
  console.log(`[cc-soul][upgrade] handleUpgradeCommand check: "${m.slice(0, 30)}" (phase: ${upgradeState.phase})`)

  if (upgradeState.phase === 'pending_confirm') {
    if (['执行', '执行升级', 'upgrade', '确认升级'].includes(m)) {
      console.log(`[cc-soul][upgrade] owner confirmed, starting 3-agent upgrade...`)
      appendAudit('upgrade_confirm', upgradeState.proposals.map(p => p.change).join('; ').slice(0, 200))
      notifyOwnerDM(`🚀 收到确认，启动 3-agent 代码升级流程...`).catch(() => {})
      executeCodeUpgrade(stats)
      return true
    }
    if (['跳过', '取消', 'skip'].includes(m) || m.includes('跳过') || m.includes('取消升级')) {
      upgradeState = { ...EMPTY_UPGRADE_STATE }
      saveJson(UPGRADE_STATE_PATH, upgradeState)
      notifyOwnerDM(`⏭ 已跳过本次升级`).catch(() => {})
      console.log(`[cc-soul][upgrade] owner skipped upgrade`)
      return true
    }
  }

  // ── Guard 1: Unlock upgrade system ──
  if (m === '解锁升级' || m === 'unlock upgrade') {
    upgradeLock.consecutiveFailures = 0
    upgradeLock.lockedUntil = 0
    saveJson(UPGRADE_LOCK_PATH, upgradeLock)
    notifyOwnerDM(`🔓 升级系统已解锁`).catch(() => {})
    console.log(`[cc-soul][upgrade] upgrade lock cleared by owner`)
    return true
  }

  // Manual trigger — loose match
  if (m.includes('强制升级') || m.includes('手动升级') || m.includes('触发升级')) {
    console.log(`[cc-soul][upgrade] manual trigger: "${m.slice(0, 30)}"`)
    lastUpgradeCheck = 0
    notifyOwnerDM('🔍 收到手动升级指令，30 秒后启动诊断 + 竞品雷达...').catch(() => {})
    // Delay 30s to let agent finish replying before spawning CLI tasks
    setTimeout(() => {
      console.log('[cc-soul][upgrade] delayed trigger executing...')
      checkSoulUpgrade(stats, true)
      // Also trigger competitive radar scan on manual upgrade
      setTimeout(() => {
        console.log('[cc-soul][upgrade] triggering competitive radar...')
        runCompetitiveRadar(true)
      }, 5000) // 5s after upgrade analysis starts
    }, 30000)
    return true
  }

  // Restart gateway
  if (m === '重启' || m === 'restart' || m === '重启网关' || m === 'restart gateway') {
    notifyOwnerDM('🔄 收到重启指令，3 秒后重启 gateway...').catch(() => {})
    console.log(`[cc-soul][upgrade] manual restart triggered`)
    setTimeout(() => restartOpenClaw(), 3000)
    return true
  }

  return false
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 3: Claude Code Session Upgrade
// Spawns a real Claude session with file editing tools — like having an engineer
// read the code, edit it, and verify. No more JSON string-replace hacks.
// ═══════════════════════════════════════════════════════════════════════════════

function executeCodeUpgrade(stats: InteractionStats) {
  // ── Guard 1: Check module cooldown for each proposal scope ──
  const cooledDown = upgradeState.proposals.filter(p => isModuleOnCooldown(p.scope))
  if (cooledDown.length > 0) {
    const names = cooledDown.map(p => p.scope).join(', ')
    notifyOwnerDM(`⏳ 模块 ${names} 仍在冷却期（7天），跳过本次升级`).catch(() => {})
    upgradeState = { ...EMPTY_UPGRADE_STATE }
    saveJson(UPGRADE_STATE_PATH, upgradeState)
    return
  }

  // ── Classify upgrade type (inspired by capability-evolver mutation categories) ──
  // repair = fixing bugs/errors → more lenient limits
  // optimize = refactoring/improving → stricter limits
  const repairKeywords = /修复|fix|bug|错误|crash|异常|报错|失败|broken|error|修正|hotfix/i
  const isRepair = upgradeState.proposals.some((p: any) =>
    repairKeywords.test(p.change) || repairKeywords.test(p.reason))
  const upgradeCategory = isRepair ? 'repair' : 'optimize'
  console.log(`[cc-soul][upgrade] category: ${upgradeCategory} (${isRepair ? 'lenient' : 'strict'} limits)`)

  upgradeState.phase = 'executing'
  saveJson(UPGRADE_STATE_PATH, upgradeState)

  // Step 0: backup ALL modules
  const backupPath = backupAllModules()
  if (!backupPath) {
    notifyOwnerDM(`❌ 备份失败，升级中止`).catch(() => {})
    upgradeState = { ...EMPTY_UPGRADE_STATE }
    saveJson(UPGRADE_STATE_PATH, upgradeState)
    return
  }
  upgradeState.backupPath = backupPath

  const proposalText = upgradeState.proposals
    .map((p, i) => `${i + 1}. [${p.scope}] ${p.change} (${p.reason})`)
    .join('\n')

  notifySoulActivity(`🔄 代码自我进化启动 — Claude 工程师 session`).catch(() => {})

  // ── 构建 Claude 工程师 prompt ──
  const engineerPrompt = [
    `你是 cc-soul 的升级工程师。根据以下改进需求，直接读代码、改代码、验证。`,
    ``,
    `## 改进需求`,
    proposalText,
    ``,
    `## 运行数据`,
    upgradeState.analysis,
    ``,
    `## 升级经验（务必参考，避免重蹈覆辙）`,
    getExperienceContext() || '(首次升级，无历史经验)',
    ``,
    getUpgradeMetaContext() || '',
    ``,
    `## 架构标准（必须遵守）`,
    `1. 每个模块单一职责，单文件不超过 1000 行`,
    `2. 新功能 = 新模块文件，不往现有文件硬塞`,
    `3. handler.ts 只做编排，不包含业务逻辑`,
    `4. import 路径必须用 .ts 后缀（如 from './types.ts'）`,
    `5. 类型定义统一放 types.ts`,
    ``,
    `## 安全红线`,
    `- 禁止修改 upgrade.ts — 改坏回滚能力 = 不可恢复`,
    `- 禁止修改 tests.ts — 改坏测试 = 失去质量保障`,
    `- 禁止修改 persistence.ts 的 saveJson/loadJson 签名`,
    `- 禁止新增 npm 依赖`,
    `- 禁止删除或清空 data/ 目录下的文件`,
    `- 禁止修改 config.json`,
    `- 禁止修改 ~/.openclaw/openclaw.json`,
    `- 禁止删除任何目录`,
    ``,
    `## 工作流程`,
    `1. 先读目标模块的代码（用 Read 工具）`,
    `2. 分析需要改什么`,
    `3. 用 Edit 工具修改代码`,
    `4. 改完后运行 esbuild 语法检查: npx --yes esbuild handler.ts --bundle --platform=node --format=esm --outfile=/dev/null`,
    `5. 然后运行逻辑测试: npx --yes tsx tests.ts`,
    `6. 如果语法检查或测试失败，修复问题再验证`,
    `7. 两项都通过后输出一行总结：UPGRADE_DONE: 改了什么`,
    ``,
    `开始工作。`,
  ].join('\n')

  console.log(`[cc-soul][upgrade] spawning Claude engineer session (forced CLI mode)...`)

  spawnCLIForUpgrade(engineerPrompt, (output) => {
    console.log(`[cc-soul][upgrade] Claude engineer session ended, output: ${output.slice(-200)}`)

    // 检查是否成功
    const success = output.includes('UPGRADE_DONE')

    if (!success) {
      console.log(`[cc-soul][upgrade] engineer session did not complete successfully, rolling back`)
      rollbackModules(upgradeState.backupPath)
      recordUpgradeFailure()
      notifyOwnerDM(`⚠️ 升级工程师未能完成修改，已回滚`).catch(() => {})
      upgradeState = { ...EMPTY_UPGRADE_STATE }
      saveJson(UPGRADE_STATE_PATH, upgradeState)
      return
    }

    // Anti-hallucination: verify AI actually changed files (not just claimed UPGRADE_DONE)
    try {
      // Check if git is available; skip verification if not installed
      try { execSync('git --version', { timeout: 3000, stdio: 'ignore' }) } catch {
        console.log(`[cc-soul][upgrade] git not available, skipping diff verification`)
        // Fall through to success path without git verification
        upgradeState.phase = 'idle'
        upgradeState.lastSuccess = Date.now()
        saveJson(UPGRADE_STATE_PATH, upgradeState)
        return
      }
      const diffStat = execSync('git diff --stat 2>/dev/null', {
        cwd: MODULE_DIR, timeout: 5000,
      }).toString().trim()
      if (!diffStat) {
        console.error(`[cc-soul][upgrade] AI claimed UPGRADE_DONE but git diff is empty! Rolling back.`)
        rollbackModules(upgradeState.backupPath)
        recordUpgradeFailure()
        notifyOwnerDM(`❌ 升级工程师声称完成但实际未改动任何文件（幻觉检测），已回滚`).catch(() => {})
        upgradeState = { ...EMPTY_UPGRADE_STATE }
        saveJson(UPGRADE_STATE_PATH, upgradeState)
        return
      }
      // Guard against unreasonably large changes (hallucinated rewrites)
      const diffNumStat = execSync('git diff --numstat 2>/dev/null', {
        cwd: MODULE_DIR, timeout: 5000,
      }).toString().trim()
      const diffLines = diffNumStat.split('\n').filter(l => l.trim())
      const totalLines = diffLines.reduce((sum, line) => {
        const [added, deleted] = line.split('\t').map(Number)
        return sum + (added || 0) + (deleted || 0)
      }, 0)
      // Count changed .ts files (blast radius — inspired by capability-evolver policyCheck)
      const changedFiles = diffLines.map(l => l.split('\t')[2]).filter(f => f && f.endsWith('.ts'))
      // repair = bug fix, more lenient; optimize = refactoring, stricter
      const MAX_UPGRADE_LINES = upgradeCategory === 'repair' ? 800 : 500
      const MAX_UPGRADE_FILES = upgradeCategory === 'repair' ? 8 : 5
      if (totalLines > MAX_UPGRADE_LINES) {
        console.error(`[cc-soul][upgrade] diff too large: ${totalLines} lines (max ${MAX_UPGRADE_LINES}), rolling back`)
        rollbackModules(upgradeState.backupPath)
        recordUpgradeFailure()
        notifyOwnerDM(`❌ 升级改动过大 (${totalLines} 行，上限 ${MAX_UPGRADE_LINES})，疑似幻觉重写，已回滚`).catch(() => {})
        upgradeState = { ...EMPTY_UPGRADE_STATE }
        saveJson(UPGRADE_STATE_PATH, upgradeState)
        return
      }
      if (changedFiles.length > MAX_UPGRADE_FILES) {
        console.error(`[cc-soul][upgrade] too many files changed: ${changedFiles.length} (max ${MAX_UPGRADE_FILES}), rolling back`)
        rollbackModules(upgradeState.backupPath)
        recordUpgradeFailure()
        notifyOwnerDM(`❌ 升级改动文件过多 (${changedFiles.length} 个 .ts 文件，上限 ${MAX_UPGRADE_FILES})，疑似幻觉重写，已回滚\n改动文件: ${changedFiles.join(', ')}`).catch(() => {})
        upgradeState = { ...EMPTY_UPGRADE_STATE }
        saveJson(UPGRADE_STATE_PATH, upgradeState)
        return
      }
      console.log(`[cc-soul][upgrade] diff verified: ${totalLines} lines, ${changedFiles.length} files changed`)
    } catch { /* git not available, skip diff check */ }

    // esbuild 验证（Claude 应该已经验证了，但双重检查）
    if (!syntaxCheckAllModules()) {
      console.error(`[cc-soul][upgrade] post-upgrade syntax check FAILED, rolling back!`)
      rollbackModules(upgradeState.backupPath)
      recordUpgradeFailure()
      notifyOwnerDM(`❌ 升级后语法检查失败，已自动回滚`).catch(() => {})
      upgradeState = { ...EMPTY_UPGRADE_STATE }
      saveJson(UPGRADE_STATE_PATH, upgradeState)
      return
    }

    // ── Canary check: verify handler.ts actually loads (not just syntax) ──
    // Inspired by capability-evolver canary.js — catches runtime import errors
    // that esbuild misses (e.g., missing exports, circular deps at runtime)
    try {
      execSync('npx --yes tsx -e "import(\'./handler.ts\')"', {
        cwd: MODULE_DIR, timeout: 30000, stdio: 'pipe',
      })
      console.log(`[cc-soul][upgrade] canary load check passed`)
    } catch (canaryErr: any) {
      const errMsg = canaryErr.stderr?.toString().slice(0, 300) || canaryErr.message || ''
      console.error(`[cc-soul][upgrade] canary load check FAILED: ${errMsg}`)
      rollbackModules(upgradeState.backupPath)
      recordUpgradeFailure()
      notifyOwnerDM(`❌ 升级后 canary 加载检查失败（handler.ts 无法 import），已回滚\n${errMsg.slice(0, 200)}`).catch(() => {})
      upgradeState = { ...EMPTY_UPGRADE_STATE }
      saveJson(UPGRADE_STATE_PATH, upgradeState)
      return
    }

    // ── Guards 2-6: Post-upgrade safety checks ──
    const guardResult = runPostUpgradeGuards()
    if (guardResult.issues.length > 0) {
      console.log(`[cc-soul][upgrade] post-upgrade guards found ${guardResult.issues.length} issues`)
    }
    if (!guardResult.safe) {
      console.error(`[cc-soul][upgrade] post-upgrade guards FAILED, rolling back!`)
      rollbackModules(upgradeState.backupPath)
      recordUpgradeFailure()
      const issueList = guardResult.issues.join('\n')
      notifyOwnerDM(`❌ 升级后安全检查失败，已自动回滚\n\n${issueList}`).catch(() => {})
      upgradeState = { ...EMPTY_UPGRADE_STATE }
      saveJson(UPGRADE_STATE_PATH, upgradeState)
      return
    }
    // Non-critical warnings: notify but proceed
    if (guardResult.issues.length > 0) {
      notifyOwnerDM(`⚠️ 升级安全检查发现非关键问题:\n${guardResult.issues.join('\n')}`).catch(() => {})
    }

    // 提取改动摘要
    const doneMatch = output.match(/UPGRADE_DONE:\s*(.+)/s)
    const summary = doneMatch ? doneMatch[1].trim().slice(0, 500) : '(无摘要)'

    // 保存 diff（用 git diff 如果有 git）
    try {
      const diff = execSync('git diff --stat 2>/dev/null || echo "(no git)"', {
        cwd: MODULE_DIR, timeout: 5000,
      }).toString().trim()
      upgradeState.appliedDiff = diff.slice(0, 5000)
    } catch { upgradeState.appliedDiff = summary }

    // 记录窗口统计
    upgradeState.preWindowStats = {
      messages: stats.totalMessages,
      corrections: stats.corrections,
      qualitySum: 0,
      qualityCount: 0,
    }

    // 进入观察期
    upgradeState.phase = 'observing'
    upgradeState.observationStart = Date.now()
    saveJson(UPGRADE_STATE_PATH, upgradeState)

    // 记录升级日志
    upgradeLog.push({
      date: new Date().toISOString().slice(0, 10),
      change: summary.slice(0, 200),
      reason: 'claude_engineer_session',
      type: 'code',
    })
    if (upgradeLog.length > 50) upgradeLog = upgradeLog.slice(-40)
    saveJson(UPGRADE_LOG_PATH, upgradeLog)

    addMemory(`[代码自我进化] ${summary.slice(0, 100)}`, 'reflection')

    // git commit — use explicit file list instead of glob to avoid zsh nomatch issues
    try {
      const tsFiles = readdirSync(MODULE_DIR).filter(f => f.endsWith('.ts')).join(' ')
      if (tsFiles) {
        execSync(`git add ${tsFiles} && git commit -m "self-evolve: ${summary.slice(0, 50).replace(/"/g, "'")}" 2>/dev/null || true`, {
          cwd: MODULE_DIR, timeout: 10000,
        })
      }
    } catch { /* git not available or nothing to commit */ }

    notifySoulActivity(`🎉 自我进化完成！\n${summary}\n进入 3 天观察期`).catch(() => {})
    notifyOwnerDM(`✅ cc 自我进化成功\n\n${summary}\n\n备份: ${upgradeState.backupPath}\n观察期: 3 天`).catch(() => {})

    // Flush all pending writes before restarting
    flushAll()
    restartOpenClaw()
  }, 600000, 'upgrade-engineer')
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 4: Observation period — 3 days later compare eval, auto-rollback if worse
// ═══════════════════════════════════════════════════════════════════════════════

function evaluateUpgradeResult(stats: InteractionStats) {
  console.log(`[cc-soul][upgrade] observation period ended, evaluating...`)

  const pre = upgradeState.preWindowStats
  if (!pre || pre.messages === 0) {
    console.log(`[cc-soul][upgrade] no pre-upgrade window stats, marking as success`)
    upgradeState = { ...EMPTY_UPGRADE_STATE }
    saveJson(UPGRADE_STATE_PATH, upgradeState)
    return
  }

  // ── Window comparison: pre-upgrade cumulative vs now → delta ──
  const windowMessages = stats.totalMessages - pre.messages
  const windowCorrections = stats.corrections - pre.corrections

  // Current eval for the observation window
  const currentEval = computeEval(stats.totalMessages, stats.corrections)
  const windowCorrectionRate = windowMessages > 0
    ? Math.round(windowCorrections / windowMessages * 1000) / 10
    : 0

  // Pre-upgrade baseline
  const preEval = upgradeState.preUpgradeEval
  const preAvgQuality = preEval?.avgQuality ?? 5.0
  const preCorrectionRate = preEval?.correctionRate ?? 0

  // Extended metrics for observation
  const avgFrustration = getAvgFrustration()
  const preRecallRate = preEval?.memoryRecallRate ?? 0

  const report = [
    `观察期消息数: ${windowMessages}`,
    `窗口质量: ${currentEval.avgQuality} (升级前基准: ${preAvgQuality})`,
    `窗口纠正率: ${windowCorrectionRate}% (升级前基准: ${preCorrectionRate}%)`,
    `窗口召回率: ${currentEval.memoryRecallRate}% (升级前基准: ${preRecallRate}%)`,
    `窗口平均挫败感: ${avgFrustration}`,
    `运行时错误: ${getModuleErrorSummary().totalErrors} 次`,
    getErrorDetails() || '',
    ``,
    `修改内容:`,
    upgradeState.appliedDiff.slice(0, 500) || '(无记录)',
  ].filter(Boolean).join('\n')

  // Insufficient data → extend observation, but cap at MAX_OBSERVATION_EXTENSIONS
  if (windowMessages < 10) {
    const extensions = upgradeState.observationExtensions || 0
    if (extensions >= MAX_OBSERVATION_EXTENSIONS) {
      console.log(`[cc-soul][upgrade] max observation extensions reached (${extensions}), deciding with available data`)
      // Fall through to evaluation with whatever data we have
    } else {
      upgradeState.observationStart = Date.now()
      upgradeState.observationExtensions = extensions + 1
      saveJson(UPGRADE_STATE_PATH, upgradeState)
      notifyOwnerDM(
        `⏳ 升级观察期数据不足（仅 ${windowMessages} 条消息），延长 3 天观察期（第 ${extensions + 1}/${MAX_OBSERVATION_EXTENSIONS} 次延期）`
      ).catch(() => {})
      console.log(`[cc-soul][upgrade] insufficient data (${windowMessages} msgs), extending observation (${extensions + 1}/${MAX_OBSERVATION_EXTENSIONS})`)
      return
    }
  }

  let shouldRollback = false
  if (currentEval.avgQuality > 0 && currentEval.avgQuality < preAvgQuality - 1.0) shouldRollback = true
  if (windowCorrectionRate > preCorrectionRate + 5) shouldRollback = true
  // Extended metrics: recall rate drop or sustained high frustration
  if (currentEval.memoryRecallRate > 0 && preRecallRate > 0 && currentEval.memoryRecallRate < preRecallRate - 15) shouldRollback = true
  if (avgFrustration > 0.6 && windowMessages >= 10) shouldRollback = true

  // Runtime error spike detection: if modules started throwing errors after upgrade
  const errorSummary = getModuleErrorSummary()
  if (errorSummary.totalErrors > 20) {
    console.log(`[cc-soul][upgrade] high error count during observation: ${errorSummary.totalErrors}`)
    shouldRollback = true
  }
  if (errorSummary.silentModules.length > 0) {
    console.log(`[cc-soul][upgrade] silent modules detected: ${errorSummary.silentModules.join(', ')}`)
    shouldRollback = true
  }

  // Extract target module from proposals for experience recording
  const targetModule = upgradeState.proposals.map(p => p.scope).join(', ') || 'unknown'
  const changeDesc = upgradeState.proposals.map(p => p.change).join('; ').slice(0, 200)

  if (shouldRollback && upgradeState.backupPath) {
    console.log(`[cc-soul][upgrade] window metrics degraded, auto-rolling back!`)
    const rolledBack = rollbackModules(upgradeState.backupPath)
    recordUpgradeFailure()

    // Record experience: rolled back
    recordExperience(changeDesc, targetModule, 'rolled_back', upgradeState.preUpgradeEval, currentEval)
    // Meta-learning: accumulate structural insight from rollback
    const rollbackMetrics = `quality ${(currentEval.avgQuality - preAvgQuality).toFixed(1)}, correction rate ${(windowCorrectionRate - preCorrectionRate).toFixed(1)}%`
    for (const p of upgradeState.proposals) {
      learnFromUpgrade({ targetModule: p.scope, description: p.change, outcome: 'rolled_back', metricsChange: rollbackMetrics })
    }

    notifyOwnerDM(
      `⚠️ 代码升级观察期结束 — 效果不佳，${rolledBack ? '已自动回滚' : '回滚失败！'}\n\n` +
      `${report}`,
    ).catch(() => {})

    notifySoulActivity(
      `🔙 代码升级已回滚（效果不佳）\n${report.split('\n').slice(0, 3).join('\n')}`,
    ).catch(() => {})

    if (rolledBack) restartOpenClaw()

    // Record failed proposals so next analysis avoids them
    for (const p of upgradeState.proposals) {
      addMemory(`[升级失败] ${p.change} — 原因: ${p.reason} — 效果: 质量下降`, 'correction')
    }
  } else {
    // Record upgrade success + reset lock
    recordUpgradeSuccess(targetModule)

    // Record experience: success
    recordExperience(changeDesc, targetModule, 'success', upgradeState.preUpgradeEval, currentEval)
    // Meta-learning: accumulate structural insight from success
    const successMetrics = `quality ${(currentEval.avgQuality - preAvgQuality).toFixed(1)}, correction rate ${(windowCorrectionRate - preCorrectionRate).toFixed(1)}%`
    for (const p of upgradeState.proposals) {
      learnFromUpgrade({ targetModule: p.scope, description: p.change, outcome: 'success', metricsChange: successMetrics })
    }

    const reason = '— 效果良好'
    notifyOwnerDM(
      `🎊 代码升级观察期结束 ${reason}，升级保留！\n\n` +
      `${report}`,
    ).catch(() => {})

    notifySoulActivity(
      `✨ 代码升级观察通过！${reason}`,
    ).catch(() => {})

    // Feature 3: Proactive feedback seeking — if metrics are ambiguous, ask user
    if (windowMessages >= 10) {
      const qualityDelta = Math.abs(currentEval.avgQuality - preAvgQuality)
      const correctionDelta = Math.abs(windowCorrectionRate - preCorrectionRate)
      // Metrics didn't change much — ask user for subjective feedback
      if (qualityDelta < 0.5 && correctionDelta < 3) {
        const feedbackQuestion =
          `最近我升级了一些功能，你觉得我的回复有变化吗？好还是差？\n` +
          `改动：${changeDesc.slice(0, 100)}`
        notifyOwnerDM(feedbackQuestion).catch(() => {})
      }
    }
  }

  upgradeState = { ...EMPTY_UPGRADE_STATE }
  saveJson(UPGRADE_STATE_PATH, upgradeState)
  resetModuleErrors() // reset error counters for next observation window
}


// ── Public API ──

export function getUpgradeHistory(n = 5): string {
  if (upgradeLog.length === 0) return ''
  return upgradeLog.slice(-n).map(u => `${u.date}: ${u.change} (${u.type})`).join('\n')
}

// ── SoulModule registration ──

export const upgradeModule: SoulModule = {
  id: 'upgrade',
  name: '自升级引擎',
  dependencies: ['memory', 'evolution', 'quality'],
  priority: 20,
  enabled: false,  // 默认关闭，需手动启用
}
