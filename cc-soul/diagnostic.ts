/**
 * diagnostic.ts — 7-dimension comprehensive health diagnostic
 *
 * Runs before upgrade proposals: scans feature health, integration quality,
 * data integrity, performance, security, scale readiness, and OpenClaw ecosystem overlap.
 * Only proposes upgrades when actionable issues exist.
 */

import type { SoulModule } from './brain.ts'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { resolve, dirname } from 'path'
import { homedir } from 'os'
import type { InteractionStats } from './types.ts'
import { memoryState } from './memory.ts'
import { rules, hypotheses } from './evolution.ts'
import { evalMetrics, computeEval, getEvalSummary } from './quality.ts'
import { getEpistemicSummary, getWeakDomains } from './epistemic.ts'
import { profiles } from './user-profiles.ts'
import { isCliDegraded, getActiveTaskStatus } from './cli.ts'
import { innerState } from './inner-life.ts'
import { graphState } from './graph.ts'
import { body } from './body.ts'
import { DATA_DIR, MODULE_DIR, CONFIG_PATH } from './persistence.ts'
import { getAllFeatures } from './features.ts'
import { getExperimentSummary, getEvolutionSummary } from './experiment.ts'
import { getMetaFeedbackSummary } from './meta-feedback.ts'

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface DiagnosticResult {
  dimension: 'feature' | 'integration' | 'data' | 'performance' | 'security' | 'scale' | 'ecosystem' | 'code' | 'upgrade-safety' | 'runtime' | 'feature-activity'
  issue: string
  severity: 'info' | 'warning' | 'important' | 'critical'
  suggestion: string
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIMENSION 1: Feature Health
// ═══════════════════════════════════════════════════════════════════════════════

function checkFeatureHealth(): DiagnosticResult[] {
  const results: DiagnosticResult[] = []

  // Memory tag coverage
  const total = memoryState.memories.length
  if (total > 0) {
    const tagged = memoryState.memories.filter(m => m.tags && m.tags.length > 0).length
    const tagRate = Math.round(tagged / total * 100)
    if (tagRate < 30) {
      results.push({ dimension: 'feature', issue: `语义标签覆盖率只有 ${tagRate}%（${tagged}/${total}）`, severity: 'warning', suggestion: '增加批量打标频率或调整 batchTagUntaggedMemories 批次大小' })
    } else if (tagRate < 50) {
      results.push({ dimension: 'feature', issue: `语义标签覆盖率 ${tagRate}%，尚可但有提升空间`, severity: 'info', suggestion: '标签覆盖率在 70% 以上召回效果最佳' })
    }
  }

  // Epistemic coverage: check if weak domains exist
  const weakDomains = getWeakDomains()
  if (weakDomains.length >= 3) {
    results.push({ dimension: 'feature', issue: `${weakDomains.length} 个薄弱领域: ${weakDomains.slice(0, 3).join(', ')}`, severity: 'important', suggestion: '通过纠正和自我挑战改善薄弱领域' })
  } else if (weakDomains.length > 0) {
    results.push({ dimension: 'feature', issue: `薄弱领域: ${weakDomains.join(', ')}`, severity: 'info', suggestion: '通过纠正和自我挑战改善薄弱领域' })
  }

  // Correction attribution distribution
  const attributions = memoryState.memories.filter(m => m.content.startsWith('[纠正归因]'))
  if (attributions.length >= 5) {
    const causes: Record<string, number> = { hallucination: 0, memory: 0, rule: 0, understanding: 0, domain: 0 }
    for (const a of attributions) {
      if (a.content.includes('幻觉')) causes.hallucination++
      if (a.content.includes('记忆误导') || a.content.includes('记忆')) causes.memory++
      if (a.content.includes('规则冲突') || a.content.includes('规则')) causes.rule++
      if (a.content.includes('理解偏差') || a.content.includes('理解')) causes.understanding++
      if (a.content.includes('领域不足') || a.content.includes('领域')) causes.domain++
    }
    const sorted = Object.entries(causes).sort((a, b) => b[1] - a[1])
    const dominant = sorted[0]
    if (dominant[1] > attributions.length * 0.4) {
      results.push({ dimension: 'feature', issue: `纠正主因集中在"${dominant[0]}"（${dominant[1]}/${attributions.length}）`, severity: 'important', suggestion: `针对性优化 ${dominant[0]} 问题` })
    }
  }

  // Rules health: too many low-hit rules = noise
  if (rules.length > 0) {
    const lowHitRules = rules.filter(r => r.hits === 0)
    if (lowHitRules.length > rules.length * 0.6 && rules.length >= 10) {
      results.push({ dimension: 'feature', issue: `${lowHitRules.length}/${rules.length} 条规则从未命中`, severity: 'warning', suggestion: '清理无效规则，减少 prompt 噪音' })
    }
  }

  // Hypothesis validation lag
  if (hypotheses.length > 0) {
    const staleHypotheses = hypotheses.filter(h => h.status === 'active' && h.evidence_for + h.evidence_against < 3)
    if (staleHypotheses.length > hypotheses.length * 0.5 && hypotheses.length >= 5) {
      results.push({ dimension: 'feature', issue: `${staleHypotheses.length}/${hypotheses.length} 条假设证据不足`, severity: 'info', suggestion: '考虑清理长期未验证的假设' })
    }
  }

  // Expired memory ratio
  const expired = memoryState.memories.filter(m => m.scope === 'expired').length
  if (total > 0 && expired > total * 0.3) {
    results.push({ dimension: 'feature', issue: `过期记忆占比 ${Math.round(expired / total * 100)}%（${expired}/${total}）`, severity: 'warning', suggestion: '执行记忆压缩，物理删除过期条目以释放空间' })
  }

  return results
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIMENSION 2: Feature Integration
// ═══════════════════════════════════════════════════════════════════════════════

function checkFeatureIntegration(): DiagnosticResult[] {
  const results: DiagnosticResult[] = []
  const features = getAllFeatures()


  // Check if correction rules actually reduce correction rate
  if (rules.length > 20) {
    const highHitRules = rules.filter(r => r.hits >= 5)
    if (highHitRules.length === 0) {
      results.push({ dimension: 'integration', issue: `${rules.length} 条规则中没有高命中（>=5次）的规则`, severity: 'warning', suggestion: '规则可能与实际对话场景脱节，考虑基于近期纠正重新生成' })
    }
  }

  // Memory consolidation: check if enabled when memory count is high
  if (memoryState.memories.length > 500 && !features['memory_consolidation']) {
    results.push({ dimension: 'integration', issue: `记忆数量 ${memoryState.memories.length}，但压缩合并功能未启用`, severity: 'warning', suggestion: '启用 memory_consolidation 防止记忆膨胀' })
  }

  // Core memory: check if it's being utilized
  if (features['memory_core']) {
    const coreMemories = memoryState.memories.filter(m => m.scope === 'consolidated' || m.emotion === 'important')
    if (coreMemories.length === 0 && memoryState.memories.length > 100) {
      results.push({ dimension: 'integration', issue: 'core memory 已启用但没有高价值记忆被提升', severity: 'info', suggestion: '检查 autoPromoteToCoreMemory 的触发条件' })
    }
  }

  // Entity graph utilization
  if (graphState.entities.length > 50 && memoryState.memories.length > 200) {
    // Good integration
  } else if (graphState.entities.length === 0 && memoryState.memories.length > 100) {
    results.push({ dimension: 'integration', issue: '实体图谱为空，关系知识未被建立', severity: 'info', suggestion: '确认 entity extraction 在 post-response analysis 中正常工作' })
  }

  // Feature count vs enabled ratio
  const allFeatures = Object.entries(features)
  const enabledCount = allFeatures.filter(([, v]) => v).length
  if (allFeatures.length > 0 && enabledCount < allFeatures.length * 0.3) {
    results.push({ dimension: 'integration', issue: `只有 ${enabledCount}/${allFeatures.length} 个特性已启用`, severity: 'info', suggestion: '部分关闭的特性可能已经稳定，考虑逐步启用' })
  }

  return results
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIMENSION 3: Data Health
// ═══════════════════════════════════════════════════════════════════════════════

function checkDataHealth(): DiagnosticResult[] {
  const results: DiagnosticResult[] = []

  // Memory count
  const memCount = memoryState.memories.length
  if (memCount > 8000) {
    results.push({ dimension: 'data', issue: `记忆数量 ${memCount} 条，接近上限 (10000)`, severity: 'important', suggestion: '加速记忆压缩或迁移 SQLite' })
  } else if (memCount > 5000) {
    results.push({ dimension: 'data', issue: `记忆数量 ${memCount} 条`, severity: 'warning', suggestion: '建议开启压缩频率' })
  }

  // Check data directory size
  try {
    const dataFiles = ['memories.json', 'history.json', 'rules.json', 'stats.json', 'epistemic.json',
      'graph.json', 'hypotheses.json', 'eval.json', 'journal.json', 'user_profiles.json',
      'values.json', 'success_patterns.json', 'episodes.json', 'core_memory.json']
    let totalSize = 0
    for (const f of dataFiles) {
      const p = resolve(DATA_DIR, f)
      try {
        if (existsSync(p)) totalSize += statSync(p).size
      } catch { /* ignore */ }
    }
    const sizeMB = Math.round(totalSize / 1024 / 1024 * 10) / 10
    if (sizeMB > 50) {
      results.push({ dimension: 'data', issue: `数据目录总大小 ${sizeMB}MB`, severity: 'important', suggestion: '数据量过大会影响加载速度，迁移 SQLite 或清理过期数据' })
    } else if (sizeMB > 20) {
      results.push({ dimension: 'data', issue: `数据目录总大小 ${sizeMB}MB`, severity: 'warning', suggestion: '关注增长趋势' })
    }
  } catch { /* ignore */ }

  // Data corruption check: verify critical JSON files can be parsed
  const criticalFiles = ['memories.json', 'stats.json', 'rules.json']
  for (const f of criticalFiles) {
    const p = resolve(DATA_DIR, f)
    try {
      if (existsSync(p)) {
        const raw = readFileSync(p, 'utf-8').trim()
        if (raw.length > 0) {
          JSON.parse(raw)
        }
      }
    } catch {
      results.push({ dimension: 'data', issue: `数据文件损坏: ${f}`, severity: 'critical', suggestion: '从备份恢复或手动修复 JSON 格式' })
    }
  }

  // User profile count
  if (profiles.size > 0) {
    results.push({ dimension: 'data', issue: `${profiles.size} 个用户画像`, severity: 'info', suggestion: '' })
  }

  // History size
  if (memoryState.chatHistory.length > 80) {
    results.push({ dimension: 'data', issue: `对话历史 ${memoryState.chatHistory.length} 轮，接近上限 (100)`, severity: 'info', suggestion: '历史自动截断正常工作，但频繁截断可能丢失上下文' })
  }

  return results
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIMENSION 4: Performance
// ═══════════════════════════════════════════════════════════════════════════════

function checkPerformance(): DiagnosticResult[] {
  const results: DiagnosticResult[] = []

  // CLI degraded mode
  if (isCliDegraded()) {
    results.push({ dimension: 'performance', issue: 'CLI 处于降级模式，连续失败过多', severity: 'critical', suggestion: '检查 AI 后端连接状态，可能需要重启 gateway 或检查 API key' })
  }

  // Queue backlog
  const taskStatus = getActiveTaskStatus()
  if (taskStatus.includes('排队')) {
    const queueMatch = taskStatus.match(/排队 (\d+) 个/)
    const queueSize = queueMatch ? parseInt(queueMatch[1]) : 0
    if (queueSize >= 5) {
      results.push({ dimension: 'performance', issue: `CLI 任务队列积压 ${queueSize} 个`, severity: 'warning', suggestion: '降低后台任务频率或增加 max_concurrent' })
    }
  }

  // Body state: sustained low energy
  if (body.energy < 0.2) {
    results.push({ dimension: 'performance', issue: `能量值过低 (${body.energy.toFixed(2)})`, severity: 'warning', suggestion: 'body tick 未能恢复，检查是否有过于频繁的交互' })
  }

  // High anomaly
  if (body.anomaly > 0.5) {
    results.push({ dimension: 'performance', issue: `异常感知值偏高 (${body.anomaly.toFixed(2)})`, severity: 'warning', suggestion: '可能存在质量问题需要关注' })
  }

  // High alertness for sustained period
  if (body.alertness > 0.8) {
    results.push({ dimension: 'performance', issue: `警觉度持续偏高 (${body.alertness.toFixed(2)})`, severity: 'info', suggestion: '频繁纠正导致，回答质量需要提升' })
  }

  return results
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIMENSION 5: Security & Consistency
// ═══════════════════════════════════════════════════════════════════════════════

function checkSecurity(): DiagnosticResult[] {
  const results: DiagnosticResult[] = []

  // Check config.json not in git (if git is available)
  try {
    if (existsSync(resolve(MODULE_DIR, '.git'))) {
      // Module dir is a git repo — check that config.json is gitignored
      if (existsSync(CONFIG_PATH)) {
        const gitignorePath = resolve(MODULE_DIR, '.gitignore')
        if (existsSync(gitignorePath)) {
          const gitignore = readFileSync(gitignorePath, 'utf-8')
          if (!gitignore.includes('config.json') && !gitignore.includes('data/')) {
            results.push({ dimension: 'security', issue: 'config.json 可能未被 .gitignore 排除', severity: 'warning', suggestion: '确认 data/ 目录或 config.json 已加入 .gitignore 防止凭据泄露' })
          }
        }
      }
    }
  } catch { /* ignore */ }

  // Check for private memory leakage: private memories visible to wrong users
  const privateMemories = memoryState.memories.filter(m => m.visibility === 'private')
  const privNoUser = privateMemories.filter(m => !m.userId)
  if (privNoUser.length > 0) {
    results.push({ dimension: 'security', issue: `${privNoUser.length} 条私有记忆缺少 userId`, severity: 'warning', suggestion: '私有记忆没有 userId 无法正确隔离，可能泄露给其他用户' })
  }

  return results
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIMENSION 6: Scale Awareness
// ═══════════════════════════════════════════════════════════════════════════════

function checkScale(): DiagnosticResult[] {
  const results: DiagnosticResult[] = []

  const profileCount = profiles.size
  if (profileCount > 200) {
    results.push({ dimension: 'scale', issue: `用户数 ${profileCount}，JSON 存储将成为瓶颈`, severity: 'important', suggestion: '分冷热存储：活跃用户 JSON，不活跃用户迁移 SQLite' })
  } else if (profileCount > 50) {
    results.push({ dimension: 'scale', issue: `用户数 ${profileCount}`, severity: 'warning', suggestion: '建议准备 SQLite 迁移方案' })
  }

  const memCount = memoryState.memories.length
  if (memCount > 5000) {
    results.push({ dimension: 'scale', issue: `记忆量 ${memCount} 条，TF-IDF 和标签匹配性能可能下降`, severity: 'warning', suggestion: '考虑引入向量索引或分层存储' })
  }

  // Entity graph scale
  if (graphState.entities.length > 500) {
    results.push({ dimension: 'scale', issue: `实体图谱 ${graphState.entities.length} 个实体`, severity: 'info', suggestion: '图遍历可能变慢，考虑索引优化' })
  }

  // Rules scale
  if (rules.length >= 45) {
    results.push({ dimension: 'scale', issue: `规则数 ${rules.length}，接近上限 50`, severity: 'warning', suggestion: '评估低命中规则的清理策略' })
  }

  return results
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIMENSION 7: OpenClaw Ecosystem Check
// ═══════════════════════════════════════════════════════════════════════════════

function checkOpenClawEcosystem(): DiagnosticResult[] {
  const results: DiagnosticResult[] = []

  // Auto-detect openclaw-main path: try common locations
  const candidatePaths = [
    resolve(dirname(MODULE_DIR), '../../..'), // ../../.. from cc-soul dir
    resolve(process.env.HOME || '', 'Documents/openclaw-main'),
  ]

  let openclawRoot = ''
  for (const p of candidatePaths) {
    const pkgJson = resolve(p, 'package.json')
    if (existsSync(pkgJson)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJson, 'utf-8'))
        if (pkg.name === 'openclaw' || pkg.name?.includes('openclaw')) {
          openclawRoot = p
          break
        }
      } catch { /* ignore */ }
    }
  }

  if (!openclawRoot) return results

  // Scan skills/ for features we built ourselves
  const skillsDir = resolve(openclawRoot, 'skills')
  const extensionsDir = resolve(openclawRoot, 'extensions')

  // Feature overlap map: our feature name -> OpenClaw equivalent
  const overlapChecks: { ours: string; pattern: RegExp; category: 'skill' | 'extension' }[] = [
    { ours: 'memory', pattern: /memory/i, category: 'extension' },
    { ours: 'tts/voice', pattern: /voice|tts|speech/i, category: 'skill' },
    { ours: 'health', pattern: /health/i, category: 'skill' },
    { ours: 'diagnostics', pattern: /diagnostic/i, category: 'extension' },
    { ours: 'canvas', pattern: /canvas/i, category: 'skill' },
    { ours: 'discord', pattern: /^discord$/i, category: 'extension' },
    { ours: 'coding', pattern: /coding-agent/i, category: 'skill' },
  ]

  try {
    if (existsSync(skillsDir)) {
      const skills = readdirSync(skillsDir).filter(f => !f.startsWith('.'))
      for (const check of overlapChecks.filter(c => c.category === 'skill')) {
        const matched = skills.filter(s => check.pattern.test(s))
        if (matched.length > 0) {
          results.push({ dimension: 'ecosystem', issue: `cc-soul "${check.ours}" 功能与 OpenClaw skill "${matched[0]}" 重叠`, severity: 'info', suggestion: `评估是否可以用 OpenClaw 内置 skill 替代自建实现` })
        }
      }
    }
  } catch { /* ignore */ }

  try {
    if (existsSync(extensionsDir)) {
      const extensions = readdirSync(extensionsDir).filter(f => !f.startsWith('.'))
      for (const check of overlapChecks.filter(c => c.category === 'extension')) {
        const matched = extensions.filter(e => check.pattern.test(e))
        if (matched.length > 0) {
          results.push({ dimension: 'ecosystem', issue: `cc-soul "${check.ours}" 功能与 OpenClaw extension "${matched[0]}" 重叠`, severity: 'info', suggestion: `评估是否可以用 OpenClaw 内置 extension 替代` })
        }
      }
    }
  } catch { /* ignore */ }

  return results
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIMENSION 8: Code Self-Audit
// ═══════════════════════════════════════════════════════════════════════════════

function checkCodeHealth(): DiagnosticResult[] {
  const results: DiagnosticResult[] = []
  const _pluginsCode = resolve(homedir(), '.openclaw/plugins/cc-soul/cc-soul')
  const _hooksCode = resolve(homedir(), '.openclaw/hooks/cc-soul/cc-soul')
  const codeDir = existsSync(_pluginsCode) ? _pluginsCode : _hooksCode

  try {
    const files = readdirSync(codeDir).filter(f => f.endsWith('.ts'))

    for (const file of files) {
      const content = readFileSync(resolve(codeDir, file), 'utf-8')
      const lines = content.split('\n')
      const lineCount = lines.length

      // Rule 1: File too long (>300 lines)
      if (lineCount > 300) {
        results.push({
          dimension: 'code',
          issue: `${file} 有 ${lineCount} 行，超过 300 行标准`,
          severity: lineCount > 500 ? 'important' : 'warning',
          suggestion: `拆分 ${file} 为更小的模块`,
        })
      }

      // Rule 2: TODO/FIXME/HACK comments
      const todos = lines.filter(l => /\/\/\s*(TODO|FIXME|HACK|XXX)/i.test(l))
      if (todos.length > 0) {
        results.push({
          dimension: 'code',
          issue: `${file} 有 ${todos.length} 个 TODO/FIXME 未处理`,
          severity: 'info',
          suggestion: todos.slice(0, 3).map(t => t.trim()).join('; '),
        })
      }

      // Rule 3: Functions too long (>50 lines between function def and closing brace at same indent)
      let funcStart = -1
      let funcName = ''
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^(?:export\s+)?function\s+(\w+)/)
        if (match) {
          if (funcStart >= 0 && i - funcStart > 50) {
            results.push({
              dimension: 'code',
              issue: `${file}:${funcName}() 超过 50 行 (${i - funcStart} 行)`,
              severity: 'info',
              suggestion: '考虑拆分为辅助函数',
            })
          }
          funcStart = i
          funcName = match[1]
        }
      }

      // Rule 4: console.log without [cc-soul] prefix
      const badLogs = lines.filter(l => l.includes('console.log(') && !l.includes('[cc-soul]') && !l.includes('console.log(`[cc-soul]'))
      if (badLogs.length > 2) {
        results.push({
          dimension: 'code',
          issue: `${file} 有 ${badLogs.length} 个 console.log 缺少 [cc-soul] 前缀`,
          severity: 'info',
          suggestion: '统一日志格式',
        })
      }

      // Rule 5: any type usage
      const anyCount = (content.match(/:\s*any\b/g) || []).length
      if (anyCount > 5) {
        results.push({
          dimension: 'code',
          issue: `${file} 有 ${anyCount} 处 :any 类型`,
          severity: 'info',
          suggestion: '添加具体类型定义',
        })
      }
    }

    // Total line count
    const totalLines = files.reduce((sum, f) => {
      try { return sum + readFileSync(resolve(codeDir, f), 'utf-8').split('\n').length } catch { return sum }
    }, 0)
    results.push({
      dimension: 'code',
      issue: `代码总量: ${files.length} 模块, ${totalLines} 行`,
      severity: 'info',
      suggestion: '',
    })

  } catch (e: any) {
    results.push({ dimension: 'code', issue: `代码审查失败: ${e.message}`, severity: 'warning', suggestion: '' })
  }

  return results
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIMENSION 9: (removed — rover/tech-radar modules deleted)
// ═══════════════════════════════════════════════════════════════════════════════

function checkTechRadar(): DiagnosticResult[] {
  return []
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIMENSION 10: Upgrade Meta-Learning Insights
// ═══════════════════════════════════════════════════════════════════════════════

function checkUpgradeMetaLearning(): DiagnosticResult[] {
  return []
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIMENSION 11: Upgrade Safety Guards
// ═══════════════════════════════════════════════════════════════════════════════

function checkUpgradeSafety(): DiagnosticResult[] {
  return []
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIMENSION 12: Runtime Error Scanning
// ═══════════════════════════════════════════════════════════════════════════════

function checkRuntimeErrors(): DiagnosticResult[] {
  const results: DiagnosticResult[] = []
  try {
    const logPath = '/tmp/openclaw-gateway.log'
    if (!existsSync(logPath)) return results

    // Read last 200KB of log to avoid loading huge files
    const fullLog = readFileSync(logPath, 'utf-8')
    const log = fullLog.length > 200000 ? fullLog.slice(-200000) : fullLog
    const errorLines = log.split('\n').filter(l => l.includes('[cc-soul]') && (l.includes('error') || l.includes('Error') || l.includes('ERROR')))

    if (errorLines.length > 5) {
      // Group by module
      const moduleCounts: Record<string, number> = {}
      for (const line of errorLines) {
        const modMatch = line.match(/\[cc-soul\]\[(\w[\w-]*)\]/)
        const mod = modMatch ? modMatch[1] : 'unknown'
        moduleCounts[mod] = (moduleCounts[mod] || 0) + 1
      }

      for (const [mod, count] of Object.entries(moduleCounts)) {
        if (count >= 5) {
          results.push({
            dimension: 'runtime',
            issue: `${mod} 模块产生了 ${count} 个运行时错误`,
            severity: count >= 20 ? 'important' : 'warning',
            suggestion: `检查 ${mod} 模块的错误处理逻辑`,
          })
        }
      }
    }

    // Check for repeated stack traces (same error recurring)
    const stackTraces = log.split('\n').filter(l => l.includes('at ') && l.includes('cc-soul'))
    if (stackTraces.length > 50) {
      results.push({
        dimension: 'runtime',
        issue: `发现 ${stackTraces.length} 行栈追踪信息，可能有反复崩溃的模块`,
        severity: 'warning',
        suggestion: '检查 gateway 日志定位崩溃源',
      })
    }
  } catch { /* log file read failure is not critical */ }
  return results
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIMENSION 13: Feature Activity (functional health)
// ═══════════════════════════════════════════════════════════════════════════════

function checkFeatureActivity(): DiagnosticResult[] {
  const results: DiagnosticResult[] = []

  // Memory tagging activity
  const totalMem = memoryState.memories.length
  const taggedMem = memoryState.memories.filter(m => m.tags && m.tags.length > 0).length

  // User profiles
  const profileCount = profiles.size

  // Graph entities
  const entityCount = graphState.entities.length

  // Rules
  const ruleCount = rules.length
  const activeRules = rules.filter(r => r.hits > 0).length

  // Inner life: journal entries indicate inner-life is working
  const journalActive = innerState.journal && innerState.journal.length > 0

  // Feature status table
  const featureChecks: { name: string; active: boolean; description: string }[] = [
    {
      name: '语义标签',
      active: taggedMem > 0,
      description: `${taggedMem}/${totalMem} 已打标 (${totalMem > 0 ? Math.round(taggedMem / totalMem * 100) : 0}%)`,
    },
    {
      name: '用户画像',
      active: profileCount > 0,
      description: `${profileCount} 用户`,
    },
    {
      name: '实体图谱',
      active: entityCount > 0,
      description: `${entityCount} 实体`,
    },
    {
      name: '进化规则',
      active: ruleCount > 0,
      description: `${ruleCount} 规则, ${activeRules} 已命中`,
    },
    {
      name: '内心生活',
      active: journalActive,
      description: journalActive ? `${innerState.journal.length} 篇日记` : '无日记',
    },
    {
      name: '知识边界',
      active: getWeakDomains().length >= 0, // always active once epistemic loads
      description: getEpistemicSummary() ? '追踪中' : '无领域数据',
    },
    {
      name: 'A/B 实验',
      active: true, // experiment system is always on
      description: getExperimentSummary() || '无实验',
    },
  ]

  for (const check of featureChecks) {
    if (!check.active) {
      results.push({
        dimension: 'feature-activity',
        issue: `${check.name}: 未激活 — ${check.description}`,
        severity: 'warning',
        suggestion: `检查 ${check.name} 是否正常工作`,
      })
    } else {
      // Info-level: show active features in the report
      results.push({
        dimension: 'feature-activity',
        issue: `${check.name}: ✅ ${check.description}`,
        severity: 'info',
        suggestion: '',
      })
    }
  }

  return results
}

// ═══════════════════════════════════════════════════════════════════════════════
// Deep Code Audit (async, CLI-powered)
// Called on manual trigger; sends follow-up message
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Runs Claude CLI to audit code logic in flagged or large modules.
 * Async: results delivered via callback. Only audits top N modules to limit cost.
 */
export function runDeepCodeAudit(
  diagnosticResults: DiagnosticResult[],
  onComplete: (bugs: string[]) => void,
) {
  // Determine which modules to audit:
  // 1. Modules flagged in diagnostic (code dimension with issues)
  // 2. Top 5 largest modules if fewer than 3 flagged
  const flaggedModules = new Set<string>()
  for (const r of diagnosticResults) {
    if (r.dimension === 'code' && (r.severity === 'warning' || r.severity === 'important')) {
      const fileMatch = r.issue.match(/^([\w-]+\.ts)/)
      if (fileMatch) flaggedModules.add(fileMatch[1])
    }
  }

  // If few flagged, add largest modules
  if (flaggedModules.size < 3) {
    try {
      const files = readdirSync(MODULE_DIR).filter(f => f.endsWith('.ts'))
      const sized = files.map(f => ({
        name: f,
        size: readFileSync(resolve(MODULE_DIR, f), 'utf-8').split('\n').length,
      })).sort((a, b) => b.size - a.size)

      for (const f of sized) {
        if (flaggedModules.size >= 5) break
        // Skip immutable / tiny files
        if (['diagnostic.ts', 'tests.ts', 'types.ts'].includes(f.name)) continue
        if (f.size < 100) continue
        flaggedModules.add(f.name)
      }
    } catch { /* ignore */ }
  }

  const modulesToAudit = [...flaggedModules].slice(0, 5)
  if (modulesToAudit.length === 0) {
    onComplete([])
    return
  }

  const allBugs: string[] = []
  let completed = 0

  for (const moduleName of modulesToAudit) {
    auditModuleLogic(moduleName, (bugs) => {
      allBugs.push(...bugs)
      completed++
      if (completed >= modulesToAudit.length) {
        onComplete(allBugs)
      }
    })
  }
}

function auditModuleLogic(moduleName: string, callback: (bugs: string[]) => void) {
  try {
    const code = readFileSync(resolve(MODULE_DIR, moduleName), 'utf-8')
    if (code.length < 100) { callback([]); return }

    // Truncate to first 300 lines to fit in prompt
    const truncated = code.split('\n').slice(0, 300).join('\n')

    // Lazy import spawnCLI to avoid circular dependency
    const { spawnCLI } = require('./cli.ts')

    spawnCLI(
      `审查以下 TypeScript 代码的逻辑 bug（不是代码风格，是真正的逻辑错误）。\n` +
      `只报严重问题：空指针、类型错误、竞态条件、无限循环、数据丢失、内存泄漏。\n` +
      `不报：代码风格、命名、注释、文件长度。\n\n` +
      `文件: ${moduleName}\n` +
      `\`\`\`typescript\n${truncated}\n\`\`\`\n\n` +
      `格式（每行一个 bug，没有就回答"无"）:\n` +
      `行号: 描述`,
      (output: string) => {
        if (!output || output.includes('无') || output.length < 10) {
          callback([])
          return
        }
        const bugs = output.split('\n')
          .filter((l: string) => l.trim().length > 5 && !l.startsWith('```'))
          .slice(0, 5) // max 5 bugs per module
          .map((l: string) => `[${moduleName}] ${l.trim()}`)
        callback(bugs)
      },
      45000,
      `bug-audit-${moduleName}`,
    )
  } catch {
    callback([])
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DIAGNOSTIC
// ═══════════════════════════════════════════════════════════════════════════════

export function runFullDiagnostic(stats: InteractionStats, onComplete?: (summary: string) => void): DiagnosticResult[] {
  const results: DiagnosticResult[] = []
  const progressLines: string[] = []

  const checks: { name: string; icon: string; fn: () => DiagnosticResult[] }[] = [
    { name: '功能健康', icon: '📊', fn: checkFeatureHealth },
    { name: '功能衔接', icon: '🔗', fn: checkFeatureIntegration },
    { name: '数据健康', icon: '💾', fn: checkDataHealth },
    { name: '性能检查', icon: '⚡', fn: checkPerformance },
    { name: '安全检查', icon: '🔒', fn: checkSecurity },
    { name: '规模感知', icon: '📈', fn: checkScale },
    { name: 'OpenClaw 生态', icon: '🔍', fn: checkOpenClawEcosystem },
    { name: '代码自审', icon: '📝', fn: checkCodeHealth },
    { name: '技术雷达', icon: '📡', fn: checkTechRadar },
    { name: '升级经验', icon: '🧠', fn: checkUpgradeMetaLearning },
    { name: '升级安全', icon: '🛡️', fn: checkUpgradeSafety },
    { name: '运行时错误', icon: '🔥', fn: checkRuntimeErrors },
    { name: '功能活性', icon: '💡', fn: checkFeatureActivity },
  ]

  for (const check of checks) {
    try {
      const checkResults = check.fn()
      results.push(...checkResults)
      const issues = checkResults.filter(r => r.severity === 'critical' || r.severity === 'important')
      const warnings = checkResults.filter(r => r.severity === 'warning')
      const status = issues.length > 0 ? `${issues.length} 问题` : warnings.length > 0 ? `${warnings.length} 警告` : '✅'
      const detail = issues.length > 0 ? ` — ${issues[0].issue.slice(0, 40)}` : ''
      progressLines.push(`${check.icon} ${check.name}: ${status}${detail}`)
    } catch (e: any) {
      console.error(`[cc-soul][diag] ${check.name} error: ${e.message}`)
      progressLines.push(`${check.icon} ${check.name}: ❌ 出错`)
    }
  }

  // 一次性发送完整诊断结果
  if (onComplete) {
    const critical = results.filter(r => r.severity === 'critical')
    const important = results.filter(r => r.severity === 'important')
    const warnings = results.filter(r => r.severity === 'warning')

    const summary = [
      `=== cc-soul 诊断报告 ===\n`,
      ...progressLines,
      ``,
      `总计: ${critical.length} 严重 / ${important.length} 重要 / ${warnings.length} 警告`,
    ]

    if (critical.length + important.length > 0) {
      summary.push(`\n需要修复:`)
      for (const r of [...critical, ...important]) {
        summary.push(`  • [${r.dimension}] ${r.issue}`)
        if (r.suggestion) summary.push(`    → ${r.suggestion}`)
      }
      summary.push(`\n回复"执行"启动自动修复`)
    } else {
      summary.push(`\n✅ 无严重问题，系统运行正常`)
    }

    onComplete(summary.join('\n'))
  }

  return results
}

export function formatDiagnosticReport(results: DiagnosticResult[]): string {
  if (results.length === 0) return '全部正常，无需升级'

  const critical = results.filter(r => r.severity === 'critical')
  const important = results.filter(r => r.severity === 'important')
  const warnings = results.filter(r => r.severity === 'warning')
  const info = results.filter(r => r.severity === 'info')

  const lines: string[] = ['=== cc-soul 诊断报告 ===']
  if (critical.length) {
    lines.push(`\n[严重] (${critical.length}):`)
    critical.forEach(r => lines.push(`  [${r.dimension}] ${r.issue} -> ${r.suggestion}`))
  }
  if (important.length) {
    lines.push(`\n[重要] (${important.length}):`)
    important.forEach(r => lines.push(`  [${r.dimension}] ${r.issue} -> ${r.suggestion}`))
  }
  if (warnings.length) {
    lines.push(`\n[警告] (${warnings.length}):`)
    warnings.forEach(r => lines.push(`  [${r.dimension}] ${r.issue} -> ${r.suggestion}`))
  }
  if (info.length) {
    lines.push(`\n[信息] (${info.length}):`)
    info.forEach(r => lines.push(`  [${r.dimension}] ${r.issue}${r.suggestion ? ' -> ' + r.suggestion : ''}`))
  }
  // Append experiment/evolution status if any
  const expSummary = getExperimentSummary()
  const evoSummary = getEvolutionSummary()
  if (expSummary || evoSummary) {
    lines.push('\n=== 实验/进化状态 ===')
    if (expSummary) lines.push(expSummary)
    if (evoSummary) lines.push(evoSummary)
  }
  // Append metacognitive feedback summary (augment effectiveness)
  const metaFbSummary = getMetaFeedbackSummary()
  if (metaFbSummary) {
    lines.push('\n=== Augment 效果反馈 ===')
    lines.push(metaFbSummary)
  }
  return lines.join('\n')
}

// ── SoulModule registration ──

export const diagnosticModule: SoulModule = {
  id: 'diagnostic',
  name: '诊断系统',
  priority: 50,
}
