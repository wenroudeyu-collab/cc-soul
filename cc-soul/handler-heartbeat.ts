/**
 * handler-heartbeat.ts — cc-soul 自主心跳循环
 *
 * 每 30 分钟执行一次的后台维护任务集合。
 * 从 handler.ts 提取，降低主文件复杂度。
 */

import {
  metrics, stats, getHeartbeatRunning, setHeartbeatRunning,
  getHeartbeatStartedAt, setHeartbeatStartedAt,
} from './handler-state.ts'
import { dbGetDueReminders, dbMarkReminderFired } from './sqlite-store.ts'
import { bodyTick } from './body.ts'
import {
  consolidateMemories, scanForContradictions,
  autoPromoteToCoreMemory, cleanupWorkingMemory, processMemoryDecay,
  batchTagUntaggedMemories, auditMemoryHealth,
  sqliteMaintenance,
  pruneExpiredMemories, reviveDecayedMemories,
  compressOldMemories,
} from './memory.ts'
import { cleanupPlans } from './inner-life.ts'
import { computePageRank, decayActivations, invalidateStaleEntities, invalidateStaleRelations, enrichCausalFromMemories } from './graph.ts'
import { isEnabled } from './features.ts'
import { checkAutoTune } from './auto-tune.ts'
import { resampleHardExamples } from './quality.ts'
import { runDistillPipeline } from './distill.ts'
import { healthCheck, recordModuleError, recordModuleActivity } from './health.ts'
import { notifySoulActivity } from './notify.ts'
import { brain } from './brain.ts'
import { distillPersonModel } from './person-model.ts'
import { tickBatchQueue } from './cli.ts'
// person synthesis now handled inside person-model.ts distillPersonModel() (every 5th distill)
import { heartbeatScanAbsence } from './absence-detection.ts'
import { scanBlindSpotQuestions } from './epistemic.ts'
import { updateDeepUnderstand } from './deep-understand.ts'

// ── CLI concurrency semaphore + 熔断器 ──
let _cliSemaphore = 0
const MAX_CLI_CONCURRENT = 3
// 熔断器：连续失败 3 次 → 停 1 小时。按 CLI 可用性熔断（共享），不按业务操作分
let _cliFailures = 0
let _cliCircuitOpenAt = 0

function safeCLI(name: string, fn: () => void, safeFn: (name: string, fn: () => void) => void) {
  // 熔断检查
  if (_cliFailures >= 3) {
    if (Date.now() - _cliCircuitOpenAt < 3600_000) {
      return  // 熔断中，静默跳过
    }
    // 冷却期过了，半开状态
    console.log(`[cc-soul][heartbeat] CLI circuit half-open, attempting ${name}`)
  }
  if (_cliSemaphore >= MAX_CLI_CONCURRENT) {
    return
  }
  _cliSemaphore++
  safeFn(name, () => {
    try {
      fn()
      if (_cliFailures > 0) { _cliFailures = 0 }  // 成功 → 重置
    } catch (e: any) {
      _cliFailures++
      if (_cliFailures >= 3) {
        _cliCircuitOpenAt = Date.now()
        console.error(`[cc-soul][heartbeat] CLI circuit OPEN (${name}: ${e.message})`)
        try { require('./decision-log.ts').logDecision('circuit_open', 'cli', `failures=${_cliFailures}, ${name}: ${e.message}`) } catch {}
      }
      throw e
    } finally { _cliSemaphore-- }
  })
}

/** Exported for plugin-entry.ts heartbeat interval */
export function runHeartbeat() {
  // Force release if stuck for >25 minutes
  if (getHeartbeatRunning() && getHeartbeatStartedAt() > 0 && Date.now() - getHeartbeatStartedAt() > 25 * 60000) {
    console.error('[cc-soul][heartbeat] force-releasing stuck heartbeat lock (>25min)')
    setHeartbeatRunning(false)
  }
  if (getHeartbeatRunning()) return
  setHeartbeatRunning(true)
  setHeartbeatStartedAt(Date.now())
  metrics.lastHeartbeat = Date.now()
    try {
      const safe = (name: string, fn: () => void) => {
        try { fn(); recordModuleActivity(name) } catch (e: any) { recordModuleError(name, e.message); console.error(`[cc-soul][heartbeat][${name}] ${e.message}`) }
      }
      // ══ 精简心跳：只保留直接影响用户体验的任务 ══
      // 砍掉：journal(LLM自嗨)、dream(用户不可见)、voice(主动骚扰)
      // 砍掉：reflection(LLM自省)、selfChallenge(LLM自测)、metaLearning/reflexionEval
      // 砍掉：experiments/evolution进度、blindSpot、proactiveContradiction、freshness
      // 砍掉：scheduledReports(没人要的推送)

      safe('bodyTick', () => bodyTick())

      // ── 记忆维护（核心，不调 LLM）──
      safeCLI('consolidate', () => consolidateMemories(), safe)
      safeCLI('contradiction', () => scanForContradictions(), safe)
      safe('coreMemory', () => autoPromoteToCoreMemory())
      // Letta 热度分层：engagement 驱动 core 晋升/降级
      safe('heatPromotion', () => {
        try {
          const { memoryState } = require('./memory.ts')
          for (const m of memoryState.memories) {
            if (!m || m.scope === 'expired') continue
            const eng = m.injectionEngagement ?? 0
            const miss = m.injectionMiss ?? 0
            const rate = eng / Math.max(1, eng + miss)

            // 高 engagement + 高频 → 自动晋升 core
            if (rate > 0.6 && eng >= 5 && m.scope !== 'core_memory') {
              m.scope = 'core_memory'
              try { const { logDecision } = require('./decision-log.ts'); logDecision('heat_promote', (m.content||'').slice(0,30), `rate=${rate.toFixed(2)},eng=${eng}`) } catch {}
              try { const { appendLineage } = require('./memory-utils.ts'); appendLineage(m, { action: 'promoted', ts: Date.now(), delta: `→core_memory, rate=${rate.toFixed(2)}` }) } catch {}
            }

            // core 但长期无 engagement → 降级（engagement 减半防震荡）
            if (m.scope === 'core_memory' && eng > 0 && rate < 0.2) {
              m.scope = 'fact'
              m.injectionEngagement = Math.floor(eng / 2)
              m.injectionMiss = Math.floor(miss / 2)
              try { const { logDecision } = require('./decision-log.ts'); logDecision('heat_demote', (m.content||'').slice(0,30), `rate=${rate.toFixed(2)},eng=${eng}→${m.injectionEngagement}`) } catch {}
              try { const { appendLineage } = require('./memory-utils.ts'); appendLineage(m, { action: 'demoted', ts: Date.now(), delta: `→fact, rate=${rate.toFixed(2)}` }) } catch {}
            }
          }
        } catch {}
      })
      safe('workingCleanup', () => cleanupWorkingMemory())
      safe('memoryDecay', () => processMemoryDecay())
      safe('aamDecay', () => { try { require('./aam.ts').decayCooccurrence() } catch {} })
      safe('batchTag', () => batchTagUntaggedMemories()) // local extraction, no LLM
      safe('pruneExpired', () => pruneExpiredMemories())
      safe('reviveDecayed', () => reviveDecayedMemories())
      safe('memoryAudit', () => auditMemoryHealth())
      safe('compressOld', () => compressOldMemories())
      safe('sqliteMaintenance', () => { sqliteMaintenance().catch(() => {}) }) // intentionally silent — maintenance

      // 实体结晶缓存：heartbeat 预计算实体画像写入 attrs
      safe('entityCrystal', async () => {
        try {
          const { graphState, generateEntitySummary } = await import('./graph.ts')
          const now = Date.now()
          for (const entity of graphState.entities) {
            if (entity.invalid_at !== null) continue
            if (entity.mentions < 3) continue  // 提及太少不值得画像
            // 检查是否需要刷新（>24h 未更新）
            const lastCrystal = entity.attrs.find((a: string) => a.startsWith('crystal:'))
            const lastTs = lastCrystal ? parseInt(lastCrystal.split('|')[1] || '0') : 0
            if (now - lastTs < 86400000) continue  // <24h 不刷新
            // 生成画像
            const summary = generateEntitySummary(entity.name)
            if (summary) {
              entity.attrs = entity.attrs.filter((a: string) => !a.startsWith('crystal:'))
              entity.attrs.push(`crystal:${summary.slice(0, 100)}|${now}`)
            }
          }
        } catch {}
      })

      // ── 蒸馏 + 图谱（核心，有条件调 LLM）──
      safeCLI('distill', () => runDistillPipeline(), safe)
      safe('pageRank', () => computePageRank())
      safe('activationDecay', () => decayActivations())
      // 清理过期实体和关系（90天没提到的）
      safe('staleEntities', () => invalidateStaleEntities())
      safe('staleRelations', () => invalidateStaleRelations())
      // 从记忆 because 字段补充因果边
      safe('enrichCausal', () => enrichCausalFromMemories())
      safeCLI('personModel', () => distillPersonModel(), safe)
      // person synthesis runs inside distillPersonModel() every 5th distill — no separate call needed

      // ── 盲点提问扫描（基于 epistemic 域 + person-model 缺口）──
      safe('blindSpotQuestions', () => scanBlindSpotQuestions())

      // ── 动态结构词发现 ──
      safe('structureWordDiscovery', async () => {
        try {
          const { discoverNewStructureWords } = await import('./dynamic-extractor.ts')
          const { getSessionState, getLastActiveSessionKey } = await import('./handler-state.ts')
          const sess = getSessionState(getLastActiveSessionKey())
          const userId = sess?.userId || 'default'
          discoverNewStructureWords(userId)
        } catch {}
      })

      // ── 行为模式学习 ──
      safe('behaviorLearn', async () => {
        const { learnFromObservations } = await import('./behavioral-phase-space.ts')
        learnFromObservations()
      })

      // ── Skill Memory 提炼（MemOS 启发）──
      safe('skillExtract', async () => {
        try {
          const { traceCausalChain, graphState } = await import('./graph.ts')
          const { memoryState } = await import('./memory.ts')
          const { DATA_DIR, loadJson, debouncedSave } = await import('./persistence.ts')
          const { resolve } = await import('path')

          const SKILLS_PATH = resolve(DATA_DIR, 'skills.json')
          interface Skill { id: string; trigger: string[]; steps: string[]; learnedFrom: string[]; successRate: number; lastUsed: number; domain: string }
          let skills: Skill[] = loadJson<Skill[]>(SKILLS_PATH, [])
          if (skills.length >= 50) return  // 技能上限

          // 来源 1：因果链中的"问题→尝试→解决"模式
          const resolvedEpisodes = memoryState.memories.filter((m: any) =>
            m && m.scope === 'event' && /解决|搞定|成功|修好/.test(m.content)
          ).slice(-10)

          for (const resolved of resolvedEpisodes) {
            const entities = (await import('./graph.ts')).findMentionedEntities(resolved.content)
            if (entities.length === 0) continue
            const chain = traceCausalChain(entities.slice(0, 1), 2)
            if (chain.length === 0) continue

            const trigger = entities.slice(0, 2)
            const steps = chain.map((c: string) => c.slice(0, 50))
            const id = `skill_${Date.now()}_${Math.random().toString(36).slice(2,5)}`

            // 检查是否已有类似技能
            const hasSimilar = skills.some(s => s.trigger.some(t => trigger.includes(t)))
            if (hasSimilar) continue

            skills.push({ id, trigger, steps, learnedFrom: [resolved.content.slice(0, 40)], successRate: 0.5, lastUsed: 0, domain: entities[0] })
          }

          // 来源 2：evolution rules 中高置信度的
          try {
            const { getRules } = await import('./evolution.ts')
            const rules = getRules?.() ?? []
            for (const r of rules.filter((r: any) => r.hits >= 5 && r.hits / (r.hits + (r.misses ?? 0) + 1) > 0.7)) {
              const trigger = (r.conditions ?? []).slice(0, 3)
              if (trigger.length === 0) continue
              const hasSimilar = skills.some(s => s.trigger.some(t => trigger.includes(t)))
              if (hasSimilar) continue
              skills.push({
                id: `skill_rule_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
                trigger, steps: [r.rule], learnedFrom: [r.source ?? 'evolution'],
                successRate: r.hits / (r.hits + (r.misses ?? 0) + 1), lastUsed: 0, domain: trigger[0],
              })
            }
          } catch {}

          if (skills.length > 50) skills = skills.slice(-50)
          debouncedSave(SKILLS_PATH, skills, 5000)
        } catch {}
      })

      // ── 前瞻记忆清理 + 主动发现 ──
      safe('pmCleanup', async () => {
        const { cleanupProspectiveMemories, autoDetectFromMemories } = await import('./prospective-memory.ts')
        cleanupProspectiveMemories()
        // Auto-detect recurring themes from recent memories
        try {
          const { memoryState } = await import('./memory.ts')
          if (memoryState.memories.length > 0) {
            autoDetectFromMemories(memoryState.memories)
          }
        } catch {}
      })

      // ── CIN 认知场更新 + 因果链发现 ──
      safe('cinField', async () => {
        const { rebuildField, discoverCausalChains } = await import('./cin.ts')
        const { memoryState } = await import('./memory.ts')
        if (memoryState.memories.length >= 20) {
          rebuildField(memoryState.memories)
          discoverCausalChains(memoryState.memories)
        }
      })

      // ── 轻量维护 ──
      safe('brainHeartbeat', () => brain.fire('onHeartbeat'))
      if (isEnabled('self_upgrade')) safe('autoTune', () => checkAutoTune(stats))
      safe('planCleanup', () => cleanupPlans())
      safeCLI('qualityResample', () => resampleHardExamples(), safe)
      safe('health', () => healthCheck())

      // ── LLM 批处理队列（2-5 AM 窗口处理）──
      safe('batchQueue', () => tickBatchQueue())

      // ── 深层理解引擎（7维分析）──
      safe('deepUnderstand', () => updateDeepUnderstand())

      // ── 离开检测（扫描用户活跃度）──
      if (isEnabled('absence_detection')) safe('absenceDetection', () => heartbeatScanAbsence())

      // ── 提醒（用户主动设置的，不能砍）──
      safe('reminders', () => {
        const due = dbGetDueReminders()
        for (const r of due) {
          notifySoulActivity(`[提醒] ${r.msg}`)
          dbMarkReminderFired(r.id)
        }
      })
    } catch (e: any) {
      console.error(`[cc-soul][heartbeat] ${e.message}`)
    } finally {
      setHeartbeatRunning(false)
    }
}
