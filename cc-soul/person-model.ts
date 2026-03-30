/**
 * person-model.ts — Person Model distillation
 *
 * Continuously distills conversation patterns into a holistic understanding
 * of who the user IS, not just what they said.
 */
import { resolve } from 'path'
import { DATA_DIR, loadJson, debouncedSave } from './persistence.ts'
import { memoryState, ensureMemoriesLoaded } from './memory.ts'
import { detectDomain } from './epistemic.ts'
import { buildMentalModelAugment, buildTopicAugment } from './distill.ts'

// Lazy modules (avoid circular deps + ESM require)
let _bodyMod: any = null
let _memMod: any = null
let _cliMod: any = null
function lazyBody() { if (!_bodyMod) { import('./body.ts').then(m => { _bodyMod = m }).catch(() => {}) }; return _bodyMod }
function lazyMem() { if (!_memMod) { import('./memory.ts').then(m => { _memMod = m }).catch(() => {}) }; return _memMod }
function lazyCli() { if (!_cliMod) { import('./cli.ts').then(m => { _cliMod = m }).catch(() => {}) }; return _cliMod }
setTimeout(() => {
  import('./body.ts').then(m => { _bodyMod = m }).catch(() => {})
  import('./memory.ts').then(m => { _memMod = m }).catch(() => {})
  import('./cli.ts').then(m => { _cliMod = m }).catch(() => {})
}, 500)

const PERSON_MODEL_PATH = resolve(DATA_DIR, 'person_model.json')

export interface ReasoningProfile {
  style: 'conclusion_first' | 'buildup' | 'unknown'
  evidence: 'data' | 'analogy' | 'mixed' | 'unknown'
  certainty: 'assertive' | 'hedging' | 'mixed' | 'unknown'
  disagreement: 'dig_in' | 'compromise' | 'question' | 'unknown'
  _counts: { style: Record<string, number>; evidence: Record<string, number>; certainty: Record<string, number>; disagreement: Record<string, number>; total: number }
}

export interface PersonModel {
  identity: string           // who they are
  thinkingStyle: string      // how they think
  values: string[]           // what they care about (max 10)
  beliefs: string[]          // deep worldview beliefs (max 10)
  contradictions: string[]   // things they're contradictory about (max 5)
  communicationDecoder: Record<string, string>  // "算了" → "换个角度", "随便" → "你来决定"
  domainExpertise: Record<string, 'beginner' | 'intermediate' | 'expert'>
  reasoningProfile: ReasoningProfile
  updatedAt: number
  distillCount: number       // how many times distilled
}

let personModel: PersonModel = loadJson<PersonModel>(PERSON_MODEL_PATH, {
  identity: '',
  thinkingStyle: '',
  values: [],
  beliefs: [],
  contradictions: [],
  communicationDecoder: {},
  domainExpertise: {},
  reasoningProfile: { style: 'unknown', evidence: 'unknown', certainty: 'unknown', disagreement: 'unknown', _counts: { style: {}, evidence: {}, certainty: {}, disagreement: {}, total: 0 } },
  updatedAt: 0,
  distillCount: 0,
})

export function getPersonModel(): PersonModel { return personModel }
;(globalThis as any).__ccSoulPersonModel = personModel

/**
 * Distill person model from accumulated data.
 * Called from heartbeat (not every message — expensive).
 * Uses rule-based extraction, no LLM calls.
 */
export function distillPersonModel() {
  ensureMemoriesLoaded()
  const memories = memoryState.memories
  if (memories.length < 20) return // not enough data

  // ── Values extraction: from preference + correction patterns ──
  const prefs = memories.filter(m => m.scope === 'preference' && m.scope !== 'expired')
  const corrections = memories.filter(m => m.scope === 'correction' && m.scope !== 'expired')

  // Extract values from preferences
  const newValues: string[] = []
  for (const p of prefs.slice(-20)) {
    if (p.content.length > 10 && p.content.length < 100) {
      newValues.push(p.content.slice(0, 60))
    }
  }
  if (newValues.length > 0) {
    personModel.values = [...new Set([...personModel.values, ...newValues])].slice(-10)
  }

  // ── Belief extraction: from repeated patterns in corrections ──
  // If user corrects the same type of thing 3+ times, it's a belief
  const correctionDomains = new Map<string, number>()
  for (const c of corrections) {
    const d = detectDomain(c.content)
    correctionDomains.set(d, (correctionDomains.get(d) || 0) + 1)
  }
  for (const [domain, count] of correctionDomains) {
    if (count >= 3 && !personModel.beliefs.some(b => b.includes(domain))) {
      personModel.beliefs.push(`在${domain}领域有强烈的观点（被纠正${count}次仍坚持）`)
      if (personModel.beliefs.length > 10) personModel.beliefs.shift()
    }
  }

  // ── Contradiction archive: find conflicting preferences ──
  const prefContents = prefs.map(p => p.content.toLowerCase())
  const negators = ['不', '没', '别', '反对', '讨厌', '不喜欢']
  for (let i = 0; i < prefContents.length; i++) {
    for (let j = i + 1; j < prefContents.length; j++) {
      // Check if two preferences contradict (one has negator of the other's keyword)
      const words1 = prefContents[i].match(/[\u4e00-\u9fff]{2,4}/g) || []
      const words2 = prefContents[j].match(/[\u4e00-\u9fff]{2,4}/g) || []
      for (const w of words1) {
        if (words2.some(w2 => negators.some(n => w2 === n + w || w2 === w + n))) {
          const contradiction = `说过"${prefs[i].content.slice(0, 30)}"但也说过"${prefs[j].content.slice(0, 30)}"`
          if (!personModel.contradictions.includes(contradiction)) {
            personModel.contradictions.push(contradiction)
            if (personModel.contradictions.length > 5) personModel.contradictions.shift()
          }
        }
      }
    }
  }

  // ── Domain expertise: from chatHistory topic frequency + correction rate ──
  const history = memoryState.chatHistory
  const domainCounts = new Map<string, number>()
  for (const h of history.slice(-100)) {
    const d = detectDomain(h.user)
    if (d !== '闲聊' && d !== '通用') domainCounts.set(d, (domainCounts.get(d) || 0) + 1)
  }
  for (const [domain, count] of domainCounts) {
    const corrCount = correctionDomains.get(domain) || 0
    const corrRate = count > 0 ? corrCount / count : 0
    personModel.domainExpertise[domain] =
      count >= 10 && corrRate < 0.1 ? 'expert' :
      count >= 5 ? 'intermediate' : 'beginner'
  }

  // ── Communication decoder: from short messages that got follow-ups ──
  for (let i = 0; i < history.length - 1; i++) {
    const msg = history[i].user
    if (msg.length <= 4 && msg.length >= 1) {
      // Short message patterns
      if (msg === '算了' || msg === '好吧') {
        personModel.communicationDecoder[msg] = personModel.communicationDecoder[msg] || '可能需要换个角度'
      }
      if (msg === '随便' || msg === '都行') {
        personModel.communicationDecoder[msg] = personModel.communicationDecoder[msg] || '希望你来做决定'
      }
    }
  }

  // ── Emotional pattern extraction: via unified getMoodState() ──
  {
    const bm = lazyBody(); const getMoodState = bm?.getMoodState
    const moodState = getMoodState()
    if (moodState.moodRatio) {
      if (moodState.moodRatio.positive > moodState.moodRatio.negative * 2) {
        if (!personModel.values.includes('整体情绪积极')) personModel.values.push('整体情绪积极')
      } else if (moodState.moodRatio.negative > moodState.moodRatio.positive * 2) {
        if (!personModel.values.includes('近期情绪压力大')) personModel.values.push('近期情绪压力大')
      }
    }
  }

  // ── Emotion pattern tracking: which emotions does user experience most ──
  try {
    const memories = memoryState.memories.filter(m => (m as any).emotionLabel && m.scope !== 'expired')
    const emotionCounts = new Map<string, number>()
    for (const m of memories) {
      const label = (m as any).emotionLabel
      if (label && label !== 'neutral') {
        emotionCounts.set(label, (emotionCounts.get(label) || 0) + 1)
      }
    }
    if (emotionCounts.size >= 2) {
      const sorted = [...emotionCounts.entries()].sort((a, b) => b[1] - a[1])
      const topEmotions = sorted.slice(0, 3).map(([label, count]) => `${label}(${count}次)`)
      const pattern = `常见情绪: ${topEmotions.join('、')}`
      if (!personModel.values.includes(pattern) && !personModel.values.some(v => v.startsWith('常见情绪'))) {
        // Replace existing emotion pattern or add new
        const existingIdx = personModel.values.findIndex(v => v.startsWith('常见情绪'))
        if (existingIdx >= 0) personModel.values[existingIdx] = pattern
        else personModel.values.push(pattern)
      }
    }
  } catch {}

  // ── Reasoning profile: detect argument style, evidence, certainty, disagreement ──
  {
    if (!personModel.reasoningProfile?._counts) {
      personModel.reasoningProfile = { style: 'unknown', evidence: 'unknown', certainty: 'unknown', disagreement: 'unknown', _counts: { style: {}, evidence: {}, certainty: {}, disagreement: {}, total: 0 } }
    }
    const rp = personModel.reasoningProfile
    const rc = rp._counts
    const msgs = history.slice(-50).map(h => h.user).filter(m => m.length > 15)
    for (const m of msgs) {
      // Argument style
      if (/^.{3,20}(因为|因此|because|since)/i.test(m)) rc.style.conclusion_first = (rc.style.conclusion_first || 0) + 1
      else if (/首先|其次|最后|第一|第二|first|then|finally|secondly/i.test(m)) rc.style.buildup = (rc.style.buildup || 0) + 1
      // Evidence preference
      if (/\d+%|\d+\.\d|数据|指标|metrics|stat/i.test(m)) rc.evidence.data = (rc.evidence.data || 0) + 1
      if (/就像|好比|类似|like\s|similar\sto|好像.*一样|打个比方/i.test(m)) rc.evidence.analogy = (rc.evidence.analogy || 0) + 1
      // Certainty
      if (/可能|也许|不确定|maybe|perhaps|might|大概|应该是/i.test(m)) rc.certainty.hedging = (rc.certainty.hedging || 0) + 1
      if (/肯定|一定|绝对|必须|definitely|must|always|毫无疑问|确定/i.test(m)) rc.certainty.assertive = (rc.certainty.assertive || 0) + 1
      // Disagreement response
      if (/不对|你错了|我不同意|我坚持|no way|disagree|wrong/i.test(m)) rc.disagreement.dig_in = (rc.disagreement.dig_in || 0) + 1
      if (/也有道理|你说的对|折中|那就|行吧|fair point|compromise/i.test(m)) rc.disagreement.compromise = (rc.disagreement.compromise || 0) + 1
      if (/为什么|怎么说|你觉得呢|why|how come|what makes you/i.test(m)) rc.disagreement.question = (rc.disagreement.question || 0) + 1
      rc.total++
    }
    const pick = (counts: Record<string, number>) => { const e = Object.entries(counts); if (e.length === 0) return 'unknown'; e.sort((a, b) => b[1] - a[1]); return e[0][1] >= 10 ? (e.length > 1 && e[1][1] > e[0][1] * 0.6 ? 'mixed' : e[0][0]) : 'unknown' }
    if (rc.total >= 10) {
      rp.style = (pick(rc.style) === 'mixed' ? 'unknown' : pick(rc.style)) as any
      rp.evidence = pick(rc.evidence) as any
      rp.certainty = pick(rc.certainty) as any
      rp.disagreement = pick(rc.disagreement) as any
    }
  }

  personModel.updatedAt = Date.now()
  personModel.distillCount++
  debouncedSave(PERSON_MODEL_PATH, personModel)
  console.log(`[cc-soul][person-model] distilled #${personModel.distillCount}: ${personModel.values.length} values, ${personModel.beliefs.length} beliefs, ${personModel.contradictions.length} contradictions`)

  // ── LLM deep synthesis (every 5th distill, not every time — expensive) ──
  // This is the REAL understanding layer: WHY, not just WHAT.
  // The regex above catches surface patterns; the LLM below synthesizes meaning.
  if (personModel.distillCount % 5 === 0 && history.length >= 20) {
    const cm = lazyCli(); const spawnCLI = cm?.spawnCLI

    // Gather all available data for synthesis
    const dataPoints: string[] = []
    if (personModel.values.length > 0) dataPoints.push(`已知价值观：${personModel.values.join('、')}`)
    if (personModel.beliefs.length > 0) dataPoints.push(`已知信念：${personModel.beliefs.join('、')}`)
    if (personModel.contradictions.length > 0) dataPoints.push(`已知矛盾：${personModel.contradictions.join('、')}`)
    const expertDomains = Object.entries(personModel.domainExpertise)
    if (expertDomains.length > 0) dataPoints.push(`领域专长：${expertDomains.map(([d, l]) => `${d}(${l})`).join('、')}`)

    // Recent messages for behavioral context
    const recentMsgs = history.slice(-20).map(h => h.user).filter(m => m.length > 5)
    if (recentMsgs.length > 0) dataPoints.push(`最近的消息：\n${recentMsgs.slice(-10).map(m => `  "${m.slice(0, 60)}"`).join('\n')}`)

    // Deep memories
    try {
      const mm = lazyMem(); const getMemoriesByScope = mm?.getMemoriesByScope
      for (const scope of ['wisdom', 'deep_feeling', 'preference']) {
        const mems = getMemoriesByScope(scope)
        if (mems && mems.length > 0) {
          dataPoints.push(`${scope}记忆：${mems.slice(-3).map((m: any) => m.content.slice(0, 50)).join('；')}`)
        }
      }
    } catch {}

    spawnCLI(
      `你是一个人格心理学家。根据以下数据，用第一人称写一段深度自我认知（200字以内）。
不要列举数据，要做推理——分析 WHY：
- 我的核心驱动力是什么？
- 我的恐惧和不安全感是什么？
- 我的矛盾面背后的心理逻辑是什么？
- 用一段话描述"我的灵魂"

${dataPoints.join('\n')}`,
      (output: string) => {
        if (!output || output.length < 30) return
        personModel.identity = output.slice(0, 500)
        personModel.thinkingStyle = '' // will be filled by next analysis
        debouncedSave(PERSON_MODEL_PATH, personModel)
        console.log(`[cc-soul][person-model] LLM deep synthesis: ${output.slice(0, 60)}...`)
      }, 25000
    )

    // Separately analyze thinking style
    spawnCLI(
      `根据这些消息，用一句话概括这个人的思维方式（直觉型/分析型/情感驱动/结果导向等，不要列举，一句话）：
${recentMsgs.slice(-8).map(m => `"${m.slice(0, 60)}"`).join('\n')}`,
      (output: string) => {
        if (!output || output.length < 5) return
        personModel.thinkingStyle = output.slice(0, 100)
        debouncedSave(PERSON_MODEL_PATH, personModel)
        console.log(`[cc-soul][person-model] thinking style: ${output.slice(0, 60)}`)
      }, 15000
    )
  }
}

/**
 * Get person model context for augment injection.
 */
export function getPersonModelContext(): string | null {
  if (personModel.distillCount === 0) return null

  const parts: string[] = ['[人格模型]']
  if (personModel.values.length > 0) {
    parts.push(`价值观: ${personModel.values.slice(-3).join('、')}`)
  }
  if (personModel.beliefs.length > 0) {
    parts.push(`信念: ${personModel.beliefs.slice(-2).join('、')}`)
  }
  if (personModel.contradictions.length > 0) {
    parts.push(`矛盾面: ${personModel.contradictions[0]}`)
  }
  const decoderEntries = Object.entries(personModel.communicationDecoder).slice(0, 3)
  if (decoderEntries.length > 0) {
    parts.push(`沟通密码: ${decoderEntries.map(([k, v]) => `"${k}"=${v}`).join('、')}`)
  }

  // Reasoning profile
  const rp = personModel.reasoningProfile
  if (rp && rp._counts?.total >= 10) {
    const labels: string[] = []
    if (rp.style !== 'unknown') labels.push(rp.style === 'conclusion_first' ? '结论先行' : '递进推理')
    if (rp.evidence !== 'unknown') labels.push(rp.evidence === 'data' ? '偏好数据论证' : rp.evidence === 'analogy' ? '偏好类比' : '数据+类比混合')
    if (rp.certainty !== 'unknown') labels.push(rp.certainty === 'assertive' ? '表达确定' : rp.certainty === 'hedging' ? '表达谨慎' : '确定/谨慎混合')
    if (rp.disagreement !== 'unknown') labels.push(rp.disagreement === 'dig_in' ? '分歧时坚持己见' : rp.disagreement === 'compromise' ? '分歧时倾向妥协' : '分歧时追问原因')
    if (labels.length > 0) parts.push(`推理风格: ${labels.join('、')}`)
  }

  if (parts.length <= 1) return null
  return parts.join(' | ') + ' — 用这些理解来调整回复方式'
}

/**
 * Unified user understanding context.
 * Merges: person model (rule-based) + distill mental model (LLM-synthesized) + topic context.
 * handler-augments.ts should call THIS instead of three separate functions.
 */
export function getUnifiedUserContext(msg: string, userId?: string): string | null {
  const sections: string[] = []

  // Layer 3: LLM-synthesized mental model (from distill.ts)
  const mentalModel = buildMentalModelAugment(userId)
  if (mentalModel) sections.push(mentalModel.slice(0, 200))

  // Person model: rule-based personality distillation
  const pmCtx = getPersonModelContext()
  if (pmCtx) sections.push(pmCtx)

  // Layer 2: topic-relevant context for current message
  const topicCtx = buildTopicAugment(msg, userId)
  if (topicCtx) sections.push(topicCtx)

  if (sections.length === 0) return null
  return '[用户理解]\n' + sections.join('\n')
}
