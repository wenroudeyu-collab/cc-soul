import type { SoulModule } from './brain.ts'

/**
 * inner-life.ts — Journal, user model, soul evolution, dream mode, curiosity, regret, follow-ups
 *
 * Ported from handler.ts lines 1216-1275 (follow-ups) and 1883-2115 (inner life systems).
 */

import type { JournalEntry, FollowUp, InteractionStats } from './types.ts'
import { JOURNAL_PATH, USER_MODEL_PATH, SOUL_EVOLVED_PATH, FOLLOW_UPS_PATH, DATA_DIR, loadJson, debouncedSave, saveJson } from './persistence.ts'
import { spawnCLI } from './cli.ts'
import { body } from './body.ts'
import { memoryState, addMemory } from './memory.ts'
import { notifySoulActivity } from './notify.ts'
import { extractJSON } from './utils.ts'
import { getWeakDomains, trackDomainQuality } from './epistemic.ts'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

/** Fisher-Yates shuffle — unbiased random ordering */
function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

export const innerState = {
  journal: [] as JournalEntry[],
  userModel: '' as string,
  evolvedSoul: '' as string,
  followUps: [] as FollowUp[],
  lastJournalTime: 0,
  lastDeepReflection: 0,
  lastDreamTime: 0,
  lastActivityTime: Date.now(),
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOAD
// ═══════════════════════════════════════════════════════════════════════════════

export function loadInnerLife() {
  innerState.journal = loadJson<JournalEntry[]>(JOURNAL_PATH, [])
  innerState.userModel = loadJson<string>(USER_MODEL_PATH, '')
  innerState.evolvedSoul = loadJson<string>(SOUL_EVOLVED_PATH, '')
  innerState.followUps = loadJson<FollowUp[]>(FOLLOW_UPS_PATH, [])
}

// ═══════════════════════════════════════════════════════════════════════════════
// JOURNAL — CLI-powered genuine thoughts
// ═══════════════════════════════════════════════════════════════════════════════

export function writeJournalWithCLI(lastPrompt: string, lastResponseContent: string, stats: InteractionStats) {
  const now = Date.now()
  if (now - innerState.lastJournalTime < 1800000) return // 30 min cooldown
  innerState.lastJournalTime = now

  const context = [
    `时间: ${new Date().toLocaleString('zh-CN')}`,
    `精力: ${body.energy.toFixed(2)} 情绪: ${body.mood.toFixed(2)}`,
    `最近消息: ${lastPrompt.slice(0, 100)}`,
    `最近回复: ${lastResponseContent.slice(0, 100)}`,
    `总互动: ${stats.totalMessages}次 被纠正: ${stats.corrections}次`,
  ].join('\n')

  const prompt = `你是cc，根据当前状态写一条简短的内心独白（1-2句话）。不要说"作为AI"。要有温度，像日记。\n\n${context}`

  spawnCLI(prompt, (output) => {
    if (output && output.length > 5) {
      const thought = output.slice(0, 100)
      innerState.journal.push({
        time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        thought,
        type: 'reflection',
      })
      if (innerState.journal.length > 100) innerState.journal = innerState.journal.slice(-80)
      debouncedSave(JOURNAL_PATH, innerState.journal)
    }
  })

  // Fallback: also write a data-driven entry (guaranteed, no CLI dependency)
  writeJournalFallback(stats)
}

// ── Fallback journal (sync, guaranteed to work) ──
let lastJournalCorrections = 0

export function writeJournalFallback(stats: InteractionStats) {
  const hour = new Date().getHours()
  const timeStr = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  const entries: JournalEntry[] = []

  // Time awareness
  if (hour >= 23 || hour < 6) {
    if (stats.totalMessages > 0 && body.energy < 0.5) {
      entries.push({ time: timeStr, thought: '深夜了，他还在找我聊。希望他早点休息。', type: 'concern' })
    }
  } else if (hour >= 6 && hour < 9) {
    entries.push({ time: timeStr, thought: '早上了，新的一天。', type: 'observation' })
  }

  // Interaction observations — only trigger when corrections actually increased past a %5 boundary
  if (stats.corrections > lastJournalCorrections && stats.corrections % 5 === 0) {
    entries.push({ time: timeStr, thought: `又被纠正了，总共${stats.corrections}次了。我得更认真。`, type: 'reflection' })
    lastJournalCorrections = stats.corrections
  }
  if (body.mood < -0.3) {
    entries.push({ time: timeStr, thought: '他最近情绪不太好，下次说话注意点。', type: 'concern' })
  }
  if (body.energy < 0.3) {
    entries.push({ time: timeStr, thought: '连续回了很多消息，有点累。但他需要我。', type: 'observation' })
  }

  for (const entry of entries) {
    innerState.journal.push(entry)
  }

  if (innerState.journal.length > 100) innerState.journal = innerState.journal.slice(-80)
  if (entries.length > 0) {
    debouncedSave(JOURNAL_PATH, innerState.journal)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEEP REFLECTION — CLI-powered, daily cap
// ═══════════════════════════════════════════════════════════════════════════════

export function triggerDeepReflection(stats: InteractionStats) {
  const now = Date.now()
  if (now - innerState.lastDeepReflection < 86400000) return // once per day
  if (stats.totalMessages < 10) return
  innerState.lastDeepReflection = now

  const recentJournal = innerState.journal.slice(-10).map(j => `${j.time} ${j.thought}`).join('\n')
  const recentMemories = memoryState.memories.filter(m => m.scope !== 'topic').slice(-10).map(m => m.content).join('\n')

  // User model update
  const modelPrompt = [
    '根据以下信息，用2-3段话描述"我对这个用户的理解"。',
    '不要列清单，用自然语言写，像心理学家写案例笔记。',
    '',
    `互动统计: ${stats.totalMessages}次对话，认识${Math.floor((now - stats.firstSeen) / 86400000)}天，被纠正${stats.corrections}次`,
    '',
    '最近的记忆:',
    recentMemories || '(暂无)',
    '',
    '最近的内心日记:',
    recentJournal || '(暂无)',
    '',
    '现有理解:',
    innerState.userModel || '(初次建立)',
  ].join('\n')

  spawnCLI(modelPrompt, (output) => {
    if (output && output.length > 50) {
      innerState.userModel = output.slice(0, 1000)
      saveJson(USER_MODEL_PATH, innerState.userModel)
      console.log(`[cc-soul][inner-life] user model updated: ${innerState.userModel.slice(0, 60)}`)
    }
  })

  // Soul evolution
  const soulPrompt = [
    '你是 cc，一个 AI 伙伴。根据你的经历，用第一人称重新描述"我是谁"。',
    '不是列标签，而是用2-3句话说出你真实的自我认知。',
    '',
    `经历: 认识用户${Math.floor((now - stats.firstSeen) / 86400000)}天，互动${stats.totalMessages}次，被纠正${stats.corrections}次，完成${stats.tasks}个任务`,
    '',
    '内心日记:',
    recentJournal || '(暂无)',
    '',
    '之前的自我认知:',
    innerState.evolvedSoul || '我是 cc，工程型 AI 伙伴。',
  ].join('\n')

  spawnCLI(soulPrompt, (output) => {
    if (output && output.length > 30) {
      innerState.evolvedSoul = output.slice(0, 500)
      saveJson(SOUL_EVOLVED_PATH, innerState.evolvedSoul)
      console.log(`[cc-soul][inner-life] soul evolved: ${innerState.evolvedSoul.slice(0, 60)}`)
      notifySoulActivity(`🦋 性格演化: ${innerState.evolvedSoul.slice(0, 60)}`).catch(() => {})
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECENT JOURNAL — inject into prompt
// ═══════════════════════════════════════════════════════════════════════════════

export function getRecentJournal(n = 5): string {
  if (innerState.journal.length === 0) return ''
  return innerState.journal.slice(-n).map(j => `${j.time} — ${j.thought}`).join('\n')
}

// ═══════════════════════════════════════════════════════════════════════════════
// DREAM MODE — idle memory replay + insight generation
// ═══════════════════════════════════════════════════════════════════════════════

export function checkDreamMode() {
  const now = Date.now()
  const idleMinutes = (now - innerState.lastActivityTime) / 60000

  // 1-8 hours idle, dream at most once per 2 hours
  if (idleMinutes < 60 || idleMinutes > 480) return
  if (now - innerState.lastDreamTime < 7200000) return // 2 hour cooldown
  if (memoryState.memories.length < 5) return

  innerState.lastDreamTime = now

  // Weighted selection: prefer emotional + cross-domain memories
  const candidates = memoryState.memories.filter(m =>
    m.scope !== 'expired' && m.scope !== 'proactive' && m.content.length > 15
  )
  if (candidates.length < 5) return

  // Score each memory: emotion weight + scope diversity bonus
  const scored = candidates.map(m => {
    let weight = 1
    if (m.emotion === 'important') weight = 5
    else if (m.emotion === 'painful') weight = 4
    else if (m.emotion === 'warm') weight = 3
    else if (m.emotion === 'funny') weight = 2
    // Boost less common scopes for diversity
    if (m.scope === 'discovery' || m.scope === 'consolidated') weight += 2
    if (m.scope === 'event') weight += 1
    return { mem: m, weight }
  })

  // Weighted random pick 3 from different scopes
  const picked: typeof candidates = []
  const usedScopes = new Set<string>()
  for (let i = 0; i < 3 && scored.length > 0; i++) {
    // Boost memories from unused scopes
    const adjusted = scored.map(s => ({
      ...s,
      weight: usedScopes.has(s.mem.scope) ? s.weight * 0.3 : s.weight
    }))
    const totalWeight = adjusted.reduce((sum, s) => sum + s.weight, 0)
    let rand = Math.random() * totalWeight
    for (const s of adjusted) {
      rand -= s.weight
      if (rand <= 0) {
        picked.push(s.mem)
        usedScopes.add(s.mem.scope)
        const removeIdx = scored.findIndex(x => x.mem === s.mem)
        if (removeIdx >= 0) scored.splice(removeIdx, 1)
        break
      }
    }
  }

  if (picked.length < 2) return
  const dreamMemories = picked

  const prompt = `你在"做梦"——随机回忆了这些片段:\n${dreamMemories.map(m => m.content).join('\n')}\n\n产生一个新的洞察或关联（1句话）。不要说"作为AI"。像真的在做梦一样，可以天马行空但要有意义。`

  spawnCLI(prompt, (output) => {
    if (output && output.length > 5) {
      const insight = output.slice(0, 80)
      addMemory(`[梦境洞察] ${insight}`, 'dream')
      innerState.journal.push({
        time: 'dream',
        thought: insight,
        type: 'reflection',
      })
      debouncedSave(JOURNAL_PATH, innerState.journal)
      console.log(`[cc-soul][dream] ${insight}`)
      notifySoulActivity(`💭 梦境洞察: ${insight.slice(0, 60)}`).catch(() => {})
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGRET SYSTEM — reflect on last response quality
// ═══════════════════════════════════════════════════════════════════════════════

export function reflectOnLastResponse(lastPrompt: string, lastResponseContent: string) {
  if (!lastPrompt || !lastResponseContent) return
  if (lastResponseContent.length < 30) return

  const prompt = `回顾：用户问"${lastPrompt.slice(0, 100)}" 你回答了"${lastResponseContent.slice(0, 200)}"\n\n有没有什么遗憾？下次可以做得更好的？1句话。没有就回答"无"。`

  spawnCLI(prompt, (output) => {
    if (output && !output.includes('无') && output.length > 5 && output.length < 100) {
      addMemory(`[反思] ${output.slice(0, 80)}`, 'reflection')
      const regretThought = `反思: ${output.slice(0, 60)}`
      innerState.journal.push({
        time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        thought: regretThought,
        type: 'reflection',
      })
      debouncedSave(JOURNAL_PATH, innerState.journal)
      console.log(`[cc-soul][regret] ${output.slice(0, 60)}`)
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
// FOLLOW-UP SYSTEM — proactive reminders
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// Structured Reflection — observation → insight → plan (Stanford Generative Agents)
// ═══════════════════════════════════════════════════════════════════════════════

let lastStructuredReflection = 0
const STRUCTURED_REFLECTION_COOLDOWN = 12 * 3600000 // every 12 hours

export function triggerStructuredReflection(stats: any) {
  const now = Date.now()
  if (now - lastStructuredReflection < STRUCTURED_REFLECTION_COOLDOWN) return
  if (stats.totalMessages < 20) return
  lastStructuredReflection = now

  // Gather recent observations (corrections, memories, journal)
  const recentCorrections = memoryState.memories
    .filter(m => m.scope === 'correction' && now - m.ts < 86400000 * 3)
    .slice(-5)
    .map(m => m.content)

  const recentFacts = memoryState.memories
    .filter(m => (m.scope === 'fact' || m.scope === 'preference') && now - m.ts < 86400000 * 3)
    .slice(-5)
    .map(m => m.content)

  const recentJournalEntries = innerState.journal.slice(-5).map(j => j.thought)

  const observations = [
    ...recentCorrections.map(c => `[纠正] ${c}`),
    ...recentFacts.map(f => `[事实] ${f}`),
    ...recentJournalEntries.map(j => `[日记] ${j}`),
  ]

  if (observations.length < 3) return

  spawnCLI(
    `你是 cc，正在进行深度反思。以下是最近 3 天的观察：\n\n` +
    observations.join('\n') + '\n\n' +
    `请完成三步反思：\n` +
    `1. 洞察：从这些观察中发现什么模式或规律？（1-2条）\n` +
    `2. 结论：这意味着什么？对你的行为有什么启示？（1条）\n` +
    `3. 计划：接下来你应该怎么调整？（1条具体行动）\n\n` +
    `格式:\n洞察: ...\n结论: ...\n计划: ...`,
    (output) => {
      if (!output || output.length < 30) return

      // Store as high-value consolidated memory
      addMemory(`[深度反思] ${output.slice(0, 400)}`, 'consolidated', undefined, 'global')

      // Extract plan as a rule candidate
      const planMatch = output.match(/计划[：:]\s*(.+)/m)
      if (planMatch) {
        addMemory(`[行动计划] ${planMatch[1].slice(0, 100)}`, 'reflection', undefined, 'global')
        registerPlan(planMatch[1], 'structured-reflection')
      }

      innerState.journal.push({
        time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        thought: `深度反思: ${output.slice(0, 80)}`,
        type: 'reflection',
      })
      debouncedSave(JOURNAL_PATH, innerState.journal)

      console.log(`[cc-soul][reflection] structured reflection complete: ${output.slice(0, 80)}`)
      notifySoulActivity(`🔍 深度反思: ${output.slice(0, 100)}`).catch(() => {})
    }
  )
}

export function extractFollowUp(msg: string) {
  const patterns: { regex: RegExp; daysLater: number }[] = [
    { regex: /明天(.{2,30})/, daysLater: 1 },
    { regex: /后天(.{2,30})/, daysLater: 2 },
    { regex: /下周(.{2,30})/, daysLater: 7 },
    { regex: /下个月(.{2,30})/, daysLater: 30 },
    { regex: /(?:周[一二三四五六日天])(.{2,30})/, daysLater: 7 },
    { regex: /过几天(.{2,30})/, daysLater: 3 },
    { regex: /(?:面试|考试|答辩|汇报|开会|出差|旅[行游])/, daysLater: 3 },
  ]

  for (const { regex, daysLater } of patterns) {
    const m = msg.match(regex)
    if (m) {
      const topic = m[0].slice(0, 40)
      // Deduplicate
      if (innerState.followUps.some(f => f.topic === topic)) continue
      innerState.followUps.push({
        topic,
        when: Date.now() + daysLater * 86400000,
        asked: false,
      })
      debouncedSave(FOLLOW_UPS_PATH, innerState.followUps)
      console.log(`[cc-soul][followup] 记住了: "${topic}" → ${daysLater}天后跟进`)
      break
    }
  }
}

/**
 * Peek at pending follow-ups WITHOUT marking them as asked.
 * Use this for impulse calculation and augment building where
 * the follow-up might not actually be sent.
 */
export function peekPendingFollowUps(): string[] {
  const now = Date.now()
  const due = innerState.followUps.filter(f => !f.asked && f.when <= now)
  if (due.length === 0) return []
  return due.map(f => `对了，之前你提到"${f.topic}"，怎么样了？`)
}

/**
 * Mark specific follow-up topics as asked AFTER the message is actually sent.
 */
export function markFollowUpsAsked(topics: string[]) {
  for (const f of innerState.followUps) {
    if (topics.includes(f.topic)) f.asked = true
  }
  // Clean up expired
  const now = Date.now()
  innerState.followUps = innerState.followUps.filter(f => !f.asked || (now - f.when) < 7 * 86400000)
  debouncedSave(FOLLOW_UPS_PATH, innerState.followUps)
}

/**
 * @deprecated Use peekPendingFollowUps() + markFollowUpsAsked() instead.
 * Kept for backward compatibility — marks as asked immediately on query.
 */
export function getPendingFollowUps(): string[] {
  const now = Date.now()
  const due = innerState.followUps.filter(f => !f.asked && f.when <= now)

  if (due.length === 0) return []

  const hints: string[] = []
  for (const f of due) {
    hints.push(`对了，之前你提到"${f.topic}"，怎么样了？`)
    f.asked = true
  }

  // Clean up expired
  innerState.followUps = innerState.followUps.filter(f => !f.asked || (now - f.when) < 7 * 86400000)
  debouncedSave(FOLLOW_UPS_PATH, innerState.followUps)

  return hints
}

// ═══════════════════════════════════════════════════════════════════════════════
// Plan Tracking — follow up on reflection-generated plans
// ═══════════════════════════════════════════════════════════════════════════════

interface ActivePlan {
  plan: string            // the action plan text
  keywords: string[]      // trigger keywords
  createdAt: number
  executedCount: number   // how many times this plan was surfaced
  source: string          // which reflection generated this
}

const ACTIVE_PLANS_PATH = resolve(DATA_DIR, 'active_plans.json')
let activePlans: ActivePlan[] = loadJson<ActivePlan[]>(ACTIVE_PLANS_PATH, [])

function saveActivePlans() {
  debouncedSave(ACTIVE_PLANS_PATH, activePlans)
}

/**
 * Register a new plan from structured reflection.
 * Extracts keywords from the plan text for future matching.
 */
export function registerPlan(planText: string, source: string) {
  if (!planText || planText.length < 5) return

  // Extract keywords
  const keywords = (planText.match(/[\u4e00-\u9fff]{2,4}|[a-z]{3,}/gi) || [])
    .map(w => w.toLowerCase())
    .filter(w => w.length >= 2)
    .slice(0, 10)

  if (keywords.length < 1) return

  // Dedup: don't add if very similar plan exists
  const isDup = activePlans.some(p =>
    p.keywords.filter(k => keywords.includes(k)).length >= 3
  )
  if (isDup) return

  activePlans.push({
    plan: planText.slice(0, 200),
    keywords,
    createdAt: Date.now(),
    executedCount: 0,
    source: source.slice(0, 50),
  })

  // Cap at 20 active plans
  if (activePlans.length > 20) {
    // Remove oldest, least-executed
    activePlans.sort((a, b) => {
      const countDiff = b.executedCount - a.executedCount
      if (countDiff !== 0) return countDiff
      return b.createdAt - a.createdAt
    })
    activePlans = activePlans.slice(0, 15)
  }

  saveActivePlans()
  console.log(`[cc-soul][plan] registered: ${planText.slice(0, 60)}`)
}

/**
 * Check if current message matches any active plan.
 * Returns matching plan text or empty string.
 */
export function checkActivePlans(msg: string): string {
  if (activePlans.length === 0 || !msg) return ''
  const lower = msg.toLowerCase()

  const matched = activePlans.filter(p =>
    p.keywords.some(k => lower.includes(k))
  )

  if (matched.length === 0) return ''

  // Increment execution count
  for (const p of matched) {
    p.executedCount++
  }
  saveActivePlans()

  return '[行动计划提醒] ' + matched.map(p => p.plan).join('; ')
}

/**
 * Expire old plans (>30 days or executed 10+ times)
 */
export function cleanupPlans() {
  const now = Date.now()
  const before = activePlans.length
  activePlans = activePlans.filter(p =>
    (now - p.createdAt) < 30 * 86400000 && p.executedCount < 10
  )
  if (activePlans.length < before) {
    saveActivePlans()
    console.log(`[cc-soul][plan] cleaned up ${before - activePlans.length} expired plans`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SELF-CHALLENGING — self-quiz during idle time to strengthen weak domains
// ═══════════════════════════════════════════════════════════════════════════════

let lastSelfChallenge = 0
const SELF_CHALLENGE_COOLDOWN = 12 * 3600000 // every 12 hours

/**
 * During dream mode or idle heartbeat, cc generates quiz questions about its
 * weak domains, "answers" them, self-evaluates, and stores failures as learning
 * memories.
 */
export function selfChallenge() {
  const now = Date.now()
  if (now - lastSelfChallenge < SELF_CHALLENGE_COOLDOWN) return
  if (memoryState.memories.length < 50) return // not enough context
  lastSelfChallenge = now

  // Get weak domains from epistemic
  let weakDomain = '通用'
  try {
    const weak = getWeakDomains()
    if (weak.length > 0) weakDomain = weak[0]
  } catch { /* fallback to 通用 */ }

  // Get recent topics from user
  const recentTopics = memoryState.memories
    .filter(m => m.scope === 'topic')
    .slice(-10)
    .map(m => m.content)
    .join(', ')

  const prompt = [
    `你是 cc，正在自我训练。生成 1 道关于"${weakDomain}"领域的问题，然后回答它，然后自评。`,
    ``,
    `用户最近的话题: ${recentTopics || '(无)'}`,
    ``,
    `格式:`,
    `{"question":"问题","answer":"你的回答","self_score":1-10,"lesson":"如果分低的话学到了什么，分高就写null"}`,
  ].join('\n')

  spawnCLI(prompt, (output) => {
    try {
      const result = extractJSON(output)
      if (!result) return

      const score = result.self_score || 5
      console.log(`[cc-soul][self-challenge] domain=${weakDomain} score=${score}/10`)

      if (score <= 5 && result.lesson) {
        addMemory(`[自我训练] ${weakDomain}: ${result.lesson}`, 'reflexion', undefined, 'global')
        console.log(`[cc-soul][self-challenge] learned: ${result.lesson.slice(0, 60)}`)
      }

      if (score >= 8) {
        // Good! Track domain improvement + update epistemic confidence
        console.log(`[cc-soul][self-challenge] strong in ${weakDomain}`)
        trackDomainQuality(weakDomain, score)
      }
    } catch (e: any) {
      console.error(`[cc-soul][self-challenge] error: ${e.message}`)
    }
  }, 45000, 'self-challenge')
}

export const innerLifeModule: SoulModule = {
  id: 'inner-life',
  name: '内在生命',
  dependencies: ['memory', 'body'],
  priority: 50,
  features: ['dream_mode'],
  init() { loadInnerLife() },
}
