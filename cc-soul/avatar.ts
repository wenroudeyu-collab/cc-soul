/**
 * avatar.ts — AI Avatar (Digital Twin) Engine
 *
 * Not style mimicry — soul injection. The goal is not to imitate how the user
 * talks, but to BE the user: think with their values, decide with their patterns,
 * feel with their emotional state, relate with their social history.
 *
 * Three capabilities:
 *   1. Data Collection: auto-extract expression, decisions, social graph, emotions
 *   2. Soul Injection: generate replies AS the user (not imitating — being)
 *   3. Proxy Reply: act on behalf with boundary checks
 *
 * Data sources for soul injection (all already collected by other modules):
 *   - person-model: identity, values, beliefs, contradictions, communication decoder
 *   - avatar profile: expression style, catchphrases, decisions, social graph, emotions
 *   - memory.ts: full memory recall by sender name
 *   - body.ts: current mood, energy, emotional state
 *   - graph.ts: social context, entity relationships
 */

import { existsSync, readFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { DATA_DIR, debouncedSave } from './persistence.ts'
import { spawnCLI } from './cli.ts'
import { body } from './body.ts'
import type { Memory } from './types.ts'

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface SocialContact {
  relation: string
  context: string
  samples: string[]   // messages mentioning this person (max 15) — LLM infers tone from these
}

interface AvatarProfile {
  id: string
  name: string
  identity: { who: string; [key: string]: any }
  expression: {
    style: string
    口头禅: string[]
    习惯: string
    avg_msg_length: number
    samples: string[]       // recent user messages (rolling window of 30)
    tone_variants: Record<string, string>  // deprecated, kept for compat
  }
  decisions: {
    pattern: string
    traces: { scenario: string; chose: string; reason: string; rejected?: string }[]
  }
  social: Record<string, SocialContact>
  emotional_patterns: {
    baseline: string
    triggers: Record<string, string[]>
    reaction_style: Record<string, string>
  }
  preferences: Record<string, string>
  boundaries: {
    can_reply: string[]
    ask_first: string[]
    never: string[]
  }
  updated_at: number
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

const PROFILES_DIR = resolve(DATA_DIR, 'avatar_profiles')
const profiles = new Map<string, AvatarProfile>()

function ensureDir() {
  if (!existsSync(PROFILES_DIR)) mkdirSync(PROFILES_DIR, { recursive: true })
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOAD / SAVE
// ═══════════════════════════════════════════════════════════════════════════════

export function loadAvatarProfile(userId: string): AvatarProfile {
  if (profiles.has(userId)) return profiles.get(userId)!

  ensureDir()
  const filePath = resolve(PROFILES_DIR, `${userId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)

  if (existsSync(filePath)) {
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'))
      profiles.set(userId, data)
      return data
    } catch {}
  }

  // Create empty profile
  const empty: AvatarProfile = {
    id: userId,
    name: '',
    identity: { who: '' },
    expression: {
      style: '',
      口头禅: [],
      习惯: '',
      avg_msg_length: 0,
      samples: [],
      tone_variants: {},
    },
    decisions: { pattern: '', traces: [] },
    social: {} as Record<string, SocialContact>,
    emotional_patterns: {
      baseline: '',
      triggers: {},
      reaction_style: {},
    },
    preferences: {},
    boundaries: {
      can_reply: ['日常闲聊', '约饭', '简单技术问题'],
      ask_first: ['工作决策', '代表用户表态'],
      never: ['敏感话题', '涉及金钱'],
    },
    updated_at: Date.now(),
  }
  profiles.set(userId, empty)
  return empty
}

function saveProfile(userId: string) {
  ensureDir()
  const profile = profiles.get(userId)
  if (!profile) return
  profile.updated_at = Date.now()
  const filePath = resolve(PROFILES_DIR, `${userId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
  debouncedSave(filePath, profile, 5000)
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA COLLECTION — called after every message (async, non-blocking)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Auto-extract avatar data from user message. Called from handleSent.
 * Runs silently in background — user never notices.
 */
export function collectAvatarData(userMsg: string, botReply: string, userId: string) {
  if (!userMsg || userMsg.length < 3 || !userId) return
  if (userMsg.startsWith('/')) return // skip commands

  const profile = loadAvatarProfile(userId)

  // ── 1. Expression samples (rolling window of 30) ──
  if (userMsg.length >= 5 && userMsg.length <= 200) {
    profile.expression.samples.push(userMsg)
    if (profile.expression.samples.length > 30) {
      profile.expression.samples = profile.expression.samples.slice(-30)
    }

    // Update avg message length
    const lens = profile.expression.samples.map(s => s.length)
    profile.expression.avg_msg_length = Math.round(lens.reduce((a, b) => a + b, 0) / lens.length)
  }

  // ── 2. 口头禅 detection (frequent short phrases) ──
  const shortPhrases = userMsg.match(/[\u4e00-\u9fff]{1,4}(?=[，。！？\s]|$)/g) || []
  for (const phrase of shortPhrases) {
    if (phrase.length >= 2 && phrase.length <= 4) {
      if (!profile.expression.口头禅.includes(phrase)) {
        // Check if this phrase appears in multiple samples
        const count = profile.expression.samples.filter(s => s.includes(phrase)).length
        if (count >= 3) {
          profile.expression.口头禅.push(phrase)
          if (profile.expression.口头禅.length > 10) profile.expression.口头禅.shift()
          console.log(`[cc-soul][avatar] new 口头禅 detected: "${phrase}"`)
        }
      }
    }
  }

  // ── 3. Decision trace extraction ──
  const decisionPatterns = /我选|我决定|我觉得.*比.*好|还是.*吧|选了|不选|不用.*用/
  if (decisionPatterns.test(userMsg) && profile.decisions.traces.length < 20) {
    spawnCLI(
      `从这句话中提取决策信息。如果有决策，输出 JSON: {"scenario":"场景","chose":"选了什么","reason":"为什么","rejected":"排除了什么"}。没有决策就回答 "null"。\n\n"${userMsg.slice(0, 200)}"`,
      (output) => {
        if (!output || output.includes('null')) return
        try {
          const trace = JSON.parse(output.match(/\{[\s\S]*\}/)?.[0] || 'null')
          if (trace && trace.scenario) {
            profile.decisions.traces.push(trace)
            if (profile.decisions.traces.length > 20) profile.decisions.traces.shift()
            saveProfile(userId)
            console.log(`[cc-soul][avatar] decision traced: ${trace.scenario} → ${trace.chose}`)
          }
        } catch {}
      }, 15000
    )
  }

  // ── 4. Social relation extraction (rule-based fast path + LLM fallback) ──

  // Fast path: regex for common patterns
  const personMentionPatterns = /我(同事|朋友|老板|老婆|老公|女朋友|男朋友|室友|学长|学姐|导师|师兄|师姐|发小|儿子|女儿|妈|爸|父亲|母亲)(.{1,4})|(.{1,4})是我(同事|朋友|老板|老婆|老公|发小|儿子|女儿)/
  const personMatch = userMsg.match(personMentionPatterns)
  if (personMatch) {
    const relation = personMatch[1] || personMatch[4] || ''
    const name = (personMatch[2] || personMatch[3] || '').trim()
    if (name && name.length >= 1 && name.length <= 4 && !profile.social[name]) {
      profile.social[name] = {
        relation,
        context: userMsg.slice(0, 60),
        samples: [userMsg.slice(0, 100)],
      }
      saveProfile(userId)
      console.log(`[cc-soul][avatar] social relation (rule): ${name} (${relation})`)
    }
  }

  // LLM fallback: detect names + relationships that regex can't catch
  // Triggered when message mentions a person name pattern but no regex match
  const namePattern = /[\u4e00-\u9fff]{2,3}(?:说|问|回|发|给|叫|让|找|约|跟|和|对)/
  if (!personMatch && namePattern.test(userMsg) && Object.keys(profile.social).length < 20) {
    // Check if the mentioned name is already known
    const knownNames = Object.keys(profile.social)
    const possibleName = userMsg.match(/(?:跟|和|对|给|找|约)([\u4e00-\u9fff]{2,4})/)
    if (possibleName && possibleName[1] && !knownNames.includes(possibleName[1])) {
      spawnCLI(
        `从这句话中提取人物关系。如果提到了某个人，输出 JSON: {"name":"名字","relation":"关系(如朋友/同事/老板/家人/妻子/丈夫/孩子等)","context":"简要背景"}。没有就回答 "null"。\n\n"${userMsg.slice(0, 200)}"`,
        (output) => {
          if (!output || output.includes('null')) return
          try {
            const parsed = JSON.parse(output.match(/\{[\s\S]*\}/)?.[0] || 'null')
            if (parsed && parsed.name && parsed.relation && !profile.social[parsed.name]) {
              profile.social[parsed.name] = {
                relation: parsed.relation,
                context: (parsed.context || userMsg.slice(0, 60)).slice(0, 60),
                samples: [userMsg.slice(0, 100)],
              }
              saveProfile(userId)
              console.log(`[cc-soul][avatar] social relation (LLM): ${parsed.name} (${parsed.relation})`)
            }
          } catch {}
        }, 15000
      )
    }
  }

  // ── 4b. Per-relationship sample collection ──
  // For every known contact, if the message mentions their name, store it
  for (const [name, contact] of Object.entries(profile.social)) {
    const sc = contact as SocialContact
    if (userMsg.includes(name)) {
      if (!sc.samples) sc.samples = []
      const sample = userMsg.slice(0, 100)
      if (!sc.samples.includes(sample)) {
        sc.samples.push(sample)
        if (sc.samples.length > 15) sc.samples.shift()
      }
    }
  }

  // ── 5. Emotional pattern tracking ──
  const emotionSignals: Record<string, RegExp> = {
    '开心': /哈哈|太好了|牛|厉害|爽|开心|高兴/,
    '烦躁': /烦|累|不想|算了|懒得|麻烦/,
    '低落': /难过|崩溃|被骂|心情差|不开心|压力/,
    '暴怒': /傻逼|垃圾|怒|气死|离谱/,
  }
  for (const [emotion, regex] of Object.entries(emotionSignals)) {
    if (regex.test(userMsg)) {
      if (!profile.emotional_patterns.triggers[emotion]) {
        profile.emotional_patterns.triggers[emotion] = []
      }
      const trigger = userMsg.slice(0, 40)
      if (!profile.emotional_patterns.triggers[emotion].includes(trigger)) {
        profile.emotional_patterns.triggers[emotion].push(trigger)
        // Keep last 5 per emotion
        if (profile.emotional_patterns.triggers[emotion].length > 5) {
          profile.emotional_patterns.triggers[emotion].shift()
        }
      }
    }
  }

  // ── 6. Periodic LLM-driven expression analysis (every 10 samples) ──
  if (profile.expression.samples.length > 0 && profile.expression.samples.length % 10 === 0) {
    const sampleList = profile.expression.samples.slice(-15).map((s, i) => `${i + 1}. ${s}`).join('\n')
    spawnCLI(
      `深入分析这个用户的说话风格和性格特征。从以下消息中提取：
1. 说话风格（语气、用词习惯、标点特征、消息长度偏好）
2. 性格线索（内向/外向、直接/婉转、乐观/悲观、理性/感性）
3. 情绪表达方式（高兴/愤怒/低落时分别怎么表达）

用2-3句话综合概括，不要列清单：
${sampleList}`,
      (output) => {
        if (output && output.length > 10) {
          profile.expression.style = output.slice(0, 300)
          profile.expression.习惯 = output.slice(0, 300)
          saveProfile(userId)
          console.log(`[cc-soul][avatar] expression style updated: ${output.slice(0, 60)}`)
        }
      }, 15000
    )
  }

  // ── 7. Deep soul extraction — LLM-driven, no hardcoded patterns ──
  // Every 10 messages, let LLM analyze the batch for deep patterns.
  // The LLM decides what's important — wisdom, regret, love, fear, anything.
  // No predefined categories. Every person is different.
  if (profile.expression.samples.length > 0 && profile.expression.samples.length % 10 === 5) {
    // Offset by 5 from style analysis (which runs at %10===0) to spread load
    const recentBatch = profile.expression.samples.slice(-10).map((s, i) => `${i + 1}. ${s}`).join('\n')
    spawnCLI(
      `你是一个人格分析师。分析以下消息，提取这个人内心深处的东西——不是表面的聊天内容，而是能反映他灵魂的东西。

可能包括但不限于：
- 人生信条或价值观（他反复强调的道理）
- 后悔或遗憾（他希望重来的事）
- 没说出口的话（对某人的隐藏情感）
- 对某人的深层感受（爱、愧疚、骄傲、担心）
- 他传递给别人的教诲
- 他的恐惧或焦虑
- 他的矛盾面（说一套做一套）
- 他的幽默方式（冷笑话、自嘲、损人、讽刺、谐音梗、比喻梗）
- 他回避的话题（一提到就转移话题或沉默的事）
- 他的情绪表达习惯（生气时安静还是爆发、伤心时自嘲还是沉默）

如果这批消息中有任何深层内容，输出 JSON 数组：
[{"type":"自定义类型","content":"提取的内容","about":"涉及的人(没有就空)"}]

如果这批消息只是日常闲聊没有深层内容，回答 "null"。

消息：
${recentBatch}`,
      (output) => {
        if (!output || output.includes('null')) return
        try {
          const items = JSON.parse(output.match(/\[[\s\S]*\]/)?.[0] || 'null')
          if (!Array.isArray(items)) return
          const { addMemory } = require('./memory.ts')
          for (const item of items.slice(0, 3)) {
            if (!item.content) continue
            const scope = item.about ? 'deep_feeling' : 'wisdom'
            const tag = item.type || '深层'
            addMemory(`[${tag}] ${item.content.slice(0, 120)}${item.about ? ` (关于${item.about})` : ''}`, scope, userId, 'private')
            console.log(`[cc-soul][avatar] deep-soul LLM: [${tag}] ${item.content.slice(0, 40)}`)
          }
          saveProfile(userId)
        } catch {}
      }, 20000
    )
  }

  saveProfile(userId)
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOUL INJECTION — generate reply AS the user (not imitating — being)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Gather all cognitive data about the user from every module.
 * This is the "soul" that gets injected into the LLM.
 */
function gatherSoulContext(userId: string, sender: string, message: string): string {
  const profile = loadAvatarProfile(userId)
  const sections: string[] = []

  // ── 1. WHO I AM (person-model: identity + values + beliefs) ──
  try {
    const { getPersonModel } = require('./person-model.ts')
    const pm = getPersonModel()
    if (pm.distillCount > 0) {
      const parts: string[] = []
      if (pm.identity) parts.push(`我是：${pm.identity}`)
      if (pm.thinkingStyle) parts.push(`思维方式：${pm.thinkingStyle}`)
      if (pm.values.length > 0) parts.push(`价值观：${pm.values.join('、')}`)
      if (pm.beliefs.length > 0) parts.push(`信念：${pm.beliefs.join('、')}`)
      if (parts.length > 0) sections.push(`[我是谁]\n${parts.join('\n')}`)
    }
  } catch {}

  // ── 2. MY CONTRADICTIONS (真人都有矛盾) ──
  try {
    const { getPersonModel } = require('./person-model.ts')
    const pm = getPersonModel()
    if (pm.contradictions.length > 0) {
      sections.push(`[我的矛盾面]\n${pm.contradictions.map((c: string) => `- ${c}`).join('\n')}`)
    }
  } catch {}

  // ── 3. MY HISTORY WITH THIS PERSON (memories recall by sender name) ──
  try {
    const { recall } = require('./memory.ts')
    const memories: Memory[] = recall(sender + ' ' + message, 8, userId)
    const relevant = memories.filter(m =>
      m.content.includes(sender) || m.scope === 'episode' || m.scope === 'preference'
    ).slice(0, 6)
    if (relevant.length > 0) {
      sections.push(`[我和${sender}的记忆]\n${relevant.map(m => `- ${m.content.slice(0, 80)}`).join('\n')}`)
    }
  } catch {}

  // ── 4. MY DECISION PATTERNS (how I decide in similar scenarios) ──
  if (profile.decisions.traces.length > 0) {
    const traces = profile.decisions.traces.slice(-5)
      .map(t => `场景"${t.scenario}"→选了"${t.chose}"${t.reason ? '因为' + t.reason : ''}${t.rejected ? '，排除了' + t.rejected : ''}`)
    sections.push(`[我的决策模式]\n${traces.join('\n')}`)
  }

  // ── 5. MY EMOTIONAL STATE — real-time, not historical ──
  const emotionParts: string[] = []

  // Historical triggers (what kind of things make me react)
  for (const [emotion, triggers] of Object.entries(profile.emotional_patterns.triggers)) {
    if ((triggers as string[]).length > 0) {
      emotionParts.push(`${emotion}时我会说：${(triggers as string[]).slice(-2).join('、')}`)
    }
  }

  // CURRENT emotional state (already altered by the "nerve" above)
  try {
    // Mood — the core emotional axis
    const m = body.mood
    const moodLabel = m > 0.5 ? '很开心' : m > 0.2 ? '心情不错' : m > -0.2 ? '平静'
      : m > -0.5 ? '有点低落' : '很难受'

    // Energy — affects patience and verbosity
    const e = body.energy
    const energyLabel = e > 0.7 ? '精力充沛，愿意多聊' : e > 0.4 ? '状态还行'
      : e > 0.2 ? '有点累，不想说太多' : '极度疲惫，只想简短回复'

    // 5-dimensional emotion vector (if available)
    const { emotionVector } = require('./body.ts')
    const ev = emotionVector
    const dimensions: string[] = []
    if (ev) {
      if (ev.pleasure < -0.3) dimensions.push('不愉快')
      if (ev.arousal > 0.5) dimensions.push('情绪激动')
      if (ev.dominance < -0.3) dimensions.push('感到无力')
      if (ev.certainty < -0.3) dimensions.push('不确定/焦虑')
      if (ev.novelty > 0.3) dimensions.push('觉得新鲜/意外')
    }

    emotionParts.push(`此刻的我：${moodLabel}，${energyLabel}${dimensions.length > 0 ? '，' + dimensions.join('、') : ''}`)
    emotionParts.push(`（这会影响我回复的语气——低落时话少、疲惫时不耐烦、开心时话多）`)
  } catch {}

  if (emotionParts.length > 0) {
    sections.push(`[我此刻的情绪状态]\n${emotionParts.join('\n')}`)
  }

  // ── 6. MY COMMUNICATION DECODER (短消息的真实含义) ──
  try {
    const { getPersonModel } = require('./person-model.ts')
    const pm = getPersonModel()
    const decoder = Object.entries(pm.communicationDecoder || {}).slice(0, 5)
    if (decoder.length > 0) {
      sections.push(`[我的沟通密码]\n${decoder.map(([k, v]) => `我说"${k}"其实意思是"${v}"`).join('\n')}`)
    }
  } catch {}

  // ── 7. MY CURRENT SITUATION (recent events, unresolved things) ──
  try {
    const { recall } = require('./memory.ts')
    const recentMems: Memory[] = recall(message, 5, userId)
    const recent = recentMems
      .filter(m => Date.now() - (m.createdAt || 0) < 7 * 24 * 3600_000)
      .slice(0, 3)
    if (recent.length > 0) {
      sections.push(`[最近发生的事]\n${recent.map(m => `- ${m.content.slice(0, 60)}`).join('\n')}`)
    }
  } catch {}
  // Time awareness
  const now = new Date()
  const hour = now.getHours()
  const timeLabel = hour < 6 ? '凌晨' : hour < 9 ? '早上' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 22 ? '晚上' : '深夜'
  sections.push(`[当前时间] ${timeLabel}${hour}点`)

  // ── 8. MY KNOWLEDGE BOUNDARIES (what I know and don't know) ──
  try {
    const { getPersonModel } = require('./person-model.ts')
    const pm = getPersonModel()
    if (pm.domainExpertise && Object.keys(pm.domainExpertise).length > 0) {
      const expertAreas = Object.entries(pm.domainExpertise)
        .map(([d, level]) => `${d}: ${level}`)
      sections.push(`[我懂什么不懂什么]\n${expertAreas.join('、')}\n不懂的领域就说不懂，不要装专家`)
    }
  } catch {}

  // ── 9. MY BEHAVIORAL BOUNDARIES ──
  // Note: boundaries are defaults and should eventually be learned from data.
  if (profile.boundaries.never.length > 0) {
    sections.push(`[绝对不做]\n${profile.boundaries.never.map(b => `- ${b}`).join('\n')}`)
  }

  // ── 9. MY DEEPEST SELF (wisdom, regrets, unsaid words, deep feelings) ──
  // These are the memories that make a person irreplaceable.
  try {
    const { getMemoriesByScope } = require('./memory.ts')
    const deepScopes = ['wisdom', 'regret', 'unsaid', 'deep_feeling', 'value_transmit']
    const deepMemories: string[] = []
    for (const scope of deepScopes) {
      const mems = getMemoriesByScope(scope)
      if (mems && mems.length > 0) {
        for (const m of mems.slice(-3)) {
          deepMemories.push(m.content.slice(0, 80))
        }
      }
    }
    if (deepMemories.length > 0) {
      sections.push(`[我内心最深处的东西]\n${deepMemories.map(m => `- ${m}`).join('\n')}`)
    }
  } catch {}

  // ── 10. DEEP FEELINGS ABOUT THIS SPECIFIC PERSON ──
  try {
    const { recall } = require('./memory.ts')
    const feelingMems: Memory[] = recall(sender, 5, userId)
    const deepAboutSender = feelingMems.filter(m =>
      (m.scope === 'deep_feeling' || m.scope === 'unsaid' || m.scope === 'value_transmit')
      && m.content.includes(sender)
    ).slice(0, 3)
    if (deepAboutSender.length > 0) {
      sections.push(`[我对${sender}的深层感受]\n${deepAboutSender.map(m => `- ${m.content.slice(0, 80)}`).join('\n')}`)
    }
  } catch {}

  return sections.join('\n\n')
}

/**
 * Generate a reply AS the user — soul injection, not style mimicry.
 * Returns async via callback.
 */
export function generateAvatarReply(
  userId: string,
  sender: string,
  message: string,
  callback: (reply: string, refused?: boolean) => void,
) {
  const profile = loadAvatarProfile(userId)

  // ── Boundary check ──
  const isNever = profile.boundaries.never.some(b =>
    message.includes(b) || (b === '涉及金钱' && /借|钱|转账|付款/.test(message))
  )
  if (isNever) {
    callback('', true) // refused
    return
  }

  const isAskFirst = profile.boundaries.ask_first.some(b =>
    message.includes(b) || (b === '工作决策' && /决定|批准|同意|确认/.test(message))
  )
  if (isAskFirst) {
    callback(`[需要本人确认] ${sender}说: "${message}"`, true)
    return
  }

  // ── Trigger emotional response BEFORE generating reply ──
  // This is the "nerve" — the message hits the emotional system first,
  // changing mood/energy/arousal in real-time, THEN the reply is generated
  // with the ALTERED emotional state. Not "look up what I should feel" —
  // actually feel it, then respond.
  try {
    const { processEmotionalContagion } = require('./body.ts')
    const { cogProcess } = require('./cognition.ts')

    // Run cognition to detect emotional weight of the incoming message
    const cog = cogProcess(message, userId)

    // Let the emotional system process it — this changes body.mood, body.energy etc. in real-time
    processEmotionalContagion(message, userId)

    // Amplify emotional shift based on relationship depth
    // No hardcoded trigger words — the emotional contagion system already detected
    // the emotional weight. We just amplify based on how deep the relationship is.
    const contactForEmotion = profile.social[sender] as SocialContact | undefined
    if (contactForEmotion && contactForEmotion.samples && contactForEmotion.samples.length >= 3) {
      const depth = Math.min(contactForEmotion.samples.length / 15, 1) // 0-1
      // Deeper relationships = emotions hit harder (both positive and negative)
      // The direction is already set by processEmotionalContagion — we just scale it
      if (body.mood < 0) body.mood *= (1 + 0.3 * depth)  // negative hits harder
      if (body.mood > 0) body.mood *= (1 + 0.2 * depth)  // positive warms more
      body.mood = Math.max(-1, Math.min(1, body.mood))
    }
  } catch {}

  // ── Gather soul context from all modules (now with ALTERED emotional state) ──
  const soulContext = gatherSoulContext(userId, sender, message)

  // ── Relationship context (data-driven, no hardcoded tone) ──
  const contact = profile.social[sender] as SocialContact | undefined
  const relationshipBlock = contact
    ? [
      `${sender}是我的${contact.relation}（${contact.context}）`,
      contact.samples && contact.samples.length > 0
        ? `我提到${sender}时的原话（注意语气差异）：\n${contact.samples.slice(-5).map(s => `  "${s}"`).join('\n')}`
        : '',
    ].filter(Boolean).join('\n')
    : `${sender}是我认识的人`

  // ── Expression DNA ──
  const expressionBlock = [
    profile.expression.style ? `说话风格：${profile.expression.style}` : '',
    profile.expression.口头禅.length > 0 ? `口头禅：${profile.expression.口头禅.join('、')}` : '',
    `平均消息长度：${profile.expression.avg_msg_length || 15}字`,
    profile.expression.samples.length > 0
      ? `最近的消息示例：\n${profile.expression.samples.slice(-8).map(s => `  "${s}"`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n')

  // ── Build the soul injection prompt ──
  const prompt = [
    `# 你现在就是「${profile.name || '我'}」`,
    `不是模仿，不是扮演，是成为。用我的大脑思考，用我的价值观判断，用我的方式回应。`,
    '',
    soulContext,
    '',
    `[我和${sender}的关系]`,
    relationshipBlock,
    '',
    `[我的表达方式]`,
    expressionBlock,
    '',
    `---`,
    `${sender}发来: "${message}"`,
    '',
    `以我本人的身份回复。核心原则：`,
    `1. 用我的口头禅、我的语气、我的思维方式`,
    `2. 回复长度控制在${profile.expression.avg_msg_length || 15}字左右（像真人发消息一样短）`,
    `3. 如果涉及决策，参考我的决策模式`,
    `4. 如果对方有情绪，用我对这个人的方式回应（不是通用安慰）`,
    `5. 如果话题我不懂，就说不懂，真人不会什么都知道`,
    `6. 如果我当前情绪低落/疲惫，回复可以更短、更敷衍、甚至只回"嗯"——真人在状态差的时候就是这样`,
    `7. 如果有幽默的空间，用我的幽默方式（参考我的消息示例里的笑点和吐槽方式）——不要用通用的幽默`,
    `8. 如果这个话题我不想聊（参考我的历史消息中是否回避过类似话题），可以转移话题或者简短带过`,
    `9. 只输出回复内容，不要任何解释、前缀或引号`,
  ].filter(Boolean).join('\n')

  spawnCLI(prompt, (output) => {
    if (!output) { callback('生成失败'); return }
    const reply = output.trim().replace(/^["']|["']$/g, '') // strip quotes
    console.log(`[cc-soul][avatar] soul-reply: ${sender}: "${message}" → "${reply.slice(0, 80)}"`)
    callback(reply)
  }, 25000)
}

// Note: Active probing (Step 1) uses inner-life.ts follow-up system — no duplication.
// Note: Deep synthesis (Step 2) now lives in person-model.ts distillPersonModel() — no duplication.

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

export function getAvatarStats(userId: string): {
  samples: number
  catchphrases: number
  decisions: number
  contacts: number
  emotions: number
  style: string
} {
  const profile = loadAvatarProfile(userId)
  return {
    samples: profile.expression.samples.length,
    catchphrases: profile.expression.口头禅.length,
    decisions: profile.decisions.traces.length,
    contacts: Object.keys(profile.social).length,
    emotions: Object.keys(profile.emotional_patterns.triggers).length,
    style: profile.expression.style || '(数据不足)',
  }
}
