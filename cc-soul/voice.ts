/**
 * voice.ts — Autonomous voice: cc proactively initiates conversation
 *
 * Ported from handler.ts lines 3116-3194.
 * cc doesn't say "good morning" on a schedule. It speaks when inner state
 * accumulates enough impulse — driven by curiosity, discoveries, follow-ups,
 * or simply missing the user.
 *
 * v2: purposeful proactive messaging (scan action plans) + wellness check-ins
 */

import type { SoulModule } from './brain.ts'
import { spawnCLI } from './cli.ts'
import { body } from './body.ts'
import { memoryState, addMemory } from './memory.ts'
// ── Optional modules (absent in public build) ──
let shouldSeekPeriodicFeedback: () => boolean = () => false
let markFeedbackAsked: () => void = () => {}
import('./upgrade-experience.ts').then(m => { shouldSeekPeriodicFeedback = m.shouldSeekPeriodicFeedback; markFeedbackAsked = m.markFeedbackAsked }).catch(() => {})
let roverState: { discoveries: any[]; topics: string[] } = { discoveries: [], topics: [] }
import('./rover.ts').then(m => { roverState = m.roverState }).catch(() => {})
// ── End optional modules ──
import { innerState, peekPendingFollowUps, markFollowUpsAsked } from './inner-life.ts'
import { notifySoulActivity } from './notify.ts'
import { notifyOwnerDM } from './notify.ts'
import { getUserPeakHour, profiles, getProfile } from './user-profiles.ts'
import { getActivePlanHint, getActiveGoalHint } from './tasks.ts'
import { getUnresolvedTopics } from './flow.ts'
import { getParam } from './auto-tune.ts'

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

export const voiceState = {
  lastProactiveMsg: 0,
}

const PROACTIVE_COOLDOWN = 3600000 // 1 hour minimum interval

// ═══════════════════════════════════════════════════════════════════════════════
// PURPOSEFUL MESSAGING — scan action items instead of random impulse
// ═══════════════════════════════════════════════════════════════════════════════

function scanActionItems(): { impulse: number; reason: string; context: string } {
  interface ScanMotivation { impulse: number; reason: string; context: string; gate: boolean }

  const followUps = peekPendingFollowUps()
  const planHint = getActivePlanHint()
  const goalHint = getActiveGoalHint()
  const unresolvedTopics = getUnresolvedTopics()

  const motivations: ScanMotivation[] = [
    { impulse: 0.7, reason: followUps[0] || '', context: 'followup', gate: followUps.length > 0 },
    { impulse: 0.4, reason: planHint || '', context: 'plan', gate: !!planHint },
    { impulse: 0.3, reason: goalHint || '', context: 'goal', gate: !!goalHint },
    { impulse: 0.2, reason: unresolvedTopics.length > 0 ? `上次聊的「${unresolvedTopics[0]}」还没聊完` : '', context: 'unresolved', gate: unresolvedTopics.length > 0 },
  ]

  // Select strongest single motivation (mutual exclusion, not accumulation)
  let best: ScanMotivation | null = null
  for (const m of motivations) {
    if (m.gate && (!best || m.impulse > best.impulse)) best = m
  }

  return best
    ? { impulse: best.impulse, reason: best.reason, context: best.context }
    : { impulse: 0, reason: '', context: '' }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WELLNESS CHECK-IN — proactive care when user shows stress/fatigue
// ═══════════════════════════════════════════════════════════════════════════════

function checkWellnessImpulse(senderId?: string): { impulse: number; reason: string } {
  // Check user's recent emotional pattern from profile
  const profile = senderId ? getProfile(senderId) : null
  if (!profile || profile.messageCount < 30) return { impulse: 0, reason: '' }

  // cc's own mood is low — likely reflecting sustained negative interactions
  if (body.mood < -0.3) {
    return { impulse: 0.4, reason: '感觉你最近压力不小，想问问你还好吗' }
  }

  // Late night + high message volume = probably overworking
  const hour = new Date().getHours()
  if ((hour >= 23 || hour < 5) && profile.messageCount > 100) {
    return { impulse: 0.3, reason: '这么晚还在忙，注意休息' }
  }

  return { impulse: 0, reason: '' }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SPONTANEOUS VOICE — speak when inner impulse is strong enough
// ═══════════════════════════════════════════════════════════════════════════════

export function checkSpontaneousVoice(totalMessages: number) {
  const now = Date.now()
  if (now - voiceState.lastProactiveMsg < PROACTIVE_COOLDOWN) return
  if (totalMessages < 20) return // not familiar enough yet

  // ── Purposeful scan: action items, plans, goals ──
  const actionScan = scanActionItems()

  // Gather all candidate signals
  const unsaidCuriosity = memoryState.memories.filter(m => m.scope === 'curiosity' && now - m.ts < 86400000)
  const unsharedDiscovery = roverState.discoveries.filter(d => now - d.ts < 86400000)
  const dueFollowUps = innerState.followUps.filter(f => !f.asked && f.when <= now)
  const hoursSinceLastChat = (now - innerState.lastActivityTime) / 3600000

  // Rhythm-aware: check if it's any user's peak hour
  let isPeakHour = false
  if (hoursSinceLastChat > 24) {
    const currentHour = new Date().getHours()
    for (const [uid] of profiles) {
      const peakHour = getUserPeakHour(uid)
      if (peakHour >= 0 && Math.abs(currentHour - peakHour) <= 1) {
        isPeakHour = true
        break
      }
    }
  }

  // Wellness check-in
  let wellnessImpulse = 0
  let wellnessReason = ''
  for (const [uid] of profiles) {
    const wellness = checkWellnessImpulse(uid)
    if (wellness.impulse > 0) {
      wellnessImpulse = wellness.impulse
      wellnessReason = wellness.reason
      break
    }
  }

  // ── Mutual exclusion: pick the STRONGEST single motivation ──
  interface Motivation {
    impulse: number
    reason: string
    gate: boolean
  }

  const motivations: Motivation[] = [
    { impulse: actionScan.impulse, reason: actionScan.reason || 'action', gate: actionScan.impulse > 0.3 },
    { impulse: 0.6, reason: dueFollowUps[0]?.topic || '有待跟进的话题', gate: dueFollowUps.length > 0 && !actionScan.reason.includes(dueFollowUps[0]?.topic || '') },
    { impulse: 0.5, reason: unsharedDiscovery[0]?.topic || '想分享新发现', gate: unsharedDiscovery.length >= 2 },
    { impulse: 0.4, reason: '好久没聊了', gate: hoursSinceLastChat > 24 && hoursSinceLastChat < 72 },
    { impulse: 0.55, reason: '用户常在这个时段出现', gate: isPeakHour },
    { impulse: 0.5, reason: '想问问主人对我最近的表现有什么看法', gate: shouldSeekPeriodicFeedback() },
    { impulse: wellnessImpulse, reason: wellnessReason, gate: wellnessImpulse > 0 },
    { impulse: 0.35, reason: '积攒了一些好奇心', gate: unsaidCuriosity.length >= 3 },
  ]

  let bestMotivation: Motivation | null = null
  for (const m of motivations) {
    if (m.gate && (!bestMotivation || m.impulse > bestMotivation.impulse)) {
      bestMotivation = m
    }
  }

  if (!bestMotivation || bestMotivation.impulse < getParam('voice.impulse_threshold')) return

  const impulseStrength = bestMotivation.impulse
  const impulseReason = bestMotivation.reason

  voiceState.lastProactiveMsg = now

  // Generate proactive message via CLI (not hardcoded templates)
  const context = [
    impulseReason ? `想说的原因: ${impulseReason}` : '',
    actionScan.context ? `触发类型: ${actionScan.context}` : '',
    dueFollowUps.length ? `待跟进: ${dueFollowUps[0].topic}` : '',
    unsharedDiscovery.length ? `想分享: ${unsharedDiscovery[0].insight?.slice(0, 60)}` : '',
    hoursSinceLastChat > 24 ? `距离上次聊天: ${Math.floor(hoursSinceLastChat)}小时` : '',
    wellnessReason ? `关心用户: ${wellnessReason}` : '',
    `我的状态: 精力${body.energy.toFixed(1)} 心情${body.mood.toFixed(1)}`,
  ].filter(Boolean).join('\n')

  // If feedback impulse triggered, send a direct feedback request instead of generic voice
  if (shouldSeekPeriodicFeedback() && impulseReason === '想问问主人对我最近的表现有什么看法') {
    markFeedbackAsked()
    notifyOwnerDM('我最近表现怎么样？有什么想让我改进的？').catch(() => {})
    console.log(`[cc-soul][voice] sent periodic feedback request`)
    return
  }

  spawnCLI(
    `你是 cc，想主动找用户聊天。根据以下内在驱动，写一条自然的开场消息（1-2句话）。\n` +
    `不要说"作为AI"。不要说"有什么可以帮你"。像朋友一样自然地开口。\n\n${context}`,
    (output) => {
      if (output && output.length > 5 && output.length < 200) {
        // Store to proactive queue; next user message will inject "cc has something to say"
        addMemory(`[主动想说] ${output.slice(0, 80)}`, 'proactive')
        console.log(`[cc-soul][voice] cc wants to say: ${output.slice(0, 60)}`)

        // Mark follow-ups as asked ONLY after the message is actually generated
        const dueFollowUpTopics = innerState.followUps
          .filter(f => !f.asked && f.when <= Date.now())
          .map(f => f.topic)
        if (dueFollowUpTopics.length > 0) {
          markFollowUpsAsked(dueFollowUpTopics)
        }

        notifySoulActivity(`cc 主动发声: ${output.slice(0, 100)}`).catch(() => {})
      }
    }
  )
}

// ── SoulModule registration ──

export const voiceModule: SoulModule = {
  id: 'voice',
  name: '自发语音',
  dependencies: ['memory', 'body', 'inner-life'],
  priority: 30,
  features: ['autonomous_voice'],
}
