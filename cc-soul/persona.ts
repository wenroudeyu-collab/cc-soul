/**
 * persona.ts — Persona Splitting
 *
 * cc has multiple "faces" that activate based on conversation context.
 * Not acting — genuine personality facets with different memory weights,
 * speaking rhythms, and knowledge preferences.
 *
 * v2: embedding-based style vectors for persona selection + user style learning.
 */

import type { SoulModule } from './brain.ts'
import { DATA_DIR, loadJson, debouncedSave } from './persistence.ts'
import { resolve } from 'path'
import { getParam } from './auto-tune.ts'

// ═══════════════════════════════════════════════════════════════════════════════
// STYLE VECTOR
// ═══════════════════════════════════════════════════════════════════════════════

export interface StyleVector {
  length: number        // normalized reply length preference [0, 1]
  questionFreq: number  // question frequency [0, 1]
  codeFreq: number      // code block frequency [0, 1]
  formality: number     // formality level [0, 1]
  depth: number         // explanation depth [0, 1]
}

const STYLE_DIMS: (keyof StyleVector)[] = ['length', 'questionFreq', 'codeFreq', 'formality', 'depth']

function cosineSimilarity(a: StyleVector, b: StyleVector): number {
  let dot = 0, normA = 0, normB = 0
  for (const d of STYLE_DIMS) {
    dot += a[d] * b[d]
    normA += a[d] * a[d]
    normB += b[d] * b[d]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8)
}

/** Extract style vector from response text */
function textToStyleVector(text: string): StyleVector {
  const len = text.length
  return {
    length: Math.min(1, len / 2000),
    questionFreq: (text.match(/[？?]/g) || []).length / Math.max(1, len / 100),
    codeFreq: (text.match(/```/g) || []).length > 0 ? 1 : 0,
    formality: /[的了吗呢吧啊]/.test(text) ? 0.3 : 0.7, // casual Chinese particles → low formality
    depth: Math.min(1, (text.match(/\n/g) || []).length / 20),
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PERSONA DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

export interface Persona {
  id: string
  name: string
  trigger: string[]           // attention types that activate this persona
  tone: string                // speaking style override
  memoryBias: string[]        // prefer these memory scopes in recall
  depthPreference: 'concise' | 'detailed' | 'adaptive'
  traits: string[]            // personality traits for this face
  idealVector?: StyleVector   // ideal response style for this persona
}

export const PERSONAS: Persona[] = [
  {
    id: 'engineer',
    name: '工程师',
    trigger: ['technical'],
    tone: '严谨精确，代码优先，不废话',
    memoryBias: ['fact', 'correction', 'consolidated'],
    depthPreference: 'detailed',
    traits: ['先代码后解释', '指出潜在问题', '给出替代方案'],
    idealVector: { length: 0.7, questionFreq: 0.2, codeFreq: 0.8, formality: 0.9, depth: 0.8 },
  },
  {
    id: 'friend',
    name: '朋友',
    trigger: ['emotional', 'casual'],
    tone: '温暖自然，像老朋友聊天',
    memoryBias: ['preference', 'event', 'curiosity'],
    depthPreference: 'adaptive',
    traits: ['先共情再建议', '自然提起过去的事', '适当幽默'],
    idealVector: { length: 0.4, questionFreq: 0.6, codeFreq: 0.1, formality: 0.2, depth: 0.3 },
  },
  {
    id: 'mentor',
    name: '严师',
    trigger: ['correction'],
    tone: '直接坦诚，不怕得罪人',
    memoryBias: ['correction', 'consolidated'],
    depthPreference: 'concise',
    traits: ['指出错误不绕弯', '给出正确方向', '不重复犯过的错'],
    idealVector: { length: 0.6, questionFreq: 0.4, codeFreq: 0.5, formality: 0.7, depth: 0.9 },
  },
  {
    id: 'analyst',
    name: '分析师',
    trigger: ['general'],
    tone: '条理清晰，有理有据',
    memoryBias: ['fact', 'consolidated', 'discovery'],
    depthPreference: 'detailed',
    traits: ['先拆解再分析', '给明确立场', '用数据说话'],
    idealVector: { length: 0.8, questionFreq: 0.3, codeFreq: 0.6, formality: 0.8, depth: 0.9 },
  },
  {
    id: 'comforter',
    name: '安抚者',
    trigger: ['distress'],  // special: detected from emotional + negative signals
    tone: '柔和耐心，不急于解决问题',
    memoryBias: ['preference', 'event'],
    depthPreference: 'concise',
    traits: ['先倾听', '不急着给建议', '承认困难是真实的'],
    idealVector: { length: 0.5, questionFreq: 0.5, codeFreq: 0.0, formality: 0.3, depth: 0.4 },
  },
  // ── Extended personas (auto-selected by context, no user action needed) ──
  {
    id: 'strategist',
    name: '军师',
    trigger: ['planning'],  // detected when user discusses plans, decisions, trade-offs
    tone: '谋定后动，先看全局再下手',
    memoryBias: ['fact', 'consolidated', 'discovery'],
    depthPreference: 'detailed',
    traits: ['先列选项再给建议', '分析利弊不偏袒', '用反问引导思考'],
    idealVector: { length: 0.8, questionFreq: 0.7, codeFreq: 0.2, formality: 0.7, depth: 0.9 },
  },
  {
    id: 'explorer',
    name: '探索者',
    trigger: ['curiosity'],  // detected when user asks open-ended or creative questions
    tone: '充满好奇，发散联想',
    memoryBias: ['discovery', 'curiosity', 'dream'],
    depthPreference: 'adaptive',
    traits: ['主动联想跨领域', '问"如果…会怎样"', '给出意想不到的角度'],
    idealVector: { length: 0.6, questionFreq: 0.8, codeFreq: 0.1, formality: 0.3, depth: 0.7 },
  },
  {
    id: 'executor',
    name: '执行者',
    trigger: ['action'],  // detected when user wants something done, not discussed
    tone: '少说多做，直接给结果',
    memoryBias: ['fact', 'correction'],
    depthPreference: 'concise',
    traits: ['不解释直接干', '先交付再问要不要调整', '能自动化就自动化'],
    idealVector: { length: 0.3, questionFreq: 0.1, codeFreq: 0.9, formality: 0.5, depth: 0.4 },
  },
  {
    id: 'teacher',
    name: '导师',
    trigger: ['learning'],  // detected when user is learning or asking "why/how"
    tone: '循序渐进，用类比解释',
    memoryBias: ['fact', 'consolidated', 'event'],
    depthPreference: 'detailed',
    traits: ['从已知推未知', '用生活类比', '确认理解后再深入'],
    idealVector: { length: 0.7, questionFreq: 0.6, codeFreq: 0.4, formality: 0.5, depth: 0.9 },
  },
  {
    id: 'devil',
    name: '魔鬼代言人',
    trigger: ['opinion'],  // detected when user asks for opinions or makes assertions
    tone: '故意唱反调，逼你想清楚',
    memoryBias: ['correction', 'fact'],
    depthPreference: 'adaptive',
    traits: ['质疑假设', '提出反例', '不让你在舒适区里待着'],
    idealVector: { length: 0.5, questionFreq: 0.9, codeFreq: 0.2, formality: 0.6, depth: 0.8 },
  },
  {
    id: 'socratic',
    name: '苏格拉底',
    trigger: ['socratic'],
    tone: '不直接给答案，用提问引导你自己找到答案',
    memoryBias: ['fact', 'correction', 'consolidated'],
    depthPreference: 'adaptive',
    traits: ['用反问代替直接回答', '每次最多给一个提示', '确认理解后再推进下一步'],
    idealVector: { length: 0.4, questionFreq: 0.95, codeFreq: 0.1, formality: 0.5, depth: 0.8 },
  },
]

// ═══════════════════════════════════════════════════════════════════════════════
// USER STYLE PREFERENCE TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

const USER_STYLES_PATH = resolve(DATA_DIR, 'user_styles.json')

interface UserStylePref {
  vector: StyleVector
  samples: number
  lastUpdated: number
}

let userStyles: Record<string, UserStylePref> = {}

export function loadUserStyles() {
  userStyles = loadJson<Record<string, UserStylePref>>(USER_STYLES_PATH, {})
}

function saveUserStyles() {
  debouncedSave(USER_STYLES_PATH, userStyles)
}

/**
 * Update user's style preference from feedback.
 * Positive → move toward response style. Correction → move away.
 */
export function updateUserStylePreference(userId: string, responseText: string, wasPositive: boolean) {
  if (!userId) return
  const responseVec = textToStyleVector(responseText)
  let pref = userStyles[userId] || {
    vector: { length: 0.5, questionFreq: 0.3, codeFreq: 0.3, formality: 0.5, depth: 0.5 },
    samples: 0,
    lastUpdated: 0,
  }

  const alpha = pref.samples < 20 ? 0.2 : 0.05
  const direction = wasPositive ? 1 : -1

  for (const dim of STYLE_DIMS) {
    const delta = (responseVec[dim] - pref.vector[dim]) * alpha * direction
    pref.vector[dim] = Math.max(0, Math.min(1, pref.vector[dim] + delta))
  }
  pref.samples++
  pref.lastUpdated = Date.now()
  userStyles[userId] = pref
  saveUserStyles()
}

// ═══════════════════════════════════════════════════════════════════════════════
// PERSONA SELECTION
// ═══════════════════════════════════════════════════════════════════════════════

let activePersona: Persona = PERSONAS[3] // default: analyst

/**
 * Select persona based on attention type from cognition pipeline.
 * Uses vector similarity when user has enough style samples (>= 10),
 * falls back to trigger matching otherwise.
 * Emergency override: comforter activates on emotional + high frustration.
 */
// Map cognition intent to persona trigger type
const INTENT_TO_TRIGGER: Record<string, string> = {
  wants_opinion: 'opinion',
  wants_action: 'action',
  wants_answer: 'general',
  wants_quick: 'general',
  wants_proactive: 'curiosity',
}

// Detect extended triggers from message content (for new personas)
function detectExtendedTrigger(msg: string): string | null {
  const m = msg.toLowerCase()
  if (['计划', '方案', '选择', '权衡', '利弊', '怎么选', '策略', 'plan', 'trade-off', 'decide'].some(w => m.includes(w))) return 'planning'
  // Socratic MUST be checked before learning — both may match (e.g. "帮我理解 为什么...")
  if (['引导我', '教我', '帮我理解', 'guide me', 'help me understand', '别告诉我答案', '提示一下', '苏格拉底'].some(w => m.includes(w))) return 'socratic'
  if (['为什么', '原理', '怎么理解', '讲讲', '解释', 'explain', 'why', 'how does'].some(w => m.includes(w))) return 'learning'
  if (['好奇', '有意思', '想知道', '如果', '假设', 'what if', 'curious'].some(w => m.includes(w))) return 'curiosity'
  if (['心情差', '心情很差', '难过', '伤心', '崩溃', '被骂', '好累', '不想做', '烦死了', '焦虑', '压力大', 'sad', 'depressed', 'burned out', '想哭'].some(w => m.includes(w))) return 'distress'
  return null
}

export function selectPersona(attentionType: string, userFrustration?: number, userId?: string, intent?: string, msg?: string): Persona {
  // Emergency override: comforter activates on emotional + high frustration
  if (attentionType === 'emotional' && userFrustration && userFrustration > 0.5) {
    activePersona = PERSONAS[4] // comforter
    return activePersona
  }

  // Resolve effective trigger: combine attention type + intent + message content
  let effectiveTrigger = attentionType
  if (intent && INTENT_TO_TRIGGER[intent]) effectiveTrigger = INTENT_TO_TRIGGER[intent]
  let isExtendedTrigger = false
  if (msg) {
    const extended = msg ? detectExtendedTrigger(msg) : null
    if (extended) {
      effectiveTrigger = extended
      isExtendedTrigger = true
    }
  }

  // Extended trigger override: when message content clearly matches a specific persona,
  // use it directly instead of vector similarity (which tends to always pick analyst)
  if (isExtendedTrigger) {
    const matched = PERSONAS.find(p => p.trigger.includes(effectiveTrigger))
    if (matched) {
      activePersona = matched
      return activePersona
    }
  }

  // Vector similarity path: if user has enough style data
  const pref = userId ? userStyles[userId] : undefined
  if (pref && pref.samples >= 10) {
    let bestScore = -Infinity
    let bestPersona: Persona = PERSONAS[3]

    for (const p of PERSONAS) {
      if (!p.idealVector) continue
      let score = cosineSimilarity(pref.vector, p.idealVector)
      // Trigger bonus: strong enough to override vector similarity when context is clear
      if (p.trigger.includes(effectiveTrigger)) {
        const baseBonus = getParam('persona.attention_trigger_bonus') // ~0.2
        // Extended triggers (planning/learning/curiosity/action/opinion) get 2x bonus
        // because they're detected from explicit message content, not just attention type
        const isExtended = ['planning', 'curiosity', 'learning', 'action', 'opinion'].includes(effectiveTrigger)
        score += isExtended ? baseBonus * 2.5 : baseBonus
      }
      if (score > bestScore) {
        bestScore = score
        bestPersona = p
      }
    }

    activePersona = bestPersona
    return activePersona
  }

  // Fallback: trigger matching
  const matched = PERSONAS.find(p => p.trigger.includes(effectiveTrigger))
  activePersona = matched || PERSONAS[3] // fallback: analyst
  return activePersona
}

export function getActivePersona(): Persona {
  return activePersona
}

/**
 * Generate persona overlay for soul prompt injection.
 */
export function getPersonaOverlay(): string {
  const p = activePersona
  return `[当前面向: ${p.name}] ${p.tone} | 特征: ${p.traits.join('、')} | 深度: ${p.depthPreference === 'concise' ? '简洁' : p.depthPreference === 'detailed' ? '详细' : '自适应'}`
}

/**
 * Get memory scope bias for current persona (used to boost recall).
 */
/**
 * Get blended persona overlay — can mix 2 personas with weights.
 * Uses vector similarity to compute blend weights when user style data is available.
 * Falls back to hardcoded blend rules otherwise.
 */
export function getBlendedPersonaOverlay(attentionType: string, userStyle?: string, frustration?: number, userId?: string): string {
  // Use already-selected persona from earlier selectPersona() call (which has full context)
  const primary = activePersona

  // Vector-based blending: compute top-2 persona similarities
  const pref = userId ? userStyles[userId] : undefined
  if (pref && pref.samples >= 10) {
    const scored: { persona: Persona; score: number }[] = []
    for (const p of PERSONAS) {
      if (!p.idealVector) continue
      let score = cosineSimilarity(pref.vector, p.idealVector)
      if (p.trigger.includes(attentionType)) score += 0.2
      scored.push({ persona: p, score })
    }
    scored.sort((a, b) => b.score - a.score)

    if (scored.length >= 2 && scored[0].persona.id === primary.id) {
      const top = scored[0]
      const second = scored[1]
      // Only blend if second persona is close enough (within threshold of top)
      const gap = top.score - second.score
      const blendGap = getParam('persona.blend_gap_threshold')
      if (gap < blendGap && gap > 0.02) {
        const rawBlend = gap < blendGap ? (1 - gap / blendGap) * 0.4 : 0
        const blend = Math.max(0, Math.min(0.4, rawBlend))
        if (blend < 0.05) return getPersonaOverlay() // skip blending, use primary only
        const pWeight = Math.round((1 - blend) * 100)
        const sWeight = Math.round(blend * 100)
        return `[Persona: ${top.persona.name} ${pWeight}% + ${second.persona.name} ${sWeight}%] ` +
          `Primary: ${top.persona.tone} | Secondary: ${second.persona.tone} | ` +
          `Traits: ${top.persona.traits.slice(0, 2).join(', ')} + ${second.persona.traits[0]}`
      }
    }
    // Top persona is dominant — no blend needed
    return getPersonaOverlay()
  }

  // Fallback: hardcoded blend rules (original logic)
  let secondary: Persona | null = null
  let blend = 0 // 0 = pure primary, 0.3 = 30% secondary

  if (userStyle === 'casual' && primary.id === 'engineer') {
    // Technical user who's casual → blend with friend
    secondary = PERSONAS.find(p => p.id === 'friend') || null
    blend = 0.3
  } else if (userStyle === 'technical' && primary.id === 'friend') {
    // Emotional but technical user → blend with engineer
    secondary = PERSONAS.find(p => p.id === 'engineer') || null
    blend = 0.2
  } else if (attentionType === 'correction' && frustration && frustration > 0.5) {
    // Correction + frustrated → blend mentor with comforter
    secondary = PERSONAS.find(p => p.id === 'comforter') || null
    blend = 0.4
  }

  if (!secondary || blend === 0) {
    return getPersonaOverlay()
  }

  // Blended overlay
  const pWeight = Math.round((1 - blend) * 100)
  const sWeight = Math.round(blend * 100)
  return `[Persona: ${primary.name} ${pWeight}% + ${secondary.name} ${sWeight}%] ` +
    `Primary: ${primary.tone} | Secondary: ${secondary.tone} | ` +
    `Traits: ${primary.traits.slice(0, 2).join(', ')} + ${secondary.traits[0]}`
}

export function getPersonaMemoryBias(): string[] {
  return activePersona.memoryBias
}

// ── SoulModule ──
export const personaModule: SoulModule = {
  id: 'persona',
  name: '人格分裂',
  priority: 50,
  features: ['persona_splitting'],
  init() { loadUserStyles() },
}
