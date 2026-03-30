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
import { body, emotionVector, getEmotionVector } from './body.ts'
import type { Memory } from './types.ts'

// Lazy-loaded modules (to avoid circular imports at module level)
// These are loaded once on first use and cached.
let _personModel: any = null
let _memory: any = null

async function getPersonModelModule() {
  if (!_personModel) _personModel = await import('./person-model.ts')
  return _personModel
}
async function getMemoryModule() {
  if (!_memory) _memory = await import('./memory.ts')
  return _memory
}

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
  // Dynamic vocabulary — learned by LLM, not hardcoded.
  // Used as fast-path detection for subsequent messages.
  // Empty at start, populated after first LLM analysis cycle.
  vocabulary: {
    emotions: Record<string, string[]>   // e.g. {"frustrated": ["绷不住","烦死了"], "happy": ["牛","爽"]}
    decisions: string[]                  // e.g. ["我选","还是...吧","我决定"]
    relations: string[]                  // e.g. ["媳妇","哥们","领导","老大"]
    avoidance: string[]                  // topics this person avoids
    decoder: Record<string, string>      // short msg → real meaning
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
      can_reply: [],
      ask_first: [],
      never: [],
    },
    vocabulary: {
      emotions: {},
      decisions: [],
      relations: [],
      avoidance: [],
      decoder: {},
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
  // Strategy: extract ALL possible 2-3 char CJK substrings that could be catchphrases,
  // then let frequency filtering do the work (only ≥3 occurrences across samples = catchphrase).
  // This avoids complex regex for positional detection.
  const shortPhrases = new Set<string>()
  // Extract all 2-char and 3-char CJK substrings from the message
  const cjkChars = userMsg.match(/[\u4e00-\u9fff]+/g) || []
  for (const seg of cjkChars) {
    for (let len = 2; len <= 3; len++) {
      for (let i = 0; i <= seg.length - len; i++) {
        shortPhrases.add(seg.slice(i, i + len))
      }
    }
  }

  // Filter catchphrases: frequency ≥ 3, deduplicate substrings, skip 1-char phrases
  // Known names to exclude from catchphrase detection
  const knownNames = new Set(Object.keys(profile.social))

  for (const phrase of shortPhrases) {
    if (phrase.length >= 2 && phrase.length <= 3) {
      if (!profile.expression.口头禅.includes(phrase)) {
        // Skip if it's a known person's name
        if (knownNames.has(phrase)) continue
        const count = profile.expression.samples.filter(s => s.includes(phrase)).length
        if (count >= 3) {
          // Skip if it's a substring of an existing longer catchphrase
          const isSubOfExisting = profile.expression.口头禅.some(existing => existing.length > phrase.length && existing.includes(phrase))
          if (isSubOfExisting) continue
          // Skip if it's a common grammar particle (>60% of samples = too universal)
          const ratio = count / Math.max(profile.expression.samples.length, 1)
          if (ratio > 0.6 && profile.expression.samples.length >= 10) continue
          // Remove existing shorter substrings that this phrase supersedes
          profile.expression.口头禅 = profile.expression.口头禅.filter(existing => !(existing.length < phrase.length && phrase.includes(existing)))
          profile.expression.口头禅.push(phrase)
          if (profile.expression.口头禅.length > 10) profile.expression.口头禅.shift()
          console.log(`[cc-soul][avatar] new 口头禅 detected: "${phrase}"`)
        }
      }
    }
  }

  // ── 3. Decision trace extraction (fully dynamic) ──
  // Fast path: use learned vocabulary (if available)
  // Cold start: every message >15 chars goes to LLM for decision detection (expensive but necessary)
  // After vocabulary is learned: only matched messages go to LLM
  const decisionWords = profile.vocabulary?.decisions || []
  const hasDecisionFast = decisionWords.length > 0 && decisionWords.some(w => userMsg.includes(w))
  const inColdStart = decisionWords.length === 0 && userMsg.length > 15
  if ((hasDecisionFast || inColdStart) && profile.decisions.traces.length < 20) {
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

  // ── 4. Social relation extraction (fully LLM-driven) ──
  // No hardcoded relation words. LLM decides what's a person mention and what the relation is.
  // Uses learned vocabulary.relations as a hint, but doesn't require it.
  {
    // Check if message mentions a known contact → add to their samples
    let mentionedKnown = false
    for (const [name, contact] of Object.entries(profile.social)) {
      const sc = contact as SocialContact
      if (userMsg.includes(name)) {
        mentionedKnown = true
        if (!sc.samples) sc.samples = []
        const sample = userMsg.slice(0, 100)
        if (!sc.samples.includes(sample)) {
          sc.samples.push(sample)
          if (sc.samples.length > 15) sc.samples.shift()
        }
      }
    }

    // If message seems to mention a person (CJK name-like pattern) and it's not a known contact
    // → ask LLM to extract the relationship
    const nameCandidate = userMsg.match(/[\u4e00-\u9fff]{2,4}(?:说|问|回|发|给|叫|让|找|约|跟|和|对|是我)/)
      || userMsg.match(/我[\u4e00-\u9fff]{2,6}[\u4e00-\u9fff]{2,3}/)  // "我同事阿昊" pattern
    if (nameCandidate && !mentionedKnown && Object.keys(profile.social).length < 30) {
      spawnCLI(
        `从这句话中提取人物关系。要求：
1. name 必须是具体的人名（如"阿昊""沈婉宁""老孟"），不能是称呼词（如"老公""爸爸""老板""VP"）
2. 如果只有称呼没有人名，回答 "null"
3. 输出 JSON: {"name":"具体人名","relation":"关系","context":"简要背景"}

"${userMsg.slice(0, 200)}"`,
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

  // (Per-relationship sample collection is now inside section 4 above)

  // ── 5. Emotional pattern tracking (dynamic vocabulary) ──
  // Use learned vocabulary if available, otherwise skip (LLM will catch it in periodic analysis)
  const learnedEmotions = profile.vocabulary?.emotions || {}
  for (const [emotion, words] of Object.entries(learnedEmotions)) {
    if ((words as string[]).some(w => userMsg.includes(w))) {
      if (!profile.emotional_patterns.triggers[emotion]) {
        profile.emotional_patterns.triggers[emotion] = []
      }
      const trigger = userMsg.slice(0, 40)
      if (!profile.emotional_patterns.triggers[emotion].includes(trigger)) {
        profile.emotional_patterns.triggers[emotion].push(trigger)
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

  // ── 7. Dynamic vocabulary learning ──
  // LLM analyzes messages and builds a custom vocabulary for THIS person.
  // Trigger: every 10 samples (offset by 3), OR on first 10 samples if vocab is empty (cold start).
  const vocabEmpty = !profile.vocabulary?.emotions || Object.keys(profile.vocabulary.emotions).length === 0
  const shouldLearnVocab = profile.expression.samples.length > 0 && (
    profile.expression.samples.length % 10 === 3 ||
    (vocabEmpty && profile.expression.samples.length >= 8)  // cold start: learn after 8 samples
  )
  if (shouldLearnVocab) {
    const vocabBatch = profile.expression.samples.slice(-10).map((s, i) => `${i + 1}. ${s}`).join('\n')
    spawnCLI(
      `分析这个用户的语言习惯，提取他/她个人的词汇表。输出 JSON：
{
  "emotions": {"开心":["这人用哪些词表达开心"],"烦躁":["..."],"低落":["..."],"愤怒":["..."]},
  "decisions": ["这人做决策时用的词/句式，如'我选''还是...吧'"],
  "relations": ["这人称呼别人用的词，如'媳妇''哥们''老大'"],
  "decoder": {"这人常用的短消息":"真实含义"},
  "avoidance": ["这人似乎回避的话题"]
}

只提取在消息中有证据的，没有就留空数组/对象。

消息：
${vocabBatch}`,
      (output) => {
        if (!output) return
        try {
          const vocab = JSON.parse(output.match(/\{[\s\S]*\}/)?.[0] || 'null')
          if (!vocab) return
          if (!profile.vocabulary) profile.vocabulary = { emotions: {}, decisions: [], relations: [], avoidance: [], decoder: {} }
          // Merge (don't replace — accumulate)
          if (vocab.emotions) {
            for (const [e, words] of Object.entries(vocab.emotions)) {
              if (!profile.vocabulary.emotions[e]) profile.vocabulary.emotions[e] = []
              for (const w of (words as string[])) {
                if (!profile.vocabulary.emotions[e].includes(w)) profile.vocabulary.emotions[e].push(w)
              }
              if (profile.vocabulary.emotions[e].length > 10) profile.vocabulary.emotions[e] = profile.vocabulary.emotions[e].slice(-10)
            }
          }
          if (vocab.decisions) {
            for (const d of vocab.decisions) {
              if (!profile.vocabulary.decisions.includes(d)) profile.vocabulary.decisions.push(d)
            }
            if (profile.vocabulary.decisions.length > 15) profile.vocabulary.decisions = profile.vocabulary.decisions.slice(-15)
          }
          if (vocab.relations) {
            for (const r of vocab.relations) {
              if (!profile.vocabulary.relations.includes(r)) profile.vocabulary.relations.push(r)
            }
          }
          if (vocab.decoder) {
            Object.assign(profile.vocabulary.decoder, vocab.decoder)
          }
          if (vocab.avoidance) {
            for (const a of vocab.avoidance) {
              if (!profile.vocabulary.avoidance.includes(a)) profile.vocabulary.avoidance.push(a)
            }
          }
          saveProfile(userId)
          console.log(`[cc-soul][avatar] vocabulary learned: ${JSON.stringify(vocab).slice(0, 100)}`)
        } catch {}
      }, 20000
    )
  }

  // ── 8. Deep soul extraction — LLM-driven, no hardcoded patterns ──
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
      async (output) => {
        if (!output || output.includes('null')) return
        try {
          const items = JSON.parse(output.match(/\[[\s\S]*\]/)?.[0] || 'null')
          if (!Array.isArray(items)) return
          const { addMemory } = await getMemoryModule()
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
async function gatherSoulContext(userId: string, sender: string, message: string): Promise<string> {
  const profile = loadAvatarProfile(userId)
  const sections: string[] = []

  // ── 1. WHO I AM (person-model: identity + values + beliefs) ──
  try {
    const { getPersonModel } = await getPersonModelModule()
    const pm = getPersonModel()
    if (pm.distillCount > 0) {
      const parts: string[] = []
      if (pm.identity) parts.push(`我是：${pm.identity}`)
      if (pm.thinkingStyle) parts.push(`思维方式：${pm.thinkingStyle}`)
      if (pm.values.length > 0) parts.push(`价值观：${pm.values.join('、')}`)
      if (pm.beliefs.length > 0) parts.push(`信念：${pm.beliefs.join('、')}`)
      const rp = pm.reasoningProfile
      if (rp && rp._counts?.total >= 10) {
        const t: string[] = []
        if (rp.style !== 'unknown') t.push(rp.style === 'conclusion_first' ? '我习惯先说结论再解释' : '我习惯层层递进地论证')
        if (rp.evidence !== 'unknown') t.push(rp.evidence === 'data' ? '我喜欢用数据说话' : rp.evidence === 'analogy' ? '我喜欢打比方' : '我数据和类比都用')
        if (rp.certainty !== 'unknown') t.push(rp.certainty === 'assertive' ? '我说话很笃定' : rp.certainty === 'hedging' ? '我表达偏保守谨慎' : '我有时笃定有时谨慎')
        if (rp.disagreement !== 'unknown') t.push(rp.disagreement === 'dig_in' ? '不同意时我会坚持' : rp.disagreement === 'compromise' ? '不同意时我倾向妥协' : '不同意时我会追问为什么')
        if (t.length > 0) parts.push(`论证风格：${t.join('；')}`)
      }
      if (parts.length > 0) sections.push(`[我是谁]\n${parts.join('\n')}`)
    }
  } catch {}

  // ── 2. MY CONTRADICTIONS (真人都有矛盾) ──
  try {
    const { getPersonModel } = await getPersonModelModule()
    const pm = getPersonModel()
    if (pm.contradictions.length > 0) {
      sections.push(`[我的矛盾面]\n${pm.contradictions.map((c: string) => `- ${c}`).join('\n')}`)
    }
  } catch {}

  // ── 3. MY HISTORY WITH THIS PERSON (memories recall by sender name) ──
  try {
    const { recall } = await getMemoryModule()
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

    // 5-dimensional emotion vector (per-user)
    const ev2 = getEmotionVector(userId)
    const dimensions: string[] = []
    if (ev2) {
      if (ev2.pleasure < -0.3) dimensions.push('不愉快')
      if (ev2.arousal > 0.5) dimensions.push('情绪激动')
      if (ev2.dominance < -0.3) dimensions.push('感到无力')
      if (ev2.certainty < -0.3) dimensions.push('不确定/焦虑')
      if (ev2.novelty > 0.3) dimensions.push('觉得新鲜/意外')
    }

    emotionParts.push(`此刻的我：${moodLabel}，${energyLabel}${dimensions.length > 0 ? '，' + dimensions.join('、') : ''}`)
    emotionParts.push(`（这会影响我回复的语气——低落时话少、疲惫时不耐烦、开心时话多）`)
  } catch {}

  if (emotionParts.length > 0) {
    sections.push(`[我此刻的情绪状态]\n${emotionParts.join('\n')}`)
  }

  // ── 6. MY COMMUNICATION DECODER (from learned vocabulary + person-model) ──
  {
    const allDecoder: Record<string, string> = {}
    // From learned vocabulary (dynamic)
    if (profile.vocabulary?.decoder) Object.assign(allDecoder, profile.vocabulary.decoder)
    // From person-model (rule-based fallback)
    try {
      const { getPersonModel } = await getPersonModelModule()
      const pm = getPersonModel()
      if (pm.communicationDecoder) Object.assign(allDecoder, pm.communicationDecoder)
    } catch {}
    const entries = Object.entries(allDecoder).slice(0, 8)
    if (entries.length > 0) {
      sections.push(`[我的沟通密码]\n${entries.map(([k, v]) => `我说"${k}"其实意思是"${v}"`).join('\n')}`)
    }
  }

  // ── 7. MY CURRENT SITUATION (recent events, unresolved things) ──
  try {
    const { recall } = await getMemoryModule()
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
    const { getPersonModel } = await getPersonModelModule()
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
    const { getMemoriesByScope } = await getMemoryModule()
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
    const { recall } = await getMemoryModule()
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
  // Wrap in async IIFE since getAvatarPrompt is async
  ;(async () => {
  const profile = loadAvatarProfile(userId)

  // ── Boundary check (dynamic — learned from data, no hardcoded patterns) ──
  if (profile.boundaries.never.length > 0) {
    const isNever = profile.boundaries.never.some(b => message.includes(b))
    if (isNever) {
      callback('', true) // refused
      return
    }
  }
  if (profile.boundaries.ask_first.length > 0) {
    const isAskFirst = profile.boundaries.ask_first.some(b => message.includes(b))
    if (isAskFirst) {
      callback(`[需要本人确认] ${sender}说: "${message}"`, true)
      return
    }
  }

  // ── Emotional "nerve" — amplify based on relationship depth ──
  // NOTE: processEmotionalContagion is already called by handlePreprocessed for normal messages.
  // We do NOT call it again here to avoid double-processing.
  // Instead, we only amplify the EXISTING emotional state based on relationship depth.
  try {
    const contactForEmotion = profile.social[sender] as SocialContact | undefined
    if (contactForEmotion && contactForEmotion.samples && contactForEmotion.samples.length >= 3) {
      const depth = Math.min(contactForEmotion.samples.length / 15, 1) // 0-1
      if (body.mood < 0) body.mood *= (1 + 0.3 * depth)
      if (body.mood > 0) body.mood *= (1 + 0.2 * depth)
      body.mood = Math.max(-1, Math.min(1, body.mood))
    }
  } catch {}

  // ── Build soul prompt (reuses getAvatarPrompt) then append the actual message ──
  const basePrompt = await getAvatarPrompt(userId, sender, message)
  const prompt = basePrompt + `\n\n${sender}发来: "${message}"\n\n以我本人的身份回复。`

  spawnCLI(prompt, (output) => {
    if (!output) { callback('生成失败'); return }
    const reply = output.trim().replace(/^["']|["']$/g, '') // strip quotes
    console.log(`[cc-soul][avatar] soul-reply: ${sender}: "${message}" → "${reply.slice(0, 80)}"`)
    callback(reply)
  }, 25000)
  })().catch((e) => {
    console.error(`[cc-soul][avatar] generateAvatarReply error: ${e.message}`)
    callback('生成失败')
  })
}

// Note: Active probing (Step 1) uses inner-life.ts follow-up system — no duplication.
// Note: Deep synthesis (Step 2) now lives in person-model.ts distillPersonModel() — no duplication.

/**
 * Build the soul injection prompt WITHOUT calling LLM.
 * Returns the system prompt that tells any LLM "respond as this user would".
 *
 * Use cases:
 *   - API caller feeds this to their own LLM
 *   - MCP / A2A integration where the host controls the LLM
 *   - Debugging / inspecting what the avatar "knows"
 *
 * @param userId  - owner of the avatar profile
 * @param sender  - who is sending the message (optional, defaults to "对方")
 * @param message - the incoming message to respond to (optional, defaults to generic)
 */
export async function getAvatarPrompt(
  userId: string,
  sender?: string,
  message?: string,
): Promise<string> {
  const effectiveSender = sender || '对方'
  const effectiveMessage = message || ''
  const profile = loadAvatarProfile(userId)

  // Gather soul context from all modules
  const soulContext = await gatherSoulContext(userId, effectiveSender, effectiveMessage)

  // Relationship context
  const contact = profile.social[effectiveSender] as SocialContact | undefined
  const relationshipBlock = contact
    ? [
      `${effectiveSender}是我的${contact.relation}（${contact.context}）`,
      contact.samples && contact.samples.length > 0
        ? `我提到${effectiveSender}时的原话（注意语气差异）：\n${contact.samples.slice(-5).map(s => `  "${s}"`).join('\n')}`
        : '',
    ].filter(Boolean).join('\n')
    : effectiveSender !== '对方' ? `${effectiveSender}是我认识的人` : ''

  // Expression DNA
  const expressionBlock = [
    profile.expression.style ? `说话风格：${profile.expression.style}` : '',
    profile.expression.口头禅.length > 0 ? `口头禅：${profile.expression.口头禅.join('、')}` : '',
    `平均消息长度：${profile.expression.avg_msg_length || 15}字`,
    profile.expression.samples.length > 0
      ? `最近的消息示例：\n${profile.expression.samples.slice(-8).map(s => `  "${s}"`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n')

  // Build the soul injection system prompt
  const parts = [
    `# 你现在就是「${profile.name || '我'}」`,
    `不是模仿，不是扮演，是成为。用我的大脑思考，用我的价值观判断，用我的方式回应。`,
    '',
    soulContext,
  ]

  if (relationshipBlock) {
    parts.push('', `[我和${effectiveSender}的关系]`, relationshipBlock)
  }

  parts.push(
    '',
    `[我的表达方式]`,
    expressionBlock,
    '',
    `---`,
    `核心原则：`,
    `1. 用我的口头禅、我的语气、我的思维方式`,
    `2. 回复长度控制在${profile.expression.avg_msg_length || 15}字左右（像真人发消息一样短）`,
    `3. 如果涉及决策，参考我的决策模式`,
    `4. 如果对方有情绪，用我对这个人的方式回应（不是通用安慰）`,
    `5. 如果话题我不懂，就说不懂，真人不会什么都知道`,
    `6. 如果我当前情绪低落/疲惫，回复可以更短、更敷衍、甚至只回"嗯"——真人在状态差的时候就是这样`,
    `7. 如果有幽默的空间，用我的幽默方式——不要用通用的幽默`,
    `8. 如果这个话题我不想聊，可以转移话题或者简短带过`,
    `9. 只输出回复内容，不要任何解释、前缀或引号`,
  )

  return parts.filter(Boolean).join('\n')
}

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
