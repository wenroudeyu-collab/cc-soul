/**
 * soul-process.ts — Core message processing pipeline
 *
 * Handles POST /process and POST /feedback.
 * Runs the full cc-soul pipeline: cognition → emotion → memory → augments → return.
 * Does NOT call LLM — returns enriched context for customer's AI.
 */

import './persistence.ts' // ensure data dir init

export { handleProcess, handleFeedback }

async function handleProcess(body: any): Promise<any> {
  const message = body.message || ''
  const userId = body.user_id || body.userId || 'default'
  const agentId = body.agent_id || body.agentId || 'default'
  const customPrompt = body.system_prompt || ''

  // Multi-agent isolation: switch data directory if agent_id provided
  if (agentId !== 'default') {
    try { const { setActiveAgent } = await import('./persistence.ts'); setActiveAgent(agentId) } catch {}
  }

  // Bootstrap mode: empty message → return system_prompt only
  if (!message) {
    try {
      const { ensureDataDir } = await import('./persistence.ts')
      ensureDataDir()
      try { (await import('./memory.ts')).ensureSQLiteReady() } catch {}
    } catch {}
    try { (await import('./handler.ts')).initializeSoul() } catch {}
    let soulPrompt = ''
    try {
      const { buildSoulPrompt } = await import('./prompt-builder.ts')
      const { stats } = await import('./handler-state.ts')
      soulPrompt = buildSoulPrompt(stats.totalMessages, stats.corrections, stats.firstSeen, [])
    } catch {}
    return { system_prompt: customPrompt ? customPrompt + '\n\n' + soulPrompt : soulPrompt, augments: [] }
  }

  // ── Command detection: check before full pipeline ──
  try {
    const { routeCommand, routeCommandDirect } = await import('./handler-commands.ts')
    const { getSessionState } = await import('./handler-state.ts')
    const session = getSessionState(userId)
    let cmdReply = ''
    const replyFn = (t: string) => { cmdReply = t }
    const cmdCtx = { bodyForAgent: '', reply: replyFn }

    // Try routeCommand first (sync, handles write commands)
    const handled = routeCommand(message, cmdCtx, session, userId, '', { context: { senderId: userId } })
    if (handled && cmdReply) {
      return { command: true, command_reply: cmdReply }
    }

    // Try routeCommandDirect (async, handles read-only commands like 价值观/审计 etc.)
    if (!cmdReply) {
      const directHandled = await routeCommandDirect(message, { replyCallback: replyFn })
      if (directHandled && cmdReply) {
        return { command: true, command_reply: cmdReply }
      }
    }
  } catch {}

  // Initialize (lazy)
  try {
    (await import('./persistence.ts')).ensureDataDir()
    try { (await import('./memory.ts')).ensureSQLiteReady() } catch {}
  } catch {}
  try { (await import('./handler.ts')).initializeSoul() } catch {}

  // ── 1. Body tick + emotional processing ──
  let moodScore = 0, energyScore = 1, emotion = 'neutral'
  try {
    const bodyMod = await import('./body.ts')
    try { bodyMod.loadBodyState() } catch {}
    bodyMod.bodyTick()
    bodyMod.bodyOnMessage(message.length > 50 ? 0.6 : 0.3)
    // Emotional contagion deferred until after cognition (needs attentionType)
  } catch {}

  // ── 2. Cognition ──
  let cogResult: any = null
  try {
    const { cogProcess } = await import('./cognition.ts')
    cogResult = cogProcess(message, userId)
    if (cogResult.attention === 'correction') {
      try {
        (await import('./user-profiles.ts')).updateProfileOnCorrection(userId)
        ;(await import('./body.ts')).bodyOnCorrection()
      } catch {}
    }
  } catch {}

  // ── 2b. Emotional contagion (now with correct cognition params) ──
  try {
    const bodyMod = await import('./body.ts')
    const attention = cogResult?.attention || 'general'
    const frustration = 0  // will be updated after flow
    bodyMod.processEmotionalContagion(message, attention, frustration, userId)
    moodScore = bodyMod.body.mood; energyScore = bodyMod.body.energy
    emotion = moodScore > 0.3 ? 'positive' : moodScore < -0.3 ? 'negative' : 'neutral'
  } catch {}

  // ── 3. Flow ──
  let flow: any = null
  try { flow = (await import('./flow.ts')).updateFlow(message, '', userId) } catch {}

  // ── 4. User profile ──
  try { (await import('./user-profiles.ts')).updateProfileOnMessage(userId, message) } catch {}

  // ── 5. WAL protocol ──
  try {
    const { isEnabled } = await import('./features.ts')
    if (isEnabled('wal_protocol')) {
      const { addMemory } = await import('./memory.ts')
      const walEntries: string[] = []
      const prefMatch = message.match(/我(?:最|特别|超|很|比较)?(?:喜欢|不喜欢|讨厌|爱|偏好|住在?|是|养了?|有|擅长|从事|叫|在.{1,10}(?:工作|上班|做))(.{2,40})/g)
      if (prefMatch) for (const p of prefMatch.slice(0, 3)) walEntries.push(p.slice(0, 60))
      const rememberMatch = message.match(/(?:记住|帮我记|你要知道)[：:，,\s]*(.{4,60})/g)
      if (rememberMatch) for (const r of rememberMatch.slice(0, 3)) walEntries.push(r.slice(0, 60))
      for (const entry of walEntries) addMemory(`[WAL事实] ${entry}`, 'wal', userId, 'private')
      if (walEntries.length > 0) console.log(`[cc-soul][api] WAL: ${walEntries.length} entries`)
    }
  } catch {}

  // ── 6. Avatar collection ──
  try { (await import('./avatar.ts')).collectAvatarData(message, '', userId) } catch {}

  // ── 7. Proactive hints ──
  try {
    const { generateProactiveItems } = await import('./soul-proactive.ts')
    const hints = await generateProactiveItems()
    if (hints.length > 0) {
      const { addWorkingMemory } = await import('./memory.ts')
      addWorkingMemory(`[自动洞察]\n${hints.map(h => h.message).join('\n')}`, userId)
    }
  } catch {}

  // ── 7b. Duplicate message detection (read fresh from disk, not cached) ──
  let dupHint = ''
  try {
    const { resolve } = await import('path')
    const { readFileSync, writeFileSync, existsSync } = await import('fs')
    const { DATA_DIR } = await import('./persistence.ts')
    const DEDUP_PATH = resolve(DATA_DIR, 'recent_replies.json')
    let dedup: Record<string, { reply: string; ts: number }> = {}
    try { if (existsSync(DEDUP_PATH)) dedup = JSON.parse(readFileSync(DEDUP_PATH, 'utf-8')) } catch {}
    const dedupKey = message.slice(0, 100).toLowerCase().trim()
    const prev = dedup[dedupKey]
    if (prev && Date.now() - prev.ts < 3600000) {
      const replyHint = prev.reply ? `上次的回复摘要："${prev.reply.slice(0, 100)}"。` : ''
      dupHint = `[重要] 用户发了和之前一样的消息："${message.slice(0, 50)}"。${replyHint}不要重复上次的回答，换个角度或说"这个刚说过，还有什么不清楚的？"。`
    }
    // Only write if no existing entry (don't overwrite reply from feedback)
    if (!dedup[dedupKey]) {
      dedup[dedupKey] = { reply: '', ts: Date.now() }
    } else {
      dedup[dedupKey].ts = Date.now()  // update timestamp but preserve reply
    }
    for (const [k, v] of Object.entries(dedup)) { if (Date.now() - v.ts > 3600000) delete dedup[k] }
    writeFileSync(DEDUP_PATH, JSON.stringify(dedup, null, 2), 'utf-8')
  } catch {}

  // ── 8. Build augments ──
  // 注：激活场召回已内置于 recall()，buildAndSelectAugments 会自动调用，无需在此单独调用
  let selected: string[] = []
  let augmentObjects: any[] = []
  let recalled: any[] = []
  try {
    const { buildAndSelectAugments } = await import('./handler-augments.ts')
    const { getSessionState } = await import('./handler-state.ts')
    const session = getSessionState(userId)
    session.lastPrompt = message
    session.lastSenderId = userId

    const result = await buildAndSelectAugments({
      userMsg: message, session, senderId: userId, channelId: '',
      cog: cogResult || { attention: 'general', intent: 'wants_answer', strategy: 'balanced', complexity: 0.3, hints: [] },
      flow: flow || { turnCount: 0, frustration: 0 },
      flowKey: userId, followUpHints: [], workingMemKey: userId,
    })
    selected = result.selected || []
    // 注入重复消息检测提醒
    if (dupHint) selected.unshift(`[重复消息检测] ${dupHint}`)
    augmentObjects = (result.augments || []).map((a: any) => ({
      content: a.content || '', priority: a.priority || 0, tokens: a.tokens || 0,
    }))
    recalled = (result.augments || [])
      .filter((a: any) => a.content?.includes('记忆') || a.content?.includes('recall'))
      .map((a: any) => ({ content: a.content, scope: 'recalled' }))
  } catch (e: any) {
    console.log(`[cc-soul][api] augment build error: ${e.message}`)
  }

  // ── 9. Soul prompt ──
  let soulPrompt = ''
  try {
    const { buildSoulPrompt } = await import('./prompt-builder.ts')
    const { stats } = await import('./handler-state.ts')
    soulPrompt = buildSoulPrompt(stats.totalMessages, stats.corrections, stats.firstSeen, [])
  } catch {}

  // 始终把上次回复摘要和去重提醒嵌入 system_prompt（不依赖 SOUL.md 写入时序）
  try {
    const { resolve } = await import('path')
    const { DATA_DIR, loadJson } = await import('./persistence.ts')
    const DEDUP_PATH = resolve(DATA_DIR, 'recent_replies.json')
    const dedup: Record<string, { reply: string; ts: number }> = loadJson(DEDUP_PATH, {})
    const dedupKey = message.slice(0, 100).toLowerCase().trim()
    const prev = dedup[dedupKey]
    if (prev && Date.now() - prev.ts < 3600000) {
      // 重复消息：强制在 system_prompt 开头加指令
      const prevReplyHint = prev.reply ? `上次你的回复是："${prev.reply.slice(0, 150)}"。` : ''
      soulPrompt = `⚠️ 重要：用户重复发了同一条消息。${prevReplyHint}\n你必须换一种完全不同的方式回答。可以说"这个刚回答过，还有什么不清楚的？"或从另一个角度展开。绝对不能重复上次的内容。\n\n` + soulPrompt
    }
  } catch {}

  return {
    system_prompt: customPrompt ? customPrompt + '\n\n' + soulPrompt : soulPrompt,
    augments: selected.join('\n\n'),
    augments_array: augmentObjects,
    memories: recalled.map((m: any) => ({ content: m.content, scope: m.scope, emotion: m.emotion })),
    mood: moodScore,
    energy: energyScore,
    emotion,
    cognition: cogResult ? {
      attention: cogResult.attention, intent: cogResult.intent,
      strategy: cogResult.strategy, complexity: cogResult.complexity,
    } : null,
  }
}

async function handleFeedback(body: any): Promise<any> {
  const userMessage = body.user_message || ''
  const aiReply = body.ai_reply || ''
  const userId = body.user_id || body.userId || 'default'
  const agentId = body.agent_id || body.agentId || 'default'
  const satisfaction = body.satisfaction || ''

  // Multi-agent isolation
  if (agentId !== 'default') {
    try { const { setActiveAgent } = await import('./persistence.ts'); setActiveAgent(agentId) } catch {}
  }

  if (!userMessage || !aiReply) return { error: 'user_message and ai_reply required' }

  // Update dedup cache with actual reply content (read fresh from disk to avoid stale cache)
  try {
    const { resolve } = await import('path')
    const { readFileSync, writeFileSync, existsSync } = await import('fs')
    const { DATA_DIR } = await import('./persistence.ts')
    const DEDUP_PATH = resolve(DATA_DIR, 'recent_replies.json')
    // Read fresh from disk (not cached) to avoid cross-process stale data
    let dedup: Record<string, { reply: string; ts: number }> = {}
    try { if (existsSync(DEDUP_PATH)) dedup = JSON.parse(readFileSync(DEDUP_PATH, 'utf-8')) } catch {}
    const dedupKey = userMessage.slice(0, 100).toLowerCase().trim()
    dedup[dedupKey] = { reply: aiReply.slice(0, 200), ts: Date.now() }
    // Clean expired
    const now = Date.now()
    for (const [k, v] of Object.entries(dedup)) { if (now - v.ts > 3600000) delete dedup[k] }
    writeFileSync(DEDUP_PATH, JSON.stringify(dedup, null, 2), 'utf-8')
  } catch {}

  // History
  try { (await import('./memory.ts')).addToHistory(userMessage, aiReply) } catch {}

  // Avatar
  try { (await import('./avatar.ts')).collectAvatarData(userMessage, aiReply, userId) } catch {}

  // Quality
  let qualityScore = -1
  try {
    const { scoreResponse, trackQuality } = await import('./quality.ts')
    qualityScore = scoreResponse(userMessage, aiReply)
    trackQuality(qualityScore)
    const { getSessionState, getLastActiveSessionKey } = await import('./handler-state.ts')
    const sess = getSessionState(getLastActiveSessionKey())
    if (sess) sess.lastQualityScore = qualityScore
  } catch {}

  // Body feedback
  try {
    const { bodyOnPositiveFeedback, bodyOnCorrection } = await import('./body.ts')
    if (satisfaction === 'positive') bodyOnPositiveFeedback()
    if (satisfaction === 'negative') bodyOnCorrection()
  } catch {}

  // Gratitude
  try { (await import('./user-profiles.ts')).trackGratitude(userMessage, aiReply, userId) } catch {}

  // Raw persistence (sync, never lost)
  try {
    const { addMemory } = await import('./memory.ts')
    addMemory(`[对话] 用户: ${userMessage.slice(0, 60)} → AI: ${aiReply.slice(0, 60)}`, 'fact', userId, 'private')
    // 用原始用户消息单独做 fact 提取（对话对格式会污染正则匹配）
    const { autoExtractFromMemory } = await import('./fact-store.ts')
    autoExtractFromMemory(userMessage, 'fact', 'user_said')
  } catch {}

  // 活画像微更新
  try {
    const { updateLivingProfile } = await import('./person-model.ts')
    // importance 从消息内容关键词判断
    const importance = /名字|叫我|工作|公司|住|女儿|儿子|老婆|喜欢|讨厌|每天|习惯/.test(userMessage) ? 8 : 5
    updateLivingProfile(userMessage, 'fact', importance)
  } catch {}

  // LLM deep analysis (async, with timeout)
  try {
    const { runPostResponseAnalysis } = await import('./cli.ts')
    const { addMemoryWithEmotion } = await import('./memory.ts')
    const { addEntitiesFromAnalysis } = await import('./graph.ts')

    const analysisPromise = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { console.log(`[cc-soul][api] feedback analysis timed out`); resolve() }, 20000)
      runPostResponseAnalysis(userMessage, aiReply, (result: any) => {
        clearTimeout(timeout)
        try {
          for (const m of (result.memories || [])) {
            addMemoryWithEmotion(m.content, m.scope, userId, m.visibility, '', result.emotion)
          }
          if (result.entities) addEntitiesFromAnalysis(result.entities)
          if (result.memoryOps?.length > 0) {
            import('./memory.ts').then(({ executeMemoryCommands }) => {
              executeMemoryCommands(result.memoryOps.slice(0, 3), userId, '')
            }).catch((e: any) => { console.error(`[cc-soul] module load failed (memory): ${e.message}`) })
          }
          console.log(`[cc-soul][api] feedback: ${(result.memories||[]).length} memories`)
        } catch {}
        resolve()
      })
    })
    analysisPromise.catch(() => {}) // intentionally silent — background analysis
  } catch (e: any) {
    console.log(`[cc-soul][api] feedback error: ${e.message}`)
  }

  // ── Activation field Hebbian feedback ──
  try {
    const { hebbianUpdate } = await import('./aam.ts')
    const { decayAllActivations } = await import('./activation-field.ts')
    // 每次 feedback 触发一次小衰减
    decayAllActivations(0.995)
    // quality 高 → 强化刚才用到的 key weights；quality 低 → 削弱
    if (qualityScore > 6) {
      hebbianUpdate({ lexical: 0.5, temporal: 0.3, emotional: 0.3, entity: 0.3, behavioral: 0.2, factual: 0.4, causal: 0.2, sequence: 0.2 }, true)
    } else if (qualityScore >= 0 && qualityScore < 4) {
      hebbianUpdate({ lexical: 0.5, temporal: 0.3, emotional: 0.3, entity: 0.3, behavioral: 0.2, factual: 0.4, causal: 0.2, sequence: 0.2 }, false)
    }
  } catch {}

  // ── 蒸馏反馈闭环：根据质量反馈 topic node 置信度 ──
  try {
    const { feedbackDistillQuality } = await import('./handler-augments.ts')
    if (qualityScore >= 0) feedbackDistillQuality(qualityScore)
  } catch {}

  // Record observation for behavior engine learning
  try {
    const { recordObservation } = await import('./behavior-engine.ts')
    const { getSessionState, getLastActiveSessionKey } = await import('./handler-state.ts')
    const { body: bodyState } = await import('./body.ts')
    const sess = getSessionState(getLastActiveSessionKey())
    const reaction = satisfaction === 'positive' ? 'satisfied' as const
      : satisfaction === 'negative' ? 'corrected' as const
      : 'neutral' as const
    recordObservation(userMessage, bodyState.mood, sess, reaction, 'balanced')
  } catch {}

  return { learned: true }
}
