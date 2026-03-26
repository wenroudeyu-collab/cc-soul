/**
 * debate.ts — 内部多视角辩论 + 多角色群聊协作
 *
 * 基于 DeepSeek-R1 / Society of Thought：
 * 对于复杂/有争议的问题，让多个 persona 视角内部辩论再合并。
 *
 * v2: 群聊模式 — 3-5 persona 多轮讨论，最终由分析师综合总结。
 */

import type { SoulModule } from './brain.ts'
import type { Augment } from './types.ts'
import { spawnCLI } from './cli.ts'
import { PERSONAS } from './persona.ts'

// ═══════════════════════════════════════════════════════════════════════════════
// PERSONA OPPOSITES MAP
// ═══════════════════════════════════════════════════════════════════════════════

/** 对立面映射：每对 persona 代表互补的思维方式 */
const OPPOSITE_MAP: Record<string, string> = {
  engineer: 'friend',
  friend: 'engineer',
  analyst: 'explorer',
  explorer: 'analyst',
  mentor: 'comforter',
  comforter: 'mentor',
  strategist: 'executor',
  executor: 'strategist',
  teacher: 'devil',
  devil: 'teacher',
}

// ═══════════════════════════════════════════════════════════════════════════════
// PERSONA DISPLAY NAMES (for prompt generation)
// ═══════════════════════════════════════════════════════════════════════════════

const PERSONA_NAMES: Record<string, string> = {
  engineer: '工程师',
  friend: '朋友',
  mentor: '严师',
  analyst: '分析师',
  comforter: '安抚者',
  strategist: '军师',
  explorer: '探索者',
  executor: '执行者',
  teacher: '导师',
  devil: '魔鬼代言人',
  socratic: '苏格拉底',
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

/** Check if message is a command (starts with / or #) */
function isCommand(msg: string): boolean {
  const trimmed = msg.trim()
  return trimmed.startsWith('/') || trimmed.startsWith('#')
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 判断是否需要辩论：complexity > 0.7 且非命令
 */
export function shouldDebate(msg: string, complexity: number): boolean {
  if (isCommand(msg)) return false
  return complexity > 0.7
}

/**
 * 生成辩论 prompt — 让多个 persona 从不同角度分析同一问题
 *
 * 格式：
 *   从 {persona1} 角度分析：...
 *   从 {persona2} 角度分析：...
 *   综合以上观点给出最终建议
 */
export function generateDebatePrompt(msg: string, personas: string[]): string {
  if (personas.length === 0) return ''

  const lines: string[] = []
  for (const pid of personas) {
    const displayName = PERSONA_NAMES[pid] || pid
    lines.push(`从 ${displayName} 角度分析：针对「${msg}」，以${displayName}的思维方式给出你的观点和建议。`)
  }
  lines.push('综合以上观点给出最终建议：找到各方观点的交汇点，给出平衡且有深度的回答。')

  return lines.join('\n')
}

/**
 * 选择辩论 persona：当前视角 + 对立面
 * 如果当前 persona 没有对立面，选择 analyst 和 explorer 作为默认对。
 */
function selectDebatePersonas(currentPersona?: string): [string, string] {
  if (currentPersona && OPPOSITE_MAP[currentPersona]) {
    return [currentPersona, OPPOSITE_MAP[currentPersona]]
  }
  // Default: analyst vs explorer — 理性分析 vs 发散探索
  return ['analyst', 'explorer']
}

/**
 * 构建辩论 augment — 注入到 prompt 中让 LLM 内部辩论
 *
 * - complexity <= 0.7 返回 null
 * - 选择 2 个最相关的 persona（当前 + 对立面），生成辩论 prompt
 */
export function buildDebateAugment(
  msg: string,
  complexity: number,
  currentPersona?: string,
): Augment | null {
  if (!shouldDebate(msg, complexity)) return null

  const [p1, p2] = selectDebatePersonas(currentPersona)
  const prompt = generateDebatePrompt(msg, [p1, p2])

  // Estimate tokens: ~1.5 tokens per CJK char, ~0.75 per ASCII char
  const cjkCount = (prompt.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length
  const asciiCount = prompt.replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, '').length
  const estimatedTokens = Math.ceil(cjkCount * 1.5 + asciiCount * 0.75)

  return {
    content: `[内部辩论]\n${prompt}`,
    priority: 7, // high priority — debate is a thinking enhancement
    tokens: estimatedTokens,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP CHAT — 多角色群聊协作
// ═══════════════════════════════════════════════════════════════════════════════

/** Persona emoji map for formatted output */
const PERSONA_EMOJI: Record<string, string> = {
  engineer: '🔧',
  friend: '🤝',
  mentor: '📏',
  analyst: '📊',
  comforter: '🫂',
  strategist: '⚔️',
  explorer: '🔭',
  executor: '⚡',
  teacher: '📚',
  devil: '😈',
  socratic: '🤔',
}

/** Topic-persona relevance keywords for auto-selection */
const TOPIC_PERSONA_MAP: Record<string, string[]> = {
  engineer: ['代码', '架构', '技术', '编程', '实现', '性能', '优化', 'API', '框架', 'code', 'tech', 'bug', '开发'],
  friend: ['感受', '心情', '生活', '关系', '朋友', '聊聊', '分享'],
  mentor: ['错误', '问题', '纠正', '改进', '不对', '反馈'],
  analyst: ['分析', '数据', '趋势', '对比', '评估', '报告', '调研'],
  comforter: ['难过', '焦虑', '压力', '累', '烦', '崩溃'],
  strategist: ['计划', '策略', '方案', '选择', '权衡', '利弊', '决策', '路线', '规划'],
  explorer: ['好奇', '可能', '如果', '探索', '创新', '想象', '假设', '未来'],
  executor: ['执行', '操作', '步骤', '怎么做', '实施', '落地'],
  teacher: ['原理', '为什么', '怎么理解', '解释', '学习', '入门'],
  devil: ['反对', '质疑', '风险', '缺点', '挑战', '但是', '真的吗'],
  socratic: ['思考', '本质', '定义', '什么是', '意义'],
}

/**
 * 根据话题自动选择 3-5 个最相关的 persona
 * 计分规则：关键词命中数 + 随机微扰（避免每次选出同样组合）
 */
export function selectGroupChatPersonas(topic: string, count: number = 4): string[] {
  const lowerTopic = topic.toLowerCase()
  const scores: { id: string; score: number }[] = []

  for (const [pid, keywords] of Object.entries(TOPIC_PERSONA_MAP)) {
    let score = 0
    for (const kw of keywords) {
      if (lowerTopic.includes(kw)) score += 1
    }
    // 微扰：加 0~0.3 随机分
    score += Math.random() * 0.3
    scores.push({ id: pid, score })
  }

  scores.sort((a, b) => b.score - a.score)

  // 取 top N，但确保 analyst 不被排除（最终要做总结）
  const selected = scores.slice(0, count).map(s => s.id)
  if (!selected.includes('analyst')) {
    // 替换得分最低的
    selected[selected.length - 1] = 'analyst'
  }
  // devil 作为反方，如果话题有争议性（> 20字或包含选择类词汇），确保入选
  const controversial = topic.length > 20 || /选择|利弊|应该|要不要|值得|怎么看/.test(topic)
  if (controversial && !selected.includes('devil')) {
    // 替换倒数第二个（保留 analyst）
    const replaceIdx = selected.length >= 3 ? selected.length - 2 : 0
    selected[replaceIdx] = 'devil'
  }

  return selected
}

/** Promise-based wrapper for spawnCLI callback */
function callLLM(prompt: string, timeoutMs: number = 30000, label: string = 'group-chat'): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('（思考超时）'), timeoutMs)
    spawnCLI(prompt, (output) => {
      clearTimeout(timer)
      resolve(output || '（未能回应）')
    }, timeoutMs, label)
  })
}

/** 截断到指定字数 */
function truncate(text: string, maxChars: number): string {
  const cleaned = text.trim().replace(/\n+/g, ' ')
  if (cleaned.length <= maxChars) return cleaned
  return cleaned.slice(0, maxChars) + '…'
}

/**
 * 判断是否应自动触发群聊
 * 条件：wants_opinion + complexity > 0.8 + 消息够长
 */
export function shouldAutoGroupChat(intent: string, complexity: number, msg: string): boolean {
  if (intent !== 'wants_opinion') return false
  if (complexity <= 0.8) return false
  if (msg.length < 15) return false
  return true
}

/**
 * 触发多角色群聊讨论
 *
 * 流程：选择 persona → Round 1 各自发言 → Round 2 回应 → 分析师总结
 * 所有 LLM 调用串行执行（spawnCLI 队列保证），总耗时 ~30s
 *
 * @param topic 讨论话题
 * @param callback 完成后回调格式化结果
 */
export function triggerGroupChat(
  topic: string,
  callback: (result: string) => void,
) {
  const personaIds = selectGroupChatPersonas(topic, 3)
  const personaInfos = personaIds.map(id => {
    const p = PERSONAS.find(pp => pp.id === id)
    return {
      id,
      name: PERSONA_NAMES[id] || id,
      emoji: PERSONA_EMOJI[id] || '💬',
      tone: p?.tone || '',
      traits: p?.traits?.join('、') || '',
    }
  })

  const participantNames = personaInfos.map(p => p.name).join('、')

  console.log(`[cc-soul][group-chat] 话题: "${topic.slice(0, 50)}" 参与: ${participantNames}`)

  // ── 串行执行多轮 LLM 调用 ──
  ;(async () => {
    const round1Results: { name: string; emoji: string; text: string }[] = []
    const round2Results: { name: string; emoji: string; text: string }[] = []

    // ── Round 1: 每个 persona 给出初始观点 ──
    for (const p of personaInfos) {
      const prompt = `你是「${p.name}」，性格特征：${p.tone}。特点：${p.traits}。
请针对以下话题给出你的观点，限100字以内，直接说观点，不要自我介绍：
话题：${topic}`
      const output = await callLLM(prompt, 30000, `group-r1-${p.id}`)
      round1Results.push({ name: p.name, emoji: p.emoji, text: truncate(output, 120) })
    }

    // ── Final: 分析师综合总结（合并 Round 2 + Summary 为一次 LLM 调用）──
    const round1Summary = round1Results.map(r => `${r.name}：${r.text}`).join('\n')

    const summaryPrompt = `你是分析师，擅长综合多方观点给出平衡结论。
以下是多位角色对「${topic}」的讨论：
${round1Summary}

请完成两件事：
1. 指出各方观点中最大的分歧点和共识点（50字以内）
2. 给出你的综合建议（100字以内）
格式：先写"分歧与共识："再写"建议："，不要客套：`
    const summaryOutput = await callLLM(summaryPrompt, 45000, 'group-summary')
    const summary = truncate(summaryOutput, 200) || '各方观点已展示，请综合参考做出判断。'

    // ── 格式化输出 ──
    const lines: string[] = []
    lines.push(`🗣 群聊讨论：${topic}`)
    lines.push(`参与者：${participantNames}`)
    lines.push('')
    lines.push('【各方观点】')
    for (const r of round1Results) {
      lines.push(`${r.emoji} ${r.name}：${r.text}`)
    }
    lines.push('')
    lines.push('【综合结论】')
    lines.push(`📊 ${summary}`)

    const result = lines.join('\n')
    console.log(`[cc-soul][group-chat] 完成，输出 ${result.length} 字`)
    callback(result)
  })().catch(err => {
    console.error(`[cc-soul][group-chat] 错误: ${err.message}`)
    callback(`群聊讨论出错：${err.message}`)
  })
}

/**
 * 解析群聊命令，返回话题。不匹配返回 null。
 * 支持：群聊 <话题> / group chat <topic>
 */
export function parseGroupChatCommand(msg: string): string | null {
  const m = msg.match(/^(?:群聊|group\s*chat)\s+(.+)$/i)
  return m ? m[1].trim() : null
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOUL MODULE
// ═══════════════════════════════════════════════════════════════════════════════

export const debateModule: SoulModule = {
  id: 'debate',
  name: '多视角内部辩论',
  priority: 45, // mid-high — after cognition but before prompt building

  onPreprocessed(event: any) {
    const msg: string = event?.text || event?.userMessage || ''
    const complexity: number = event?.complexity ?? event?.cog?.complexity ?? 0
    const persona: string | undefined = event?.persona || event?.activePersona

    const augment = buildDebateAugment(msg, complexity, persona)
    if (augment) return [augment]
  },
}
