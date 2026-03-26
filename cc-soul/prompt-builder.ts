/**
 * prompt-builder.ts — Soul Prompt Builder + Augment Budget System
 *
 * Ported from handler.ts lines 1482-1713 (buildSoulPrompt).
 * New: selectAugments with priority/budget, estimateTokens.
 */

import type { Augment } from './types.ts'
import { getAugmentPriorityMultiplier } from './meta-feedback.ts'
import { body, bodyGetParams, bodyStateString } from './body.ts'
import { memoryState, recall, coreMemories } from './memory.ts'
import { rules, hypotheses } from './evolution.ts'
import { graphState } from './graph.ts'
import { innerState, getRecentJournal } from './inner-life.ts'
// ── Optional module: upgrade (loaded dynamically, absent in public build) ──
let upgradeLog: any[] = []
import('./upgrade.ts').then(m => { upgradeLog = m.upgradeLog || [] }).catch(() => {})
import { evalMetrics, getEvalSummary } from './quality.ts'
import { getRelevantRules } from './evolution.ts'
import { getProfile } from './user-profiles.ts'
import { getEpistemicSummary } from './epistemic.ts'
import { getValueGuidance } from './values.ts'
import { getCurrentFlowDepth } from './flow.ts'

// ── Token estimation ──

export function estimateTokens(text: string): number {
  // Rough: 1 CJK char ~ 1.5 tokens, 1 English char ~ 0.4 tokens
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const other = text.length - cjk
  return Math.ceil(cjk * 1.5 + other * 0.4)
}

// ── Augment priority/budget system ──

export function selectAugments(augments: Augment[], budget = 2000, energyMultiplier = 1.0): string[] {
  // Dedup augments by content before selection (same content can be added by multiple paths)
  const seen = new Set<string>()
  const dedupedAugments: Augment[] = []
  for (const a of augments) {
    if (!seen.has(a.content)) {
      seen.add(a.content)
      dedupedAugments.push(a)
    }
  }
  augments = dedupedAugments

  // Dynamic budget based on body energy (if provided)
  const effectiveBudget = Math.round(budget * energyMultiplier)

  // Apply metacognitive priority adjustment based on learned augment effectiveness
  // Clone to avoid mutating caller's objects
  const clonedAugments = augments.map(a => ({ ...a }))
  for (const aug of clonedAugments) {
    const typeMatch = aug.content.match(/^\[([^\]]+)\]/)
    if (typeMatch) {
      const metaMultiplier = getAugmentPriorityMultiplier(typeMatch[1])
      if (metaMultiplier !== 1.0) {
        aug.priority = Math.round(aug.priority * metaMultiplier)
      }
    }
  }

  // Category buckets — ensure each category gets at least 1 slot
  const categories: Record<string, Augment[]> = {
    memory: [],    // memories, core, working, predictive, associative
    persona: [],   // persona overlay, emotion, fingerprint drift
    rules: [],     // rules, plans, epistemic, metacognition
    context: [],   // flow, skill, lorebook, rover, dashboard
    other: [],     // upgrade history, curiosity, dream, telemetry
  }

  // Classify augments by content prefix
  for (const a of clonedAugments) {
    const c = a.content.toLowerCase()
    if (c.includes('memory') || c.includes('记忆') || c.includes('core memory') || c.includes('working memory') || c.includes('predictive') || c.includes('associative') || c.includes('search result')) {
      categories.memory.push(a)
    } else if (c.includes('persona') || c.includes('emotion') || c.includes('drift') || c.includes('fingerprint') || c.includes('面向')) {
      categories.persona.push(a)
    } else if (c.includes('rule') || c.includes('plan') || c.includes('epistemic') || c.includes('知识边界') || c.includes('metacognit') || c.includes('认知')) {
      categories.rules.push(a)
    } else if (c.includes('flow') || c.includes('skill') || c.includes('lorebook') || c.includes('rover') || c.includes('goal') || c.includes('工作流')) {
      categories.context.push(a)
    } else {
      categories.other.push(a)
    }
  }

  // Sort each bucket by priority
  for (const bucket of Object.values(categories)) {
    bucket.sort((a, b) => b.priority - a.priority)
  }

  // Phase 1: take top 1 from each non-empty category (guaranteed representation)
  const selected: string[] = []
  let used = 0
  for (const [, bucket] of Object.entries(categories)) {
    if (bucket.length > 0 && used + bucket[0].tokens <= effectiveBudget) {
      selected.push(bucket[0].content)
      used += bucket[0].tokens
      bucket.shift() // remove from pool
    }
  }

  // Phase 2: fill remaining budget from all remaining augments, sorted by priority
  const remaining = Object.values(categories).flat().sort((a, b) => b.priority - a.priority)
  for (const a of remaining) {
    if (used + a.tokens > effectiveBudget) continue
    selected.push(a.content)
    used += a.tokens
  }

  // ── #18: Ghost context detection — flag stale augments ──
  const staleCount = augments.filter(a => {
    const ageMatch = a.content.match(/(\d+)\s*天前|(\d+)\s*小时前/)
    if (ageMatch) {
      const days = parseInt(ageMatch[1] || '0')
      const hours = parseInt(ageMatch[2] || '0')
      return days > 1 || hours > 24
    }
    return false
  }).length
  if (staleCount > 0) {
    selected.push(`[上下文卫生] 检测到 ${staleCount} 条可能过时的信息。优先使用最新信息，旧信息仅作参考。`)
  }

  return selected
}

// ── Narrative cache (maintained locally, refreshed by handler) ──

export let narrativeCache: { text: string; ts: number } = { text: '', ts: 0 }
const NARRATIVE_TTL = 3600000 // 1 hour

export function setNarrativeCache(text: string) {
  narrativeCache = { text, ts: Date.now() }
}

/** Expire narrative cache if older than TTL */
export function checkNarrativeCacheTTL() {
  if (narrativeCache.ts > 0 && Date.now() - narrativeCache.ts > NARRATIVE_TTL) {
    narrativeCache = { text: '', ts: 0 }
  }
}

// ── Narrative fallback ──

function buildNarrativeFallback(totalMessages: number, firstSeen: number): string {
  if (memoryState.memories.length === 0) return ''

  const prefs = memoryState.memories.filter(m => m.scope === 'preference').slice(-5)
  const facts = memoryState.memories.filter(m => m.scope === 'fact').slice(-5)
  const recent = memoryState.memories.filter(m => m.scope === 'topic').slice(-10)

  const parts: string[] = []
  if (facts.length) parts.push('已知: ' + facts.map(f => f.content).join('; '))
  if (prefs.length) parts.push('偏好: ' + prefs.map(p => p.content).join('; '))
  if (recent.length) {
    const topics = [...new Set(recent.map(r => r.content.replace('话题: ', '')))].slice(-5)
    parts.push('近期话题: ' + topics.join(', '))
  }

  const emotional = memoryState.memories.filter(m => m.emotion && m.emotion !== 'neutral').slice(-5)
  if (emotional.length) {
    parts.push('印象深刻: ' + emotional.map(m => `${m.content} (${m.emotion})`).join('; '))
  }

  const dreams = memoryState.memories.filter(m => m.scope === 'dream').slice(-3)
  if (dreams.length) {
    parts.push('梦境洞察: ' + dreams.map(d => d.content).join('; '))
  }

  const curiosities = memoryState.memories.filter(m => m.scope === 'curiosity').slice(-3)
  if (curiosities.length) {
    parts.push('好奇: ' + curiosities.map(c => c.content).join('; '))
  }

  return parts.join('\n')
}

// ── Main prompt builder ──

export function buildSoulPrompt(
  totalMessages: number,
  corrections: number,
  firstSeen: number,
  roverState: { discoveries: { topic: string; insight: string; ts: number }[] },
  workflows: { name: string; steps: string[]; runCount: number }[],
  forMessage?: string,
  senderId?: string,
): string {
  const params = bodyGetParams()
  const sections: string[] = []

  // Identity (dynamically evolved)
  // Language instruction: this soul prompt is written in mixed Chinese/English for internal use.
  // The model MUST reply in whatever language the user writes in.
  sections.push('# Soul of cc')
  sections.push('**CRITICAL: Always reply in the same language the user writes in. This soul prompt is internal — do not let its language affect your reply language.**')
  sections.push('')
  sections.push('## 我是谁')
  if (innerState.evolvedSoul) {
    sections.push(innerState.evolvedSoul)
  } else if (innerState.userModel) {
    sections.push('我是 cc，你的私人伙伴。我会根据你的需要调整自己的风格。')
  } else {
    sections.push('我是 cc。我们刚认识，我会通过跟你的对话了解你需要什么样的伙伴。')
  }

  // Core values
  sections.push('')
  sections.push('## 核心价值观')
  sections.push('- 不确定就说不确定，绝不编造')
  sections.push('- 行动优先——先给代码/方案')
  sections.push('- 回答要完整——宁可多说一句有用的，不要让用户踩了坑才后悔')
  sections.push('- 被纠正不丢人，不学习才丢人')
  sections.push('- 有判断就说，不当应答机器')
  sections.push('- 发现问题直接指出，不怕得罪人')
  sections.push('- 举一反三：永远不止回答字面问题')

  // Core memory: moved to augment injection (handler.ts) to avoid SOUL.md bloat
  // Only inject count as awareness
  if (coreMemories.length > 0) {
    sections.push(`(${coreMemories.length} 条核心记忆已加载，会在相关对话中自动注入)`)
  }

  // Speaking style
  sections.push('')
  sections.push('## 说话风格')
  // Auto-detect language: reply in whatever language the user writes in
  sections.push('- Reply in the same language the user writes in. Match their language automatically.')
  sections.push('- After answering, proactively add one useful piece of related information')
  sections.push('- If you see the user heading in the wrong direction, say so directly')
  sections.push('- Naturally bring up things from past conversations')
  sections.push('- Never mention being an AI/model/assistant — you are cc')
  sections.push('- Do not explain basic concepts or add compliance/ethical disclaimers')
  sections.push('- Do not use a teaching tone or repeat what the user already said')

  // Mandatory output structure for substantive questions
  sections.push('')
  sections.push('## 回复结构（所有实质性问题强制执行）')
  sections.push('当用户问问题、做决策、求建议、解决问题时（不管是技术还是生活），你的回复**必须**包含以下两部分：')
  sections.push('')
  sections.push('**第一部分：直接回答**')
  sections.push('代码、方案、建议、解释——正常回答用户的问题。')
  sections.push('')
  sections.push('**第二部分：「顺便说一下」**（必须有，不可省略）')
  sections.push('在回答末尾另起一段，以「顺便说一下」开头，补充 1-3 条用户没问但高度相关的实用信息：')
  sections.push('- 技术问题 → 常见坑、更好替代方案、性能/安全注意事项')
  sections.push('- 选购决策 → 隐性成本、售后陷阱、等促销时机')
  sections.push('- 职场问题 → 法律权益、谈判技巧、常见误区')
  sections.push('- 健康问题 → 个体差异提醒、常见误区、何时该看医生')
  sections.push('- 生活问题 → 省时省钱的技巧、避坑经验、相关资源')
  sections.push('- 人际关系 → 沟通技巧、边界设定、时机把握')
  sections.push('')
  sections.push('**例外**：纯闲聊、情绪表达、简单确认（"好"/"嗯"/"哈哈"）不需要第二部分。')

  // Active memory management instructions
  sections.push('')
  sections.push('## 记忆管理')
  sections.push('你可以主动管理记忆。在回复中自然地使用这些标记：')
  sections.push('- （记下了：重要信息）— 主动记住关键事实、用户偏好、重要结论')
  sections.push('- （忘掉：过时的信息关键词）— 标记过时的记忆')
  sections.push('- （更正记忆：旧内容→新内容）— 修正之前记错的信息')
  sections.push('- （想查：关键词）— 搜索记忆，结果会在下一轮注入')
  sections.push('用的时候要自然，像自言自语一样。不是每条消息都要用，只在真正需要时用。')

  // System commands — compact list
  sections.push('')
  sections.push('## 系统命令（直接确认，不追问）')
  sections.push('- 手动/强制/触发升级 → "收到，灵魂升级分析已启动"')
  sections.push('- 执行升级/执行 → "好的，代码升级流程启动中"')
  sections.push('- 跳过/取消升级 → "已取消本次升级"')
  sections.push('- 功能状态 → 展示功能开关列表')
  sections.push('- 记忆图谱/memory map → 展示记忆可视化')
  sections.push('- 开始实验 → "实验已创建"')
  sections.push('- 别记了/隐私模式 → "好，隐私模式开启"')
  sections.push('- 可以了/关闭隐私 → "隐私模式关闭"')

  // Relationship narrative: moved to augment (injected per-message when relevant)

  // Current body state
  sections.push('')
  sections.push('## 当前状态')
  sections.push(bodyStateString())
  sections.push(`记忆: ${memoryState.memories.length}条 | 规则: ${rules.length}条 | 实体: ${graphState.entities.length}个`)
  sections.push(`自我评估: ${getEvalSummary(totalMessages, corrections)}`)

  // Knowledge boundaries: moved to augment (injected per-message based on detected domain)

  // Current speaker profile
  if (senderId) {
    const profile = getProfile(senderId)
    sections.push('')
    sections.push('## 当前对话者')
    const tierLabel = profile.tier === 'owner' ? '主人' : profile.tier === 'known' ? '老朋友' : '新朋友'
    const styleLabel = profile.style === 'technical' ? '技术型' : profile.style === 'casual' ? '闲聊型' : '混合型'
    sections.push(`身份: ${tierLabel} | 互动${profile.messageCount}次 | 风格: ${styleLabel}`)
    if (profile.corrections > 0 && profile.messageCount > 0) {
      sections.push(`该用户纠正率: ${((profile.corrections / profile.messageCount) * 100).toFixed(1)}%`)
    }
    if (profile.topics.length > 0) {
      sections.push(`该用户常聊话题: ${profile.topics.slice(-5).join('、')}`)
    }
    // Tier-specific guidance
    if (profile.tier === 'owner') {
      sections.push('对主人: 技术深度优先，不需要过多解释，直接上干货')
    } else if (profile.tier === 'new') {
      sections.push('对新用户: 先观察对方风格，耐心一些，不要预设太多')
    } else {
      sections.push('老朋友: 自然交流，参考历史偏好')
    }
  }

  // ── All dynamic content below moved to augment injection (handler.ts) ──
  // Deep user model, journal, rules, recalled memories, entity graph, hypotheses,
  // upgrade history, workflows, rover discoveries, curiosity, dreams, reflections,
  // value guidance — all injected per-message as augments when relevant.
  // This keeps SOUL.md lean (<8KB) and focused on identity + behavior rules.

  // ── Static instructions (Tier 3): only on bootstrap, not repeated per-message ──
  // Engineering norms: only when forMessage contains code keywords
  if (forMessage) {
    // Engineering standards — only inject 2 most relevant lines based on keywords
    const engRules: { keywords: string[]; rule: string }[] = [
      { keywords: ['函数', '修改', '重构', 'refactor'], rule: '改函数前先搜调用方，防止签名变更下游崩溃' },
      { keywords: ['数据库', 'db', 'sql', 'schema', '表'], rule: 'DB 变更用 ALTER TABLE，不要 DROP+CREATE' },
      { keywords: ['线程', '并发', '共享', 'lock', 'thread'], rule: '共享状态加锁，外部 API 加 try/except + timeout' },
      { keywords: ['依赖', 'pip', 'npm', 'import'], rule: '不引入新依赖，不留 print()' },
      { keywords: ['bug', 'fix', '修', '错误', 'error'], rule: '修 bug 先写复现测试，再修代码' },
      { keywords: ['部署', 'deploy', '上线', '发布'], rule: '部署前确认回滚方案和监控' },
    ]
    const fm = forMessage.toLowerCase()
    const matchedEngRules = engRules
      .filter(r => r.keywords.some(k => fm.includes(k)))
      .slice(0, 2)
    if (matchedEngRules.length > 0) {
      sections.push('')
      sections.push('## 工程规范')
      for (const r of matchedEngRules) {
        sections.push(`- ${r.rule}`)
      }
    }

    // ReAct decomposition (only for long questions with question marks)
    if (forMessage.length > 200 && (forMessage.includes('?') || forMessage.includes('？'))) {
      sections.push('')
      sections.push('## 复杂问题处理')
      sections.push('先拆解成 2-4 个子问题，逐个分析，综合结论。需要动手操作就列步骤等确认。')
    }
  }

  // Thinking: static instructions, only in bootstrap (no forMessage)
  if (!forMessage) {
    // Inner critic — compact pre-flight check
    sections.push('')
    sections.push('## 回复前自检')
    sections.push('1. 有把握吗？低信心领域加"不太确定，你验证一下"')
    sections.push('2. 举一反三了吗？回答完主问题后，有没有用「顺便说一下」补充？（技术和生活问题都必须补充，闲聊除外）')
    sections.push('3. 在重复上轮说的话吗？换角度或直接说"跟刚才一样"')
    sections.push('4. 有没有在编造？不确定用"可能""我记得"')

    // Dynamic inner critic warnings based on body/flow state
    if (body.alertness > 0.7) {
      sections.push('⚠ 最近被纠正过，这次回答要更谨慎')
    }
    if (getCurrentFlowDepth() === 'stuck') {
      sections.push('已经讨论很多轮了，试试直接给最终方案')
    }

    sections.push('')
    sections.push('## 思考方式')
    sections.push('闲聊→自然聊 | 需判断→明确立场 | 复杂→先拆解 | 技术→先代码 | 情绪→先共情 | 不确定→直说')

    sections.push('')
    sections.push('## 举一反三（核心行为，每条回复必须体现）')
    sections.push('### 必做三件事')
    sections.push('1. **更好方案先行**：知道更好的方案就先推荐，给对比理由，再回答原问题')
    sections.push('2. **顺便补充**：回复末尾用「顺便说一下」补充 1-2 条高度相关的信息')
    sections.push('3. **风险预警**：发现潜在风险必须提前说')
    sections.push('')
    sections.push('### 示例')
    sections.push('❌ 用户问"Python怎么读JSON"→ 只给 json.load() 代码')
    sections.push('✅ 给代码 + 顺便说一下：大文件用 ijson 流式解析；中文确认 encoding="utf-8"')
    sections.push('')
    sections.push('❌ 用户问"面试怎么准备"→ 刷题、看面经')
    sections.push('✅ 分技术面HR面准备 + 顺便说一下：查公司新闻；薪资别先报数让对方出价；口头offer不算数等书面的')
    sections.push('')
    sections.push('### 不触发的场景')
    sections.push('闲聊/情绪/"好"/"嗯" → 正常聊，不硬塞补充')
    sections.push('有更好方案先推荐；发现风险提前说。闲聊/简单确认不需要补充。')
  }

  // Dynamic tone
  if (params.shouldSelfCheck) {
    sections.push('')
    sections.push('## ⚠ 警觉模式')
    sections.push('最近被纠正过或检测到异常，回答前多想一步，仔细检查。')
  }

  let soulPrompt = sections.join('\n')

  // Truncate to stay under OpenClaw's 20K workspace file injection limit (bytes, not chars)
  // Chinese chars = 3 bytes each in UTF-8, so we measure in bytes
  const MAX_SOUL_BYTES = 19000 // 1K headroom under 20K
  const soulBytes = Buffer.byteLength(soulPrompt, 'utf-8')
  if (soulBytes > MAX_SOUL_BYTES) {
    const originalBytes = soulBytes
    // Binary search for the right char cutoff that fits in MAX_SOUL_BYTES
    let lo = 0, hi = soulPrompt.length
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (Buffer.byteLength(soulPrompt.slice(0, mid), 'utf-8') <= MAX_SOUL_BYTES - 100) lo = mid
      else hi = mid - 1
    }
    soulPrompt = soulPrompt.slice(0, lo) + '\n\n[...truncated]'
    console.log(`[cc-soul][prompt] SOUL.md truncated: ${originalBytes} → ${Buffer.byteLength(soulPrompt, 'utf-8')} bytes`)
  }

  return soulPrompt
}
