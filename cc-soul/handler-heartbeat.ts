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
} from './memory.ts'
import { cleanupPlans } from './inner-life.ts'
import { computePageRank, decayActivations } from './graph.ts'
import { isEnabled } from './features.ts'
import { checkAutoTune } from './auto-tune.ts'
import { resampleHardExamples } from './quality.ts'
import { runDistillPipeline } from './distill.ts'
import { healthCheck, recordModuleError, recordModuleActivity } from './health.ts'
import { notifySoulActivity } from './notify.ts'
import { brain } from './brain.ts'
import { distillPersonModel } from './person-model.ts'
// person synthesis now handled inside person-model.ts distillPersonModel() (every 5th distill)
import { heartbeatScanAbsence } from './absence-detection.ts'

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
      if (isEnabled('memory_consolidation')) safe('consolidate', () => consolidateMemories())
      if (isEnabled('memory_contradiction_scan')) safe('contradiction', () => scanForContradictions())
      if (isEnabled('memory_core')) safe('coreMemory', () => autoPromoteToCoreMemory())
      if (isEnabled('memory_working')) safe('workingCleanup', () => cleanupWorkingMemory())
      safe('memoryDecay', () => processMemoryDecay())
      if (isEnabled('memory_tags')) safe('batchTag', () => batchTagUntaggedMemories())
      safe('pruneExpired', () => pruneExpiredMemories())
      safe('reviveDecayed', () => reviveDecayedMemories())
      safe('memoryAudit', () => auditMemoryHealth())
      safe('sqliteMaintenance', () => { sqliteMaintenance().catch(() => {}) })

      // ── 蒸馏 + 图谱（核心，有条件调 LLM）──
      safe('distill', () => runDistillPipeline())
      safe('pageRank', () => computePageRank())
      safe('activationDecay', () => decayActivations())
      safe('personModel', () => distillPersonModel())
      // person synthesis runs inside distillPersonModel() every 5th distill — no separate call needed

      // ── 轻量维护 ──
      safe('brainHeartbeat', () => brain.fire('onHeartbeat'))
      if (isEnabled('self_upgrade')) safe('autoTune', () => checkAutoTune(stats))
      if (isEnabled('plan_tracking')) safe('planCleanup', () => cleanupPlans())
      safe('qualityResample', () => resampleHardExamples())
      safe('health', () => healthCheck())

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
