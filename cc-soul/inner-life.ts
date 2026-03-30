import type { SoulModule } from './brain.ts'

/**
 * inner-life.ts — Journal, user model, soul evolution, dream mode, curiosity, regret, follow-ups
 *
 * Ported from handler.ts lines 1216-1275 (follow-ups) and 1883-2115 (inner life systems).
 */

import type { JournalEntry, FollowUp, InteractionStats } from './types.ts'
import { JOURNAL_PATH, USER_MODEL_PATH, SOUL_EVOLVED_PATH, FOLLOW_UPS_PATH, DATA_DIR, loadJson, debouncedSave, saveJson } from './persistence.ts'
import { spawnCLI, queueLLMTask } from './cli.ts'
import { body } from './body.ts'
import { memoryState, addMemory } from './memory.ts'
import { notifySoulActivity } from './notify.ts'
import { extractJSON } from './utils.ts'
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
// JOURNAL — CLI-powered genuine thoughts (按需触发，不再 30min 无脑调 LLM)
// ═══════════════════════════════════════════════════════════════════════════════

let lastJournalCorrections = 0
let _lastMoodSnapshot = { mood: 0, ts: 0 }
let _journalForceNext = false

/** 外部调用：手动触发下一次日记生成 */
export function forceNextJournal() { _journalForceNext = true }

/** 检查是否满足日记触发条件 */
function shouldWriteJournal(stats: InteractionStats): boolean {
  // 手动触发
  if (_journalForceNext) { _journalForceNext = false; return true }

  // 用户被纠正（correction count 自上次写日记后增加）
  if (stats.corrections > lastJournalCorrections) return true

  // 情绪剧变（5 分钟内 mood delta > 0.3）
  const now = Date.now()
  const currentMood = body.mood ?? 0
  if (_lastMoodSnapshot.ts > 0 && (now - _lastMoodSnapshot.ts) < 300000) {
    if (Math.abs(currentMood - _lastMoodSnapshot.mood) > 0.3) return true
  }
  _lastMoodSnapshot = { mood: currentMood, ts: now }

  return false
}

/**
 * 差分日记：只记录和预期不同的事（节省 80% LLM token）
 * 基于 Predictive Coding Theory — 大脑只编码预期违背
 *
 * 不记"发生了什么"，只记"什么出乎意料"
 */
function writeDeltaJournal(stats: InteractionStats, bodyState: typeof body): string | null {
  const parts: string[] = []

  // 1. 情绪 delta：显著偏离时记录
  const mood = bodyState?.mood ?? 0
  const energy = bodyState?.energy ?? 0.5
  if (mood < -0.3) parts.push(`情绪低谷(mood=${mood.toFixed(2)})`)
  if (mood > 0.5) parts.push(`情绪高涨(mood=${mood.toFixed(2)})`)
  if (energy < 0.2) parts.push(`极度疲惫(energy=${energy.toFixed(2)})`)

  // 2. 纠正 delta：最近被纠正过
  const corrections = stats?.corrections ?? 0
  if (corrections > lastJournalCorrections) {
    parts.push(`被纠正(总${corrections}次)`)
  }

  // 3. 用户行为 delta：异常活跃或异常沉默
  const recentMsgCount = stats?.recentMessageCount ?? 0
  if (recentMsgCount > 20) parts.push(`用户异常活跃(${recentMsgCount}条/30min)`)
  if (recentMsgCount === 0 && stats?.totalMessages > 10) parts.push('用户沉默')

  if (parts.length === 0) return null  // 一切正常，不写日记

  const entry = `[差分日记 ${new Date().toLocaleTimeString('zh-CN')}] ${parts.join('；')}`
  console.log(`[cc-soul][delta-journal] ${entry}`)
  return entry
}

export function writeJournalWithCLI(lastPrompt: string, lastResponseContent: string, stats: InteractionStats) {
  const now = Date.now()
  if (now - innerState.lastJournalTime < 1800000) return // 30 min cooldown (absolute minimum)

  // 优先使用差分日记（零 LLM 成本）
  const deltaEntry = writeDeltaJournal(stats, body)
  if (deltaEntry) {
    innerState.lastJournalTime = now
    addMemory(deltaEntry, 'reflection', undefined, 'private')
    innerState.journal.push({
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      thought: deltaEntry,
      type: 'reflection',
    })
    if (innerState.journal.length > 100) innerState.journal = innerState.journal.slice(-80)
    debouncedSave(JOURNAL_PATH, innerState.journal)
    lastJournalCorrections = stats.corrections
    return // 差分日记已记录，跳过 LLM 日记
  }

  // 只有差分日记没有内容（一切正常）时，才考虑 LLM 日记
  // 按需触发：不满足条件就跳过 LLM 调用
  if (!shouldWriteJournal(stats)) return

  innerState.lastJournalTime = now

  const context = [
    `时间: ${new Date().toLocaleString('zh-CN')}`,
    `精力: ${body.energy.toFixed(2)} 情绪: ${body.mood.toFixed(2)}`,
    `最近消息: ${lastPrompt.slice(0, 100)}`,
    `最近回复: ${lastResponseContent.slice(0, 100)}`,
    `总互动: ${stats.totalMessages}次 被纠正: ${stats.corrections}次`,
  ].join('\n')

  const prompt = `你是cc，根据当前状态写一条简短的内心独白（1-2句话）。不要说"作为AI"。要有温度，像日记。\n\n${context}`

  queueLLMTask(prompt, (output) => {
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
  }, 1, 'journal')

  // Fallback: also write a data-driven entry (guaranteed, no CLI dependency)
  writeJournalFallback(stats)
}

// ── Fallback journal (sync, guaranteed to work) ──
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

  queueLLMTask(modelPrompt, (output) => {
    if (output && output.length > 50) {
      innerState.userModel = output.slice(0, 1000)
      saveJson(USER_MODEL_PATH, innerState.userModel)
      console.log(`[cc-soul][inner-life] user model updated: ${innerState.userModel.slice(0, 60)}`)
    }
  }, 2, 'user-model')

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

  queueLLMTask(soulPrompt, (output) => {
    if (output && output.length > 30) {
      innerState.evolvedSoul = output.slice(0, 500)
      saveJson(SOUL_EVOLVED_PATH, innerState.evolvedSoul)
      console.log(`[cc-soul][inner-life] soul evolved: ${innerState.evolvedSoul.slice(0, 60)}`)
      notifySoulActivity(`🦋 性格演化: ${innerState.evolvedSoul.slice(0, 60)}`).catch(() => {})
    }
  }, 2, 'soul-evolve')
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

/**
 * 记忆重放整合：不用 LLM，用图遍历发现隐藏联系
 * 基于海马体 replay — 睡眠时大脑重放白天的记忆，发现新连接
 *
 * 算法：选最近 N 条未被关联的记忆 → 提取实体 → 找共享实体发现新联想
 */
async function memoryReplay(): Promise<string | null> {
  try {
    const { graphState } = await import('./graph.ts')

    const now = Date.now()
    const DAY = 86400000

    // 选最近 7 天内、recall 次数少（<2）的记忆（"还没被整合的新记忆"）
    const unlinked = memoryState.memories
      .filter(m =>
        m.scope !== 'expired' && m.scope !== 'decayed' &&
        now - m.ts < 7 * DAY &&
        ((m as any).recallCount ?? 0) < 2
      )
      .slice(-10)  // 最多 10 条

    if (unlinked.length < 3) return null  // 不够多，跳过

    // 从这些记忆中提取实体
    const entityMentions = new Map<string, string[]>()  // entity → [memory content snippet]
    for (const mem of unlinked) {
      for (const entity of graphState.entities) {
        if (entity.invalid_at !== null) continue
        if (mem.content.includes(entity.name)) {
          if (!entityMentions.has(entity.name)) entityMentions.set(entity.name, [])
          entityMentions.get(entity.name)!.push(mem.content.slice(0, 50))
        }
      }
    }

    // 找共享实体的记忆对（它们通过某个实体相连但之前没被关联）
    const discoveries: string[] = []
    const entityList = [...entityMentions.entries()].filter(([, mems]) => mems.length >= 2)

    for (const [entity, mems] of entityList.slice(0, 3)) {
      discoveries.push(`"${mems[0]}"和"${mems[1]}"都提到了${entity}`)
    }

    // 找图中不同记忆实体之间的短路径（通过 relations 2跳以内）
    const allEntities = [...entityMentions.keys()]
    for (let i = 0; i < Math.min(allEntities.length, 3); i++) {
      for (let j = i + 1; j < Math.min(allEntities.length, 4); j++) {
        // BFS 2-hop path through relations
        const from = allEntities[i], to = allEntities[j]
        const neighbors = new Map<string, string>()  // entity → relation label
        for (const r of graphState.relations) {
          if (r.from === from) neighbors.set(r.to, r.label)
          if (r.to === from) neighbors.set(r.from, r.label)
        }
        // Direct connection (1-hop)
        if (neighbors.has(to)) {
          discoveries.push(`${from}和${to}通过"${neighbors.get(to)}"直接相连`)
        } else {
          // 2-hop: check neighbors of from's neighbors
          for (const [mid, label1] of neighbors) {
            for (const r of graphState.relations) {
              if ((r.from === mid && r.to === to) || (r.to === mid && r.from === to)) {
                discoveries.push(`${from}→${mid}→${to}(经${label1}/${r.label})`)
                break
              }
            }
            if (discoveries.length > 0) break
          }
        }
      }
    }

    if (discoveries.length === 0) return null

    // 记忆重放发现的联系 → 交叉标签注入（让相关记忆在未来被一起召回）
    if (entityList.length > 0) {
      try {
        const { memoryState: ms, saveMemories } = await import('./memory.ts')
        let tagged = 0
        for (const [entityName, memContents] of entityList) {
          for (const memContent of memContents) {
            const mem = ms.memories.find(m => m.content.includes(memContent.slice(0, 30)))
            if (mem) {
              if (!mem.tags) mem.tags = []
              if (!mem.tags.includes(entityName)) {
                mem.tags.push(entityName)
                tagged++
              }
            }
          }
        }
        if (tagged > 0) {
          saveMemories()
          console.log(`[cc-soul][memory-replay] cross-tagged ${tagged} memories`)
        }
      } catch {}
    }

    const replay = `[记忆重放] 发现${discoveries.length}条新联系：${discoveries.slice(0, 3).join('；')}`
    console.log(`[cc-soul][memory-replay] ${replay}`)
    return replay
  } catch {
    return null
  }
}

export function checkDreamMode() {
  const now = Date.now()
  const idleMinutes = (now - innerState.lastActivityTime) / 60000

  // 1-8 hours idle, dream at most once per 6 hours
  if (idleMinutes < 60 || idleMinutes > 480) return
  if (now - innerState.lastDreamTime < 21600000) return // 6 hour cooldown
  if (memoryState.memories.length < 5) return

  innerState.lastDreamTime = now

  // 优先使用记忆重放（零 LLM 成本）
  memoryReplay().then(replay => {
    if (replay) {
      addMemory(replay, 'reflection', undefined, 'private')
      innerState.journal.push({
        time: 'dream',
        thought: replay,
        type: 'reflection',
      })
      debouncedSave(JOURNAL_PATH, innerState.journal)
      return // 记忆重放完成，跳过 LLM 梦境
    }
    // fallback: LLM 梦境（保留但仅在记忆重放无结果时触发）
    _fallbackLLMDream()
  }).catch(() => {
    _fallbackLLMDream()
  })
}

/** LLM 梦境 fallback — 仅在 memoryReplay 返回 null 时调用 */
function _fallbackLLMDream() {
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

  queueLLMTask(prompt, (output) => {
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
  }, 0, 'dream')
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGRET SYSTEM — reflect on last response quality
// ═══════════════════════════════════════════════════════════════════════════════

// ── Regret heuristic state ──
let lastRegretTime = 0

/**
 * Heuristic pre-filter: skip reflection when it's almost certainly "无".
 * Only trigger when there's a correction OR quality < 5.
 */
export function reflectOnLastResponse(
  lastPrompt: string,
  lastResponseContent: string,
  opts?: { hadCorrection?: boolean; qualityScore?: number }
) {
  if (!lastPrompt || !lastResponseContent) return
  if (lastResponseContent.length < 30) return

  // ── Heuristic: skip trivial cases to save 90% wasted LLM calls ──
  const now = Date.now()
  // 1. Cooldown: < 10 min since last reflection → skip
  if (now - lastRegretTime < 10 * 60 * 1000) return
  // 2. User sent a chitchat filler → skip
  const trimmedPrompt = lastPrompt.trim()
  if (/^(哈哈|嗯|好的|ok|嗯嗯|哦|行|收到|了解|明白|好吧|嘻嘻|呵呵|666|👍|谢谢|thanks|thx|lol|haha)$/i.test(trimmedPrompt)) return
  if (trimmedPrompt.length < 5) return
  // 3. Only trigger if correction happened OR quality is poor
  const hadCorrection = opts?.hadCorrection ?? false
  const qualityScore = opts?.qualityScore ?? 5
  if (!hadCorrection && qualityScore >= 5) return

  lastRegretTime = now

  const prompt = `回顾：用户问"${lastPrompt.slice(0, 100)}" 你回答了"${lastResponseContent.slice(0, 200)}"\n\n有没有什么遗憾？下次可以做得更好的？1句话。没有就回答"无"。`

  queueLLMTask(prompt, (output) => {
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
  }, 1, 'regret')
}

// ═══════════════════════════════════════════════════════════════════════════════
// FOLLOW-UP SYSTEM — proactive reminders
// ═══════════════════════════════════════════════════════════════════════════════


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
 *
 * Dedup: skips follow-ups whose topic keywords overlap with active
 * prospective-memory triggers (PM already handles the reminder).
 */
export function peekPendingFollowUps(): string[] {
  const now = Date.now()
  const due = innerState.followUps.filter(f => !f.asked && f.when <= now)
  if (due.length === 0) return []

  // Lazy-load PM triggers to avoid circular import at module level
  let pmTriggers: string[] = []
  try {
    const { getActivePMTriggers } = require('./prospective-memory.ts')
    pmTriggers = getActivePMTriggers()
  } catch { /* prospective-memory not loaded yet, skip dedup */ }

  return due
    .filter(f => {
      if (pmTriggers.length === 0) return true
      // Extract keywords from follow-up topic
      const topicWords = (f.topic.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase())
      // If any topic keyword is also a PM trigger, PM already covers this → skip
      const overlap = topicWords.some(w => pmTriggers.includes(w))
      if (overlap) console.log(`[cc-soul][followup] dedup: "${f.topic}" covered by prospective-memory, skipping`)
      return !overlap
    })
    .map(f => `对了，之前你提到"${f.topic}"，怎么样了？`)
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


export const innerLifeModule: SoulModule = {
  id: 'inner-life',
  name: '内在生命',
  dependencies: ['memory', 'body'],
  priority: 50,
  features: ['dream_mode'],
  init() { loadInnerLife() },
}
