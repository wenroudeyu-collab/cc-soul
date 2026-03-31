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

// ── CLI concurrency semaphore: limit parallel CLI-spawning heartbeat tasks ──
let _cliSemaphore = 0
const MAX_CLI_CONCURRENT = 3

function safeCLI(name: string, fn: () => void, safeFn: (name: string, fn: () => void) => void) {
  if (_cliSemaphore >= MAX_CLI_CONCURRENT) {
    console.log(`[cc-soul][heartbeat] skipping ${name} — CLI concurrency limit (${MAX_CLI_CONCURRENT})`)
    return
  }
  _cliSemaphore++
  safeFn(name, () => {
    try { fn() } finally { _cliSemaphore-- }
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
      safe('workingCleanup', () => cleanupWorkingMemory())
      safe('memoryDecay', () => processMemoryDecay())
      safe('batchTag', () => batchTagUntaggedMemories()) // local extraction, no LLM
      safe('pruneExpired', () => pruneExpiredMemories())
      safe('reviveDecayed', () => reviveDecayedMemories())
      safe('memoryAudit', () => auditMemoryHealth())
      safe('compressOld', () => compressOldMemories())
      safe('sqliteMaintenance', () => { sqliteMaintenance().catch(() => {}) }) // intentionally silent — maintenance

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

      // ── 行为模式学习 ──
      safe('behaviorLearn', async () => {
        const { learnFromObservations } = await import('./behavioral-phase-space.ts')
        learnFromObservations()
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
