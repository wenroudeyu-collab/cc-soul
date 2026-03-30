/**
 * soul-process.ts — Core message processing pipeline
 *
 * Handles POST /process and POST /feedback.
 * Runs the full cc-soul pipeline: cognition → emotion → memory → augments → return.
 * Does NOT call LLM — returns enriched context for customer's AI.
 */

import { soulConfig } from './persistence.ts'

export { handleProcess, handleFeedback }

async function handleProcess(body: any): Promise<any> {
  const message = body.message || ''
  const userId = body.user_id || body.userId || 'default'
  const customPrompt = body.system_prompt || ''

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
    bodyMod.processEmotionalContagion(message, userId)
    moodScore = bodyMod.body.mood; energyScore = bodyMod.body.energy
    emotion = moodScore > 0.3 ? 'positive' : moodScore < -0.3 ? 'negative' : 'neutral'
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
      const prefMatch = message.match(/我(?:喜欢|不喜欢|讨厌|住在?|是|养了?|有|擅长|从事)(.{2,40})/g)
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

  // ── 8. Build augments ──
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
  const satisfaction = body.satisfaction || ''

  if (!userMessage || !aiReply) return { error: 'user_message and ai_reply required' }

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
            }).catch(() => {})
          }
          console.log(`[cc-soul][api] feedback: ${(result.memories||[]).length} memories`)
        } catch {}
        resolve()
      })
    })
    analysisPromise.catch(() => {})
  } catch (e: any) {
    console.log(`[cc-soul][api] feedback error: ${e.message}`)
  }

  return { learned: true }
}
