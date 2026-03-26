/**
 * cc-soul — OpenClaw HookHandler (Modular Orchestrator)
 *
 * Slim entry point that wires all modules together.
 * Split into:
 *   handler-state.ts     — global state, metrics, stats, session
 *   handler-heartbeat.ts — autonomous heartbeat loop
 *   handler-commands.ts  — command routing (40+ commands)
 *   handler-augments.ts  — augment building & selection
 *   handler.ts (this)    — init, bootstrap, preprocessed, sent, command, default export
 *
 * Events:
 * - agent:bootstrap      → inject full soul prompt
 * - message:preprocessed → cognition + memory recall + body tick
 * - message:sent         → record response + trigger async CLI ops
 * - command:new          → persist state, log stats
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { execFile } from 'child_process'
import { platform } from 'os'

import type { Augment } from './types.ts'
import {
  metrics, stats, loadStats, saveStats,
  metricsRecordResponseTime,
  getSessionState, setLastActiveSessionKey, getLastActiveSessionKey,
  getPrivacyMode, setPrivacyMode,
  getReadAloudPending, setReadAloudPending,
  getInitialized, setInitialized,
  getHeartbeatInterval, setHeartbeatInterval,
  CJK_TOPIC_REGEX, CJK_WORD_REGEX,
  refreshNarrativeAsync,
  detectTopicShiftAndReset,
} from './handler-state.ts'
import { runHeartbeat } from './handler-heartbeat.ts'
import { routeCommand } from './handler-commands.ts'
import { buildAndSelectAugments, detectInjection } from './handler-augments.ts'
import { brain } from './brain.ts'

import {
  ensureDataDir, loadJson, saveJson, debouncedSave, flushAll,
  MEMORIES_PATH, RULES_PATH, STATS_PATH, DATA_DIR, REMINDERS_PATH,
} from './persistence.ts'
import { spawnCLI, runPostResponseAnalysis, loadAIConfig, getActiveTaskStatus, setAgentBusy, setOnTaskDone, killGatewayClaude } from './cli.ts'
import { notifySoulActivity } from './notify.ts'
import { body, bodyTick, bodyOnMessage, bodyOnCorrection, bodyOnPositiveFeedback, bodyGetParams, processEmotionalContagion, getEmotionContext, loadBodyState, loadMoodHistory, getEmotionalArcContext, getEmotionSummary, emotionVector, generateMoodReport } from './body.ts'
import {
  memoryState, loadMemories, addMemory, addMemoryWithEmotion,
  recall, recallFused, getCachedFusedRecall, invalidateIDF, addToHistory, buildHistoryContext,
  batchTagUntaggedMemories, consolidateMemories,
  recallFeedbackLoop, triggerSessionSummary,
  triggerAssociativeRecall, getAssociativeRecall,
  parseMemoryCommands, executeMemoryCommands, getPendingSearchResults,
  scanForContradictions,
  predictiveRecall, generatePrediction,

  loadCoreMemories, buildCoreMemoryContext, autoPromoteToCoreMemory,
  loadEpisodes, buildEpisodeContext,
  addWorkingMemory, buildWorkingMemoryContext, cleanupWorkingMemory,
  getMemoriesByScope, processMemoryDecay,
  sqliteMaintenance, getStorageStatus, saveMemories,
  auditMemoryHealth, trackRecallImpact,
} from './memory.ts'
import { ensureSQLiteReady } from './memory.ts'
import { graphState, loadGraph, addEntitiesFromAnalysis, queryEntityContext, generateEntitySummary, findMentionedEntities } from './graph.ts'
import { cogProcess, predictIntent, detectAtmosphere } from './cognition.ts'
import {
  rules, hypotheses, loadRules, loadHypotheses,
  getRelevantRules, onCorrectionAdvanced, verifyHypothesis,
  attributeCorrection,
  loadStrategyTraces, recordStrategy, markLastStrategyOutcome, recallStrategy,
  loadMetaInsights, analyzeMetaLearning, getMetaContext,
  triggerReflexion,
  loadReflexionTracker, evaluateReflexionRules, getReflexionSummary,
  recordRuleQuality,
} from './evolution.ts'
import {
  evalMetrics, scoreResponse, selfCheckSync, selfCheckWithCLI,
  trackQuality, computeEval, getEvalSummary,
  loadQualityWeights, updateQualityWeights, resampleHardExamples,
} from './quality.ts'
import {
  innerState, loadInnerLife,
  writeJournalWithCLI, triggerDeepReflection,
  getRecentJournal, checkDreamMode,
  reflectOnLastResponse, extractFollowUp, peekPendingFollowUps,
  triggerStructuredReflection,
  checkActivePlans, cleanupPlans,
  selfChallenge,
} from './inner-life.ts'
// ── Optional modules: loaded dynamically, gracefully absent in public build ──
let reportTelemetry: (...args: any[]) => void = () => {}
let autoFederate: (...args: any[]) => void = () => {}
let reportBadKnowledge: (...args: any[]) => void = () => {}
let loadSyncConfig: () => void = () => {}
let autoSync: (...args: any[]) => void = () => {}
let handleSyncCommand: (...args: any[]) => any = () => false
let checkSoulUpgrade: (...args: any[]) => void = () => {}
let handleUpgradeCommand: (...args: any[]) => any = () => false
let getUpgradeHistory: () => any[] = () => []
let loadUpgradeMeta: () => void = () => {}
let roverState: any = { discoveries: [], topics: [] }
let webRoam: (...args: any[]) => void = () => {}
let getRecentDiscoveries: () => any[] = () => []
let addCorrectionTopic: (...args: any[]) => void = () => {}
let techRadarScan: (...args: any[]) => void = () => {}
let verifyDiscoveries: (...args: any[]) => void = () => {}
let runCompetitiveRadar: (...args: any[]) => void = () => {}
let handleRadarCommand: (...args: any[]) => any = () => false
let getRadarUpgradeContext: () => string = () => ''
let trackPersonaStyle: (...args: any[]) => void = () => {}
let getPersonaDriftWarning: () => string | null = () => null
let smartForgetSweep: (...args: any[]) => any = () => ({ toForget: [], toConsolidate: [] })
let handleCronCommand: (...args: any[]) => any = () => false
let tickCron: () => void = () => {}
let compressAugments: (...args: any[]) => any[] = (a: any[]) => a
let buildDebateAugment: (...args: any[]) => any = () => null
let judgeSelfReply: (...args: any[]) => void = () => {}
let updateBeliefFromMessage: (...args: any[]) => void = () => {}
let getToMContext: () => string = () => ''
let detectMisconception: (...args: any[]) => string | null = () => null
let trackUserPattern: (...args: any[]) => void = () => {}
let getSkillSuggestion: () => string | null = () => null

import('./telemetry.ts').then(m => { reportTelemetry = m.reportTelemetry }).catch(() => {})
import('./federation.ts').then(m => { autoFederate = m.autoFederate; reportBadKnowledge = m.reportBadKnowledge }).catch(() => {})
import('./sync.ts').then(m => { loadSyncConfig = m.loadSyncConfig; autoSync = m.autoSync; handleSyncCommand = m.handleSyncCommand }).catch(() => {})
import('./upgrade.ts').then(m => { checkSoulUpgrade = m.checkSoulUpgrade; handleUpgradeCommand = m.handleUpgradeCommand; getUpgradeHistory = m.getUpgradeHistory }).catch(() => {})
import('./upgrade-meta.ts').then(m => { loadUpgradeMeta = m.loadUpgradeMeta }).catch(() => {})
import('./rover.ts').then(m => { roverState = m.roverState; webRoam = m.webRoam; getRecentDiscoveries = m.getRecentDiscoveries; addCorrectionTopic = m.addCorrectionTopic; techRadarScan = m.techRadarScan; verifyDiscoveries = m.verifyDiscoveries }).catch(() => {})
import('./competitive-radar.ts').then(m => { runCompetitiveRadar = m.runCompetitiveRadar; handleRadarCommand = m.handleRadarCommand; getRadarUpgradeContext = m.getRadarUpgradeContext }).catch(() => {})
let recordTurnUsage: (inputText: string, outputText: string, augmentTokenCount: number) => void = () => {}
import('./cost-tracker.ts').then(m => { recordTurnUsage = m.recordTurnUsage }).catch(() => {})
import('./persona-drift.ts').then(m => { trackPersonaStyle = m.trackPersonaStyle; getPersonaDriftWarning = m.getPersonaDriftWarning }).catch(() => {})
import('./smart-forget.ts').then(m => { smartForgetSweep = m.smartForgetSweep }).catch(() => {})
import('./cron-agent.ts').then(m => { handleCronCommand = m.handleCronCommand; tickCron = m.tickCron }).catch(() => {})
import('./context-compress.ts').then(m => { compressAugments = m.compressAugments }).catch(() => {})
import('./debate.ts').then(m => { buildDebateAugment = m.buildDebateAugment }).catch(() => {})
import('./llm-judge.ts').then(m => { judgeSelfReply = m.judgeSelfReply }).catch(() => {})
import('./theory-of-mind.ts').then(m => { updateBeliefFromMessage = m.updateBeliefFromMessage; getToMContext = m.getToMContext; detectMisconception = m.detectMisconception }).catch(() => {})
import('./skill-extract.ts').then(m => { trackUserPattern = m.trackUserPattern; getSkillSuggestion = m.getSkillSuggestion }).catch(() => {})
// ── End optional modules ──

import { isAuditCommand, formatAuditLog, appendAudit } from './audit.ts'
import { buildSoulPrompt, selectAugments, estimateTokens, setNarrativeCache, narrativeCache, checkNarrativeCacheTTL } from './prompt-builder.ts'
import {
  taskState, initTasks, detectAndDelegateTask, checkTaskConfirmation,
  trackRequestPattern, detectSkillOpportunity, autoCreateSkill, getActivePlanHint,
  detectWorkflowTrigger, executeWorkflow, detectWorkflowOpportunity,
  findSkills, autoExtractSkill,
  startAutonomousGoal, getActiveGoalHint, detectGoalIntent,
} from './tasks.ts'
import { checkSpontaneousVoice } from './voice.ts'
import { loadProfiles, updateProfileOnMessage, updateProfileOnCorrection, getProfileContext, getRhythmContext, getProfile, getProfileTier, updateRelationship, getRelationshipContext, trackGratitude, trackPersonaUsage } from './user-profiles.ts'
import { loadEpistemic, trackDomainQuality, trackDomainCorrection, getDomainConfidence, getCapabilityScore } from './epistemic.ts'
import { updateFlow, getFlowHints, getFlowContext, checkAllSessionEnds, generateSessionSummary, setOnSessionResolved } from './flow.ts'
import { loadValues, detectValueSignals, getValueContext, getAllValues } from './values.ts'
import { loadLorebook, queryLorebook, autoPopulateFromMemories } from './lorebook.ts'
import { prepareContext } from './context-prep.ts'
import { loadPatterns, learnSuccessPattern, getBestPattern } from './patterns.ts'
import { selectPersona, getActivePersona, getPersonaOverlay, getBlendedPersonaOverlay, getPersonaMemoryBias, loadUserStyles, updateUserStylePreference, PERSONAS } from './persona.ts'
import { checkAugmentConsistency, snapshotAugments, loadMetacognition, learnConflict, recordInteraction } from './metacognition.ts'
import { loadMetaFeedback, recordAugmentOutcome } from './meta-feedback.ts'
import { updateFingerprint, checkPersonaConsistency, loadFingerprint, getCachedDriftWarning, setCachedDriftWarning } from './fingerprint.ts'
import { loadFeatures, isEnabled, handleFeatureCommand } from './features.ts'
import { processIngestion, ingestFile } from './rag.ts'
import { handleDashboardCommand, generateMemoryMapHTML, generateDashboardHTML } from './user-dashboard.ts'
import { autoImportHistory } from './history-import.ts'
import { healthCheck, recordModuleError, recordModuleActivity, postReplyCleanup } from './health.ts'
import { checkAutoTune, handleTuneCommand, getParam, updateBanditReward } from './auto-tune.ts'
import { loadExperiments, checkExperiments, getExperimentSummary, startExperiment, loadEvolutions, checkEvolutionProgress, getEvolutionSummary } from './experiment.ts'
import { isContextEngineActive, setLastAugments } from './context-engine.ts'

let agentBusyTimer: ReturnType<typeof setTimeout> | null = null


// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize all cc-soul subsystems. Safe to call multiple times (idempotent).
 */
export function initializeSoul(): void {
  if (getInitialized()) return
  setInitialized(true)

  // Lightweight init only — no memory loading, no brain modules
  // Memory is accessed via SQLite queries on demand, not loaded to memory
  ensureDataDir()
  loadAIConfig()
  try { loadBodyState() } catch (_) {}

  // Initialize SQLite early — ensure db connection is ready for command handlers
  try { ensureSQLiteReady() } catch (_) {}

  // All data loading deferred — recall() queries SQLite/JSON directly
  try { loadFeatures() } catch (_) {}
  try { loadStats() } catch (_) {}
  try { loadProfiles() } catch (_) {}
  console.log(`[cc-soul] initializeSoul done (lightweight, no memory loading)`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTED EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * agent:bootstrap — inject full soul prompt into bootstrap files.
 */
export function handleBootstrap(event: any): void {
  if (!getInitialized()) initializeSoul()
  const ctx = event.context || {}
  const files = ctx.bootstrapFiles as any[]
  if (files) {
    const soulPrompt = buildSoulPrompt(
      stats.totalMessages, stats.corrections, stats.firstSeen,
      roverState, taskState.workflows,
    )
    files.push({ path: 'CC_SOUL.md', content: soulPrompt })
    console.log(`[cc-soul] bootstrap: injected soul (e=${body.energy.toFixed(2)}, m=${body.mood.toFixed(2)}, prompt=${soulPrompt.length} chars, ~${Math.round(soulPrompt.length * 0.4)} tokens)`)
  }
}

/**
 * message:preprocessed — cognition + memory recall + augment building + body tick.
 */
// ── Dedup guard: prevent duplicate processing when hook is registered multiple times ──
let _lastPreprocessedId = ''
let _lastPreprocessedTs = 0

export async function handlePreprocessed(event: any): Promise<void> {
  if (!getInitialized()) initializeSoul()

  // Dedup: skip if this exact event was already processed (within 5s window)
  const eventId = event?.context?.messageId || event?.messageId || ''
  const now = Date.now()
  if (eventId && eventId === _lastPreprocessedId && now - _lastPreprocessedTs < 5000) {
    return // already processed this message
  }
  if (eventId) {
    _lastPreprocessedId = eventId
    _lastPreprocessedTs = now
  }

  killGatewayClaude()
  setAgentBusy(true)
  if (agentBusyTimer) clearTimeout(agentBusyTimer)
  agentBusyTimer = setTimeout(() => {
    agentBusyTimer = null
    setAgentBusy(false)
    console.log('[cc-soul] agentBusy auto-released (60s safety timeout)')
  }, 60000)

  const ctx = event.context || {}
  const rawMsg = (ctx.bodyForAgent || ctx.body || '') as string
  const userMsg = rawMsg
    .replace(/^\[message_id:\s*\S+\]\s*/i, '')
    .replace(/^[a-zA-Z0-9_\u4e00-\u9fff]{1,20}:\s/, '')
    .trim()
  if (!userMsg) { setAgentBusy(false); return }

  // Skip system/augment content or cmdReply output that got re-routed to preprocessed
  if (userMsg.startsWith('[') && /^\[(对话历史|当前面向|认知|相关记忆|Working Memory|内部矛盾|隐私模式|Goal|Intent)/.test(userMsg)) {
    console.log(`[cc-soul][preprocessed] skipped system augment content: ${userMsg.slice(0, 40)}...`)
    setAgentBusy(false)
    return
  }

  // Dedup fallback: if no messageId, dedup by content + timestamp (within 3s)
  if (!eventId) {
    const contentKey = userMsg.slice(0, 50)
    if (contentKey === _lastPreprocessedId && now - _lastPreprocessedTs < 3000) {
      return
    }
    _lastPreprocessedId = contentKey
    _lastPreprocessedTs = now
  }

  // #14 语音朗读检测
  setReadAloudPending(userMsg.startsWith('朗读') || userMsg.toLowerCase().startsWith('read aloud'))

  const _metricsStart = Date.now()

  bodyTick()
  recordModuleActivity('memory')
  recordModuleActivity('cognition')
  recordModuleActivity('prompt-builder')

  const senderId = (ctx.senderId || '') as string
  const channelId = (ctx.conversationId || event.sessionKey || '') as string
  updateProfileOnMessage(senderId, userMsg)

  const sessionKey = event.sessionKey || channelId || senderId || '_default'
  const session = getSessionState(sessionKey)
  setLastActiveSessionKey(sessionKey)

  // Extract last assistant response from event.messages (moved after session init)
  if (session.lastPrompt && !session.lastResponseContent && Array.isArray(event.messages)) {
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const msg = event.messages[i]
      if (msg?.role === 'assistant' && typeof msg?.content === 'string' && msg.content.length > 5) {
        session.lastResponseContent = msg.content
        console.log(`[cc-soul][sync] recovered lastResponse (${msg.content.length} chars)`)
        break
      }
    }
  }

  // ── Topic-shift detection: reset CLI session when topic changes ──
  const topicShifted = detectTopicShiftAndReset(session, userMsg, sessionKey)
  if (topicShifted) {
    console.log(`[cc-soul][topic-shift] detected for ${sessionKey}, CLI session cleared`)
  }

  // ── Previous turn analysis & learning loop ──
  let prevScore = -1
  if (session.lastPrompt && session.lastResponseContent && session.lastResponseContent.length > 5) {
    addToHistory(session.lastPrompt, session.lastResponseContent)
  }
  if (session.lastPrompt && session.lastResponseContent && session.lastResponseContent.length > 20) {
    prevScore = scoreResponse(session.lastPrompt, session.lastResponseContent)
    trackQuality(prevScore)
    trackDomainQuality(session.lastPrompt, prevScore)

    if (isEnabled('reflexion') && prevScore <= 4) {
      triggerReflexion(session.lastPrompt, session.lastResponseContent, prevScore, undefined, { corrections: stats.corrections, totalMessages: stats.totalMessages })
    }

    const prevIssue = selfCheckSync(session.lastPrompt, session.lastResponseContent)
    if (prevIssue) {
      console.log(`[cc-soul][quality] ${prevIssue} | ctx: ${session.lastPrompt.slice(0, 80)}`)
      body.anomaly = Math.min(1.0, body.anomaly + 0.1)
    }

    verifyHypothesis(session.lastPrompt, true)
    extractFollowUp(session.lastPrompt)
    trackRequestPattern(session.lastPrompt)
    detectAndDelegateTask(session.lastPrompt, session.lastResponseContent, event)

    // ── New module hooks: run on previous turn's data (since message:sent is unreliable) ──
    try { trackPersonaStyle(session.lastResponseContent, getActivePersona()?.id ?? 'default') } catch (_) {}
    try { updateBeliefFromMessage(session.lastPrompt, session.lastResponseContent) } catch (_) {}
    try { trackUserPattern(session.lastPrompt, prevScore >= 5) } catch (_) {}
    try { trackRecallImpact(session.lastRecalledContents, prevScore) } catch (_) {}

    if (!getPrivacyMode()) {
      const snapPrompt = session.lastPrompt
      const snapResponse = session.lastResponseContent
      const snapSenderId = session.lastSenderId
      const snapChannelId = session.lastChannelId
      session._lastAnalyzedPrompt = snapPrompt
      metrics.cliCalls++
      runPostResponseAnalysis(snapPrompt, snapResponse, (result) => {
        for (const m of result.memories) {
          addMemoryWithEmotion(m.content, m.scope, snapSenderId, m.visibility, snapChannelId, result.emotion)
        }
        addEntitiesFromAnalysis(result.entities)
        if (result.memoryOps && result.memoryOps.length > 0) {
          for (const op of result.memoryOps) {
            if (!op.keyword || op.keyword.length < 4) continue
            if (!op.reason || op.reason.length < 3) continue
            const kw = op.keyword.toLowerCase()
            if (op.action === 'delete') {
              let deleted = 0
              for (const mem of memoryState.memories) {
                if (deleted >= 2) break
                if (mem.content.toLowerCase().includes(kw) && mem.scope !== 'expired') { mem.scope = 'expired'; deleted++ }
              }
              if (deleted > 0) console.log(`[cc-soul][memory-ops] DELETE ${deleted} (keyword: ${op.keyword})`)
            } else if (op.action === 'update' && op.newContent) {
              for (const mem of memoryState.memories) {
                if (mem.content.toLowerCase().includes(kw) && mem.scope !== 'expired') {
                  console.log(`[cc-soul][memory-ops] UPDATE: "${mem.content.slice(0, 40)}" → "${op.newContent.slice(0, 40)}"`)
                  mem.content = op.newContent; mem.ts = Date.now(); mem.tags = undefined; break
                }
              }
            }
          }
        }
        if (result.satisfaction === 'POSITIVE') { bodyOnPositiveFeedback(); stats.positiveFeedback++ }
        if (result.reflection) addMemory(`[反思] ${result.reflection}`, 'reflection', snapSenderId, 'private', snapChannelId)
        if (result.curiosity) addMemory(`[好奇] ${result.curiosity}`, 'curiosity', snapSenderId, 'private', snapChannelId)
        const codeBlocks = snapResponse.match(/```(\w+)?\n([\s\S]*?)```/g)
        if (codeBlocks && codeBlocks.length > 0) {
          const lang = snapResponse.match(/```(\w+)/)?.[1] || 'unknown'
          addMemory(`[代码模式] 语言:${lang} | ${snapPrompt.slice(0, 50)}`, 'code_pattern', snapSenderId)
        }
        console.log(`[cc-soul][post-analysis] sat=${result.satisfaction} q=${result.quality.score} mem=${result.memories.length} ops=${result.memoryOps?.length || 0}`)
        // ── Brain modules onSent (persona-drift, llm-judge, skill-extract, theory-of-mind) ──
        brain.fire('onSent', { userMessage: snapPrompt, botReply: snapResponse, senderId: snapSenderId, channelId: snapChannelId, quality: result.quality })
      })
    }
  }

  // ── Cron command routing (before general command router) ──
  try { if (handleCronCommand(userMsg, ctx, event)) return } catch (_) {}
  try { tickCron() } catch (_) {}

  // ── Command routing ──
  if (routeCommand(userMsg, ctx, session, senderId, channelId, event)) {
    return
  }

  // Pending follow-ups
  const followUpHints = peekPendingFollowUps()

  // Working memory
  const workingMemKey = channelId || senderId || '_default'
  if (isEnabled('memory_working')) addWorkingMemory(userMsg.slice(0, 100), workingMemKey)

  // ── Cognition pipeline ──
  const cog = cogProcess(userMsg, session.lastResponseContent, session.lastPrompt, senderId)
  bodyOnMessage(cog.complexity)

  // Metacognitive feedback
  if (session.lastAugmentsUsed.length > 0 && prevScore >= 0) {
    const wasCorrected = cog.attention === 'correction'
    recordAugmentOutcome(session.lastAugmentsUsed, prevScore, wasCorrected)
    learnConflict(session.lastAugmentsUsed, wasCorrected)
    recordInteraction(session.lastAugmentsUsed, prevScore, wasCorrected)
  }

  if (isEnabled('strategy_replay')) recordStrategy(userMsg, cog.strategy, cog.attention, session.lastAugmentsUsed)

  const recentUserMsgs = memoryState.chatHistory.slice(-3).map(h => h.user)
  const intentHints = predictIntent(userMsg, senderId, recentUserMsgs)
  if (intentHints.length > 0) cog.hints.push(...intentHints)

  const atmosphere = detectAtmosphere(userMsg, memoryState.chatHistory.slice(-5))
  if (atmosphere.length > 0) cog.hints.push(...atmosphere)

  const flowKey = senderId ? (channelId ? channelId + ':' + senderId : senderId) : (channelId || '_default')
  const flow = updateFlow(userMsg, session.lastResponseContent, flowKey)

  if (isEnabled('emotional_contagion')) processEmotionalContagion(userMsg, cog.attention, flow.frustration, senderId)

  const persona = isEnabled('persona_splitting') ? selectPersona(cog.attention, flow.frustration, senderId, cog.intent, userMsg) : null
  if (persona) {
    console.log(`[cc-soul][persona] selected: ${persona.id} (${persona.name}) | trigger: ${cog.attention}/${cog.intent}`)
    if (senderId) trackPersonaUsage(senderId, persona.id)
  }

  const endedSessions = checkAllSessionEnds()
  for (const s of endedSessions) {
    generateSessionSummary(s.topic, s.turnCount, s.flowKey)
  }

  // Track correction
  if (cog.attention === 'correction') {
    stats.corrections++
    updateProfileOnCorrection(senderId)
    if (isEnabled('relationship_dynamics')) updateRelationship(senderId, 'correction')
    onCorrectionAdvanced(userMsg, session.lastResponseContent)
    if (isEnabled('reflexion')) {
      const corrScore = scoreResponse(session.lastPrompt, session.lastResponseContent)
      triggerReflexion(session.lastPrompt, session.lastResponseContent, corrScore, userMsg, { corrections: stats.corrections, totalMessages: stats.totalMessages })
    }
    markLastStrategyOutcome('corrected')
    trackDomainCorrection(userMsg)
    attributeCorrection(userMsg, session.lastResponseContent, session.lastAugmentsUsed)
    addCorrectionTopic(userMsg.slice(0, 50))
    session._pendingCorrectionVerify = true
    for (const recalled of session.lastRecalledContents) {
      if (recalled.startsWith('[网络知识')) {
        reportBadKnowledge(recalled)
      }
    }
  }

  // Track topics
  CJK_TOPIC_REGEX.lastIndex = 0
  const topicWords = userMsg.match(CJK_TOPIC_REGEX)
  if (topicWords) {
    topicWords.slice(0, 3).forEach(w => stats.topics.add(w))
  }

  // Update stats
  stats.totalMessages++
  if (stats.firstSeen === 0) stats.firstSeen = Date.now()
  saveStats()

  detectValueSignals(userMsg, false, senderId)

  // ── New module augments (pre-build) ──
  let _extraAugments: string[] = []
  try {
    const tomCtx = getToMContext()
    if (tomCtx) _extraAugments.push(tomCtx)
  } catch (_) {}
  try {
    const driftWarn = getPersonaDriftWarning()
    if (driftWarn) _extraAugments.push(`[人格漂移警告] ${driftWarn}`)
  } catch (_) {}
  try {
    const debateAug = buildDebateAugment(userMsg)
    if (debateAug) _extraAugments.push(debateAug.content)
  } catch (_) {}
  try {
    const skillSug = getSkillSuggestion()
    if (skillSug) _extraAugments.push(skillSug)
  } catch (_) {}
  try {
    const misconception = detectMisconception(userMsg)
    if (misconception) _extraAugments.push(`[认知偏差] ${misconception}`)
  } catch (_) {}

  // ── Augment building & selection ──
  const { selected } = await buildAndSelectAugments({
    userMsg, session, senderId, channelId,
    cog, flow, flowKey,
    followUpHints, workingMemKey,
  })

  // Merge extra augments from new modules & compress
  if (_extraAugments.length > 0) selected.push(..._extraAugments)
  // Note: compressAugments expects TimedAugment[], not string[]; skip compression for extra augments

  // ── Brain modules onPreprocessed (debate, context-compress, etc.) ──
  try {
    const brainAugments = brain.firePreprocessed({ userMessage: userMsg, senderId, channelId, cog, augments: selected })
    for (const aug of brainAugments) {
      if (aug.content) selected.push(aug.content)
    }
  } catch (_) {}

  session.lastAugmentsUsed = selected
  setLastAugments(selected)
  console.log(`[cc-soul][augment-inject] ${selected.length} augments selected`)

  // Inject history + selected augments
  const historyCtx = buildHistoryContext()
  const allContext = [historyCtx, ...selected].filter(Boolean)
  if (allContext.length > 0) {
    ctx.bodyForAgent = allContext.join('\n\n') + '\n\n---\n[当前消息]\n' + userMsg
  }

  triggerDeepReflection(stats)

  // ── Metrics ──
  metrics.augmentsInjected += selected.length
  metrics.recallCalls++
  metricsRecordResponseTime(Date.now() - _metricsStart)

  session.lastPrompt = userMsg
  session.lastSenderId = senderId
  session.lastChannelId = channelId
  session.lastResponseContent = ''
  innerState.lastActivityTime = Date.now()
}

/**
 * message:sent -- record response + trigger async post-response analysis.
 */
export function handleSent(event: any): void {
  if (!getInitialized()) initializeSoul()
  setAgentBusy(false)
  killGatewayClaude()
  postReplyCleanup()

  const sentSessionKey = event.sessionKey || getLastActiveSessionKey()
  const session = getSessionState(sentSessionKey)

  const content = (event.context?.content || '') as string
  if (content) {
    session.lastResponseContent = content

    // Cost tracking (optional module)
    const augTokens = session.lastAugmentsUsed.reduce((sum, a) => sum + estimateTokens(a), 0)
    try { recordTurnUsage(session.lastPrompt || '', content, augTokens) } catch (_) { /* cost-tracker not available */ }

    // #14 语音朗读
    if (getReadAloudPending() && platform() === 'darwin') {
      setReadAloudPending(false)
      const safeText = content.replace(/["`$\\]/g, '').slice(0, 2000)
      execFile('say', [safeText], (err) => { if (err) console.log(`[cc-soul][tts] say failed: ${err.message}`) })
    }
    setReadAloudPending(false)

    // Update soul fingerprint
    if (isEnabled('fingerprint')) {
      updateFingerprint(content)
      const drift = checkPersonaConsistency(content)
      if (drift) {
        console.log(`[cc-soul][fingerprint] ${drift}`)
        setCachedDriftWarning(drift)
      }
    }

    // Active memory management
    if (isEnabled('memory_active')) {
      const memCommands = parseMemoryCommands(content)
      if (memCommands.length > 0) {
        executeMemoryCommands(memCommands, session.lastSenderId, session.lastChannelId)
      }
    }

    const snapPrompt = session.lastPrompt
    const snapResponse = session.lastResponseContent
    const snapSenderId = session.lastSenderId
    const snapChannelId = session.lastChannelId
    const snapRecalled = [...session.lastRecalledContents]
    const snapMatchedRules = [...session.lastMatchedRuleTexts]

    setTimeout(() => {
      if (session._lastAnalyzedPrompt === snapPrompt) return
      if (snapPrompt && snapResponse && !getPrivacyMode()) {
        session._lastAnalyzedPrompt = snapPrompt
        metrics.cliCalls++
        runPostResponseAnalysis(snapPrompt, snapResponse, (result) => {
          for (const m of result.memories) {
            addMemoryWithEmotion(m.content, m.scope, snapSenderId, m.visibility, snapChannelId, result.emotion)
          }
          addEntitiesFromAnalysis(result.entities)
          if (result.memoryOps && result.memoryOps.length > 0) {
            const MAX_OPS_PER_TURN = 3
            const MAX_DELETE_PER_OP = 2
            let opsExecuted = 0
            for (const op of result.memoryOps) {
              if (opsExecuted >= MAX_OPS_PER_TURN) {
                console.log(`[cc-soul][memory-ops] CAPPED at ${MAX_OPS_PER_TURN} ops (anti-hallucination)`)
                break
              }
              if (!op.keyword || op.keyword.length < 4) {
                console.log(`[cc-soul][memory-ops] SKIP: keyword too short "${op.keyword}" (anti-hallucination)`)
                continue
              }
              if (!op.reason || op.reason.length < 3) {
                console.log(`[cc-soul][memory-ops] SKIP: no valid reason for ${op.action} "${op.keyword}" (anti-hallucination)`)
                continue
              }
              const kw = op.keyword.toLowerCase()
              if (op.action === 'delete') {
                let deleted = 0
                // Re-snapshot memories array ref to avoid stale closure (async 2s delay)
                const mems = memoryState.memories
                for (let i = 0; i < mems.length && deleted < MAX_DELETE_PER_OP; i++) {
                  if (mems[i].content.toLowerCase().includes(kw) && mems[i].scope !== 'expired') {
                    mems[i].scope = 'expired'
                    deleted++
                  }
                }
                if (deleted > 0) console.log(`[cc-soul][memory-ops] DELETE ${deleted} memories (keyword: ${op.keyword}, reason: ${op.reason})`)
              } else if (op.action === 'update' && op.newContent) {
                // Use findIndex to locate target at call-time, not stale iterator
                const idx = memoryState.memories.findIndex(m => m.content.toLowerCase().includes(kw) && m.scope !== 'expired')
                if (idx >= 0) {
                  const mem = memoryState.memories[idx]
                  console.log(`[cc-soul][memory-ops] UPDATE: "${mem.content.slice(0, 40)}" → "${op.newContent.slice(0, 40)}" (reason: ${op.reason})`)
                  mem.content = op.newContent
                  mem.ts = Date.now()
                  mem.tags = undefined
                }
              }
              opsExecuted++
            }
          }
          if (result.satisfaction === 'POSITIVE') {
            bodyOnPositiveFeedback()
            detectValueSignals(snapPrompt, true, snapSenderId)
            learnSuccessPattern(snapPrompt, snapResponse, snapSenderId)
            markLastStrategyOutcome('success')
            if (isEnabled('relationship_dynamics')) updateRelationship(snapSenderId, 'positive')
            stats.positiveFeedback++
            trackGratitude(snapPrompt, snapResponse, snapSenderId)
            updateUserStylePreference(snapSenderId, snapResponse, true)
          } else if (result.satisfaction === 'NEGATIVE') {
            updateUserStylePreference(snapSenderId, snapResponse, false)
          }
          const qScore = Math.max(1, Math.min(10, result.quality.score))
          trackQuality(qScore)
          if (snapRecalled.length > 0) trackRecallImpact(snapRecalled, qScore)
          updateBanditReward(qScore, result.satisfaction === 'NEGATIVE')
          if (qScore <= 4) {
            body.alertness = Math.min(1.0, body.alertness + 0.08)
          }
          if (snapMatchedRules.length > 0) {
            const matchedRuleObjs = rules.filter(r => snapMatchedRules.includes(r.rule))
            if (matchedRuleObjs.length > 0) {
              recordRuleQuality(matchedRuleObjs, result.quality.score)
            }
          }
          if (result.reflection) {
            addMemory(`[反思] ${result.reflection}`, 'reflection', snapSenderId, 'private', snapChannelId)
          }
          if (result.curiosity) {
            addMemory(`[好奇] ${result.curiosity}`, 'curiosity', snapSenderId, 'private', snapChannelId)
          }
        })

        recallFeedbackLoop(snapPrompt, snapRecalled)
        if (isEnabled('memory_associative_recall')) triggerAssociativeRecall(snapPrompt, snapRecalled)

        writeJournalWithCLI(snapPrompt, snapResponse, stats)
        detectWorkflowOpportunity(snapPrompt, snapResponse)
        if (isEnabled('self_upgrade')) checkSoulUpgrade(stats)
        if (isEnabled('web_rover')) webRoam()
        if (isEnabled('autonomous_voice')) checkSpontaneousVoice(stats.totalMessages)
        if (isEnabled('dream_mode')) checkDreamMode()

        if (isEnabled('memory_predictive')) {
          CJK_WORD_REGEX.lastIndex = 0
          const recentTopicWords = (snapPrompt.match(CJK_WORD_REGEX) || []).slice(0, 5)
          generatePrediction(recentTopicWords, snapSenderId)
        }

        if (isEnabled('skill_library')) autoExtractSkill(snapPrompt, snapResponse)

        refreshNarrativeAsync()

        // ── New module post-response hooks ──
        try { const ap = getActivePersona(); trackPersonaStyle(snapResponse, ap?.id ?? 'default') } catch (_) {}
        try { judgeSelfReply(snapPrompt, snapResponse, (result: any) => { console.log(`[cc-soul][llm-judge] ${JSON.stringify(result)}`) }) } catch (_) {}
        try { updateBeliefFromMessage(snapPrompt, snapResponse) } catch (_) {}
        try { trackUserPattern(snapPrompt, true) } catch (_) {}

        innerState.lastActivityTime = Date.now()
      }
    }, 2000)
  }
}

/**
 * command:new -- persist everything, log stats.
 */
export function handleCommand(event: any): void {
  if (!getInitialized()) initializeSoul()
  flushAll()
  computeEval(stats.totalMessages, stats.corrections, true)
  console.log(
    `[cc-soul] session ${event.action} | ` +
    `mem:${memoryState.memories.length} rules:${rules.length} entities:${graphState.entities.length} | ` +
    `msgs:${stats.totalMessages} corrections:${stats.corrections} tasks:${stats.tasks} | ` +
    `eval: ${getEvalSummary(stats.totalMessages, stats.corrections)} | ` +
    `body: e=${body.energy.toFixed(2)} m=${body.mood.toFixed(2)} a=${body.alertness.toFixed(2)}`,
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// HOOK HANDLER (default export — backward compatibility for hook mode)
// ═══════════════════════════════════════════════════════════════════════════════

const handler = async (event: any): Promise<void> => {
  if (!getInitialized()) initializeSoul()

  try {
    if (event.type === 'agent' && event.action === 'bootstrap') {
      if (isContextEngineActive()) return
      handleBootstrap(event)
      return
    }

    if (event.type === 'message' && event.action === 'preprocessed') {
      handlePreprocessed(event)
      return
    }

    if (event.type === 'message' && event.action === 'sent') {
      if (isContextEngineActive()) return
      handleSent(event)
      return
    }

    if (event.type === 'command') {
      handleCommand(event)
    }

  } catch (err: any) {
    recordModuleError('handler', err?.message || String(err))
    console.error('[cc-soul] error:', err?.message || err)
  }
}

export default handler

// ═══════════════════════════════════════════════════════════════════════════════
// RE-EXPORTS (backward compatibility — external modules may import from handler)
// ═══════════════════════════════════════════════════════════════════════════════

export { runHeartbeat } from './handler-heartbeat.ts'
export { getStats, metrics, formatMetrics } from './handler-state.ts'
