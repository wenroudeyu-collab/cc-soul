/**
 * handler-heartbeat.ts — cc-soul 自主心跳循环
 *
 * 每 30 分钟执行一次的后台维护任务集合。
 * 从 handler.ts 提取，降低主文件复杂度。
 */

import {
  metrics, stats, getHeartbeatRunning, setHeartbeatRunning,
  getHeartbeatStartedAt, setHeartbeatStartedAt,
  getSessionState, getLastActiveSessionKey,
} from './handler-state.ts'
import { loadJson, saveJson, REMINDERS_PATH } from './persistence.ts'
import { dbGetDueReminders, dbMarkReminderFired } from './sqlite-store.ts'
import { bodyTick } from './body.ts'
import {
  memoryState, consolidateMemories, scanForContradictions,
  autoPromoteToCoreMemory, cleanupWorkingMemory, processMemoryDecay,
  batchTagUntaggedMemories, saveMemories, auditMemoryHealth,
  sqliteMaintenance,
} from './memory.ts'
import { writeJournalWithCLI, checkDreamMode, triggerStructuredReflection, checkActivePlans, cleanupPlans, selfChallenge } from './inner-life.ts'
import { isEnabled } from './features.ts'
// ── Optional modules (absent in public build) ──
let reportTelemetry: (...args: any[]) => void = () => {}
import('./telemetry.ts').then(m => { reportTelemetry = m.reportTelemetry }).catch(() => {})
let autoFederate: () => void = () => {}
import('./federation.ts').then(m => { autoFederate = m.autoFederate }).catch(() => {})
let autoSync: () => void = () => {}
import('./sync.ts').then(m => { autoSync = m.autoSync }).catch(() => {})
let checkSoulUpgrade: (stats: any) => void = (_stats: any) => {}
import('./upgrade.ts').then(m => { checkSoulUpgrade = m.checkSoulUpgrade }).catch(() => {})
let webRoam: () => void = () => {}, techRadarScan: () => void = () => {}, verifyDiscoveries: () => void = () => {}
import('./rover.ts').then(m => { webRoam = m.webRoam; techRadarScan = m.techRadarScan; verifyDiscoveries = m.verifyDiscoveries }).catch(() => {})
let runCompetitiveRadar: () => void = () => {}
import('./competitive-radar.ts').then(m => { runCompetitiveRadar = m.runCompetitiveRadar }).catch(() => {})
// ── End optional modules ──
import { checkAutoTune } from './auto-tune.ts'
import { autoPopulateFromMemories } from './lorebook.ts'
import { checkSpontaneousVoice } from './voice.ts'
import { checkAllSessionEnds, generateSessionSummary } from './flow.ts'
import { analyzeMetaLearning, evaluateReflexionRules } from './evolution.ts'
import { resampleHardExamples } from './quality.ts'
import { checkExperiments, checkEvolutionProgress } from './experiment.ts'
import { healthCheck, recordModuleError, recordModuleActivity } from './health.ts'
import { notifySoulActivity } from './notify.ts'
import { brain } from './brain.ts'
import { checkScheduledReports } from './reports.ts'

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
      safe('bodyTick', () => bodyTick())
      const hbSession = getSessionState(getLastActiveSessionKey())
      safe('journal', () => writeJournalWithCLI(hbSession.lastPrompt, hbSession.lastResponseContent, stats))
      if (isEnabled('web_rover')) safe('webRoam', () => webRoam())
      if (isEnabled('tech_radar')) safe('techRadar', () => techRadarScan())
      if (isEnabled('web_rover')) safe('verifyDiscoveries', () => verifyDiscoveries())
      if (isEnabled('self_upgrade')) safe('competitiveRadar', () => runCompetitiveRadar())
      if (isEnabled('dream_mode')) safe('dreamMode', () => checkDreamMode())
      if (isEnabled('autonomous_voice')) safe('voice', () => checkSpontaneousVoice(stats.totalMessages))
      if (isEnabled('self_upgrade')) safe('upgrade', () => checkSoulUpgrade(stats))
      if (isEnabled('self_upgrade')) safe('autoTune', () => checkAutoTune(stats))
      if (isEnabled('memory_consolidation')) safe('consolidate', () => consolidateMemories())
      if (isEnabled('lorebook')) safe('lorebook', () => autoPopulateFromMemories(memoryState.memories))
      if (isEnabled('structured_reflection')) safe('reflection', () => triggerStructuredReflection(stats))
      if (isEnabled('memory_contradiction_scan')) safe('contradiction', () => scanForContradictions())
      if (isEnabled('plan_tracking')) safe('planCleanup', () => cleanupPlans())
      if (isEnabled('memory_core')) safe('coreMemory', () => autoPromoteToCoreMemory())
      if (isEnabled('memory_working')) safe('workingCleanup', () => cleanupWorkingMemory())
      safe('memoryDecay', () => processMemoryDecay())
      if (isEnabled('memory_tags')) safe('batchTag', () => batchTagUntaggedMemories())
      if (isEnabled('sync')) safe('sync', () => autoSync())
      if (isEnabled('federation')) safe('federate', () => autoFederate())
      if (isEnabled('memory_session_summary')) safe('sessionEnd', () => {
        const endedSessions = checkAllSessionEnds()
        for (const s of endedSessions) {
          generateSessionSummary(s.topic, s.turnCount, s.flowKey)
        }
      })
      if (isEnabled('meta_learning')) safe('metaLearning', () => analyzeMetaLearning())
      safe('qualityResample', () => resampleHardExamples())
      safe('reflexionEval', () => evaluateReflexionRules(stats.corrections, stats.totalMessages))
      if (isEnabled('self_challenge')) safe('selfChallenge', () => selfChallenge())
      safe('telemetry', () => { reportTelemetry(stats.totalMessages, stats.corrections, stats.firstSeen) })
      safe('experiments', () => checkExperiments())
      safe('evolution', () => checkEvolutionProgress())
      safe('health', () => healthCheck())
      safe('sqliteMaintenance', () => { sqliteMaintenance().catch(() => {}) })
      safe('memoryAudit', () => auditMemoryHealth())
      // ── Brain modules heartbeat (cron-agent, smart-forget, etc.) ──
      safe('brainHeartbeat', () => brain.fire('onHeartbeat'))
      safe('scheduledReports', () => {
        const report = checkScheduledReports()
        if (report) notifySoulActivity(report)
      })
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
