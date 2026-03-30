/**
 * soul-api.ts — cc-soul Standalone Engine API
 *
 * 人格引擎中间件。不绑定任何 AI、任何平台。
 * 客户调 API，cc-soul 返回增强上下文，客户自己喂给他们的 AI。
 *
 * 核心端点：
 *   POST /process   — 处理消息，返回增强上下文（记忆+情绪+人格+社交+认知）
 *   POST /feedback   — AI 回复后反馈，cc-soul 学习
 *   POST /soul       — 灵魂模式（需要 LLM，以用户身份回复）
 *   GET  /profile    — 查看人格档案
 *   GET  /features   — 查看功能开关
 *   POST /features   — 开启/关闭功能
 *   POST /config     — 配置 LLM（仅灵魂模式需要）
 *   GET  /health     — 健康检查
 */

import { createServer, IncomingMessage, ServerResponse } from 'http'
import { soulConfig } from './persistence.ts'

const SOUL_API_PORT = parseInt(process.env.SOUL_PORT || '18800', 10)

// ═══════════════════════════════════════════════════════════════════════════════
// LLM CONFIG — only needed for /soul endpoint (customer's AI handles /process)
// ═══════════════════════════════════════════════════════════════════════════════

interface LLMConfig {
  api_base: string
  api_key: string
  model: string
}

let llmConfig: LLMConfig | null = null

export function configureLLM(config: LLMConfig) {
  llmConfig = config
  import('./cli.ts').then(({ setFallbackApiConfig }) => {
    setFallbackApiConfig({
      backend: 'openai-compatible' as any,
      cli_command: '', cli_args: [],
      api_base: config.api_base,
      api_key: config.api_key,
      api_model: config.model,
      max_concurrent: 8,
    })
  }).catch(() => {})
  console.log(`[cc-soul] LLM configured: ${config.model} @ ${config.api_base}`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /process — the CORE endpoint
// Customer sends a message, cc-soul runs full pipeline, returns enriched context.
// Customer feeds this context to their own AI. cc-soul never calls LLM here.
// ═══════════════════════════════════════════════════════════════════════════════

async function handleProcess(body: any): Promise<any> {
  const message = body.message || ''
  const userId = body.user_id || body.userId || 'default'
  const role = body.role || 'user'  // 'user' or 'assistant'

  if (!message) return { error: 'message is required' }

  // Initialize (lazy)
  try {
    const { ensureDataDir } = await import('./persistence.ts')
    ensureDataDir()
    const { ensureSQLiteReady } = await import('./memory.ts')
    try { ensureSQLiteReady() } catch {}
  } catch {}

  const augments: string[] = []
  let emotion = 'neutral'
  let moodScore = 0
  let energyScore = 1

  // ── 1. Body tick + emotional contagion ──
  try {
    const { bodyTick, bodyOnMessage, processEmotionalContagion, body: bodyState } = await import('./body.ts')
    bodyTick()
    bodyOnMessage(message.length > 50 ? 0.6 : 0.3)
    processEmotionalContagion(message, userId)
    moodScore = bodyState.mood
    energyScore = bodyState.energy
    emotion = moodScore > 0.3 ? 'positive' : moodScore < -0.3 ? 'negative' : 'neutral'
  } catch {}

  // ── 2. Cognition ──
  let cogResult: any = null
  try {
    const { cogProcess } = await import('./cognition.ts')
    cogResult = cogProcess(message, userId)
    if (cogResult.hints && cogResult.hints.length > 0) {
      augments.push(`[认知] ${cogResult.hints.join('; ')}`)
    }
  } catch {}

  // ── 3. Memory recall ──
  let recalled: any[] = []
  try {
    const { recall } = await import('./memory.ts')
    recalled = recall(message, 5, userId)
    if (recalled.length > 0) {
      augments.push(`[相关记忆]\n${recalled.map(m => `- ${m.content.slice(0, 80)}`).join('\n')}`)
    }
  } catch {}

  // ── 4. Person model ──
  try {
    const { getPersonModel } = await import('./person-model.ts')
    const pm = getPersonModel()
    if (pm.distillCount > 0) {
      const parts: string[] = []
      if (pm.identity) parts.push(`身份: ${pm.identity.slice(0, 150)}`)
      if (pm.values.length > 0) parts.push(`价值观: ${pm.values.slice(-3).join('、')}`)
      if (pm.beliefs.length > 0) parts.push(`信念: ${pm.beliefs.slice(-2).join('、')}`)
      if (pm.contradictions.length > 0) parts.push(`矛盾面: ${pm.contradictions[0]}`)
      if (parts.length > 0) augments.push(`[用户人格]\n${parts.join('\n')}`)
    }
  } catch {}

  // ── 5. Social context ──
  try {
    const { loadAvatarProfile } = await import('./avatar.ts')
    const profile = loadAvatarProfile(userId)
    const socialEntries = Object.entries(profile.social || {})
    if (socialEntries.length > 0) {
      const mentioned = socialEntries.filter(([name]) => message.includes(name))
      if (mentioned.length > 0) {
        augments.push(`[提到的人]\n${mentioned.map(([name, c]: [string, any]) =>
          `${name}（${c.relation}）`
        ).join('、')}`)
      }
    }
  } catch {}

  // ── 6. Emotional context ──
  try {
    const { body: bodyState, emotionVector } = await import('./body.ts')
    const moodLabel = bodyState.mood > 0.3 ? '心情不错' : bodyState.mood < -0.3 ? '心情低落' : '平静'
    augments.push(`[情绪状态] ${moodLabel}（mood=${bodyState.mood.toFixed(2)}, energy=${bodyState.energy.toFixed(2)}）`)
  } catch {}

  // ── 7. User profile context ──
  try {
    const { getProfileContext, getRhythmContext } = await import('./user-profiles.ts')
    const profileCtx = getProfileContext(userId)
    if (profileCtx) augments.push(profileCtx)
    const rhythmCtx = getRhythmContext(userId)
    if (rhythmCtx) augments.push(rhythmCtx)
  } catch {}

  // ── 8. Update user profile ──
  try {
    const { updateProfileOnMessage } = await import('./user-profiles.ts')
    updateProfileOnMessage(userId, message)
  } catch {}

  // ── 9. Avatar data collection (learns from every message) ──
  try {
    const { collectAvatarData } = await import('./avatar.ts')
    collectAvatarData(message, '', userId)
  } catch {}

  // ── 10. Soul prompt (same content as SOUL.md in OpenClaw mode) ──
  let soulPrompt = ''
  try {
    const { buildSoulPrompt } = await import('./prompt-builder.ts')
    const { stats } = await import('./handler-state.ts')
    soulPrompt = buildSoulPrompt(stats.totalMessages, stats.corrections, stats.firstSeen, [])
  } catch {}

  // ── Return enriched context ──
  return {
    system_prompt: soulPrompt,  // complete soul prompt (= SOUL.md)
    augments: augments.join('\n\n'),  // additional context for this specific message
    memories: recalled.map(m => ({ content: m.content, scope: m.scope, emotion: m.emotion })),
    mood: moodScore,
    energy: energyScore,
    emotion,
    cognition: cogResult ? {
      attention: cogResult.attention,
      intent: cogResult.intent,
      strategy: cogResult.strategy,
      complexity: cogResult.complexity,
    } : null,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /feedback — customer sends back AI's reply, cc-soul learns from it
// ═══════════════════════════════════════════════════════════════════════════════

async function handleFeedback(body: any): Promise<any> {
  const userMessage = body.user_message || ''
  const aiReply = body.ai_reply || ''
  const userId = body.user_id || body.userId || 'default'
  const satisfaction = body.satisfaction || ''  // 'positive' | 'negative' | ''

  if (!userMessage || !aiReply) return { error: 'user_message and ai_reply required' }

  // Store in chat history
  try {
    const { addToHistory } = await import('./memory.ts')
    addToHistory(userMessage, aiReply)
  } catch {}

  // Avatar collection (learns expression patterns from user message + context of reply)
  try {
    const { collectAvatarData } = await import('./avatar.ts')
    collectAvatarData(userMessage, aiReply, userId)
  } catch {}

  // Quality tracking
  try {
    const { scoreResponse, trackQuality } = await import('./quality.ts')
    const score = scoreResponse(userMessage, aiReply)
    trackQuality(score)
  } catch {}

  // Positive/negative feedback → body state
  try {
    const { bodyOnPositiveFeedback, bodyOnCorrection } = await import('./body.ts')
    if (satisfaction === 'positive') bodyOnPositiveFeedback()
    if (satisfaction === 'negative') bodyOnCorrection()
  } catch {}

  // Gratitude tracking
  try {
    const { trackGratitude } = await import('./user-profiles.ts')
    trackGratitude(userMessage, aiReply, userId)
  } catch {}

  return { learned: true }
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /soul — soul mode (needs LLM)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleSoul(body: any): Promise<any> {
  const message = body.message || ''
  const userId = body.user_id || body.userId || soulConfig.owner_open_id || 'default'
  const speakerHint = body.speaker || ''

  if (!message) return { error: 'message is required' }

  const { generateAvatarReply, loadAvatarProfile } = await import('./avatar.ts')
  const { spawnCLI } = await import('./cli.ts')

  // Auto-detect speaker
  let speaker = speakerHint
  if (!speaker) {
    const profile = loadAvatarProfile(userId)
    const contacts = Object.entries(profile.social || {})
      .map(([name, c]: [string, any]) => `${name}（${c.relation}）`)
    if (contacts.length > 0) {
      speaker = await new Promise<string>((resolve) => {
        spawnCLI(
          `已知关系：${contacts.join('、')}\n消息："${message.slice(0, 100)}"\n最可能是谁发的？只回答名字，无法判断回答"未知"。`,
          (output) => {
            const name = (output || '').trim().replace(/["""。.，,\s]/g, '')
            if (profile.social[name]) { resolve(name); return }
            for (const known of Object.keys(profile.social)) {
              if ((output || '').includes(known)) { resolve(known); return }
            }
            resolve('')
          }, 10000
        )
      })
    }
  }

  const reply = await new Promise<string>((resolve) => {
    generateAvatarReply(userId, speaker || '未知', message, (r: string, refused?: boolean) => {
      resolve(refused ? '' : r)
    })
  })

  return { reply, speaker: speaker || '未知' }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP SERVER
// ═══════════════════════════════════════════════════════════════════════════════

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
  })
}

let serverStarted = false

export function startSoulApi() {
  if (serverStarted) return
  serverStarted = true

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    const url = req.url || ''
    res.setHeader('Content-Type', 'application/json')

    try {
      // ── GET /health ──
      if (url === '/health') {
        res.writeHead(200)
        res.end(JSON.stringify({ status: 'ok', port: SOUL_API_PORT, version: '1.0.0' }))
        return
      }

      const body = req.method === 'POST' ? JSON.parse(await readBody(req)) : {}

      // ── POST /process — CORE: process message, return augments ──
      if (url === '/process' && req.method === 'POST') {
        const result = await handleProcess(body)
        res.writeHead(result.error ? 400 : 200)
        res.end(JSON.stringify(result))
        return
      }

      // ── POST /feedback — learn from AI reply ──
      if (url === '/feedback' && req.method === 'POST') {
        const result = await handleFeedback(body)
        res.writeHead(result.error ? 400 : 200)
        res.end(JSON.stringify(result))
        return
      }

      // ── POST /soul — soul mode reply (needs LLM) ──
      if (url === '/soul' && req.method === 'POST') {
        const result = await handleSoul(body)
        res.writeHead(result.error ? 400 : 200)
        res.end(JSON.stringify(result))
        return
      }

      // ── POST /config — configure LLM (only for /soul) ──
      if (url === '/config' && req.method === 'POST') {
        if (!body.api_base || !body.api_key || !body.model) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'need api_base, api_key, model' }))
          return
        }
        configureLLM(body)
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true, model: body.model }))
        return
      }

      // ── GET /profile ──
      if (url === '/profile') {
        const userId = soulConfig.owner_open_id || 'default'
        const { getAvatarStats, loadAvatarProfile } = await import('./avatar.ts')
        const profile = loadAvatarProfile(userId)
        const stats = getAvatarStats(userId)
        let pm: any = {}
        try { pm = (await import('./person-model.ts')).getPersonModel() } catch {}
        const { body: bodyState } = await import('./body.ts')

        res.writeHead(200)
        res.end(JSON.stringify({
          avatar: stats,
          social: Object.entries(profile.social || {}).map(([name, c]: [string, any]) => ({
            name, relation: c.relation, samples: (c.samples || []).length,
          })),
          identity: pm.identity || '',
          thinkingStyle: pm.thinkingStyle || '',
          values: pm.values || [],
          vocabulary: profile.vocabulary || {},
          mood: bodyState.mood,
          energy: bodyState.energy,
        }))
        return
      }

      // ── GET/POST /features ──
      if (url === '/features' && req.method === 'GET') {
        const { getAllFeatures } = await import('./features.ts')
        res.writeHead(200)
        res.end(JSON.stringify(getAllFeatures()))
        return
      }
      if (url === '/features' && req.method === 'POST') {
        const { setFeature, isEnabled } = await import('./features.ts')
        setFeature(body.feature, !!body.enabled)
        res.writeHead(200)
        res.end(JSON.stringify({ feature: body.feature, enabled: isEnabled(body.feature) }))
        return
      }

      // ── 404 ──
      res.writeHead(404)
      res.end(JSON.stringify({
        error: 'not found',
        endpoints: {
          'POST /process':  '处理消息，返回增强上下文（不调LLM，客户自己喂AI）',
          'POST /feedback': 'AI回复后反馈，cc-soul学习',
          'POST /soul':     '灵魂模式回复（需要LLM配置）',
          'POST /config':   '配置LLM（仅灵魂模式需要）',
          'GET  /profile':  '查看人格档案',
          'GET  /features': '查看功能开关',
          'POST /features': '开启/关闭功能',
          'GET  /health':   '健康检查',
        },
      }))
    } catch (e: any) {
      res.writeHead(500)
      res.end(JSON.stringify({ error: e.message }))
    }
  })

  server.listen(SOUL_API_PORT, '0.0.0.0', () => {
    console.log(``)
    console.log(`  cc-soul Engine API`)
    console.log(`  http://0.0.0.0:${SOUL_API_PORT}`)
    console.log(``)
    console.log(`  POST /process   处理消息 → 返回增强上下文`)
    console.log(`  POST /feedback  AI回复反馈 → cc-soul学习`)
    console.log(`  POST /soul      灵魂模式回复`)
    console.log(`  GET  /profile   人格档案`)
    console.log(`  GET  /features  功能列表`)
    console.log(``)
  })

  server.on('error', (e: any) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`[cc-soul] port ${SOUL_API_PORT} in use, skipping`)
    } else {
      console.error(`[cc-soul] error: ${e.message}`)
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
// STANDALONE ENTRY: npx tsx cc-soul/soul-api.ts
// ═══════════════════════════════════════════════════════════════════════════════

const isMain = typeof process !== 'undefined' && process.argv[1]?.endsWith('soul-api.ts')
if (isMain) {
  console.log('[cc-soul] Standalone mode')

  // Initialize core
  import('./persistence.ts').then(({ ensureDataDir }) => ensureDataDir())
  import('./memory.ts').then(({ ensureSQLiteReady }) => {
    try { ensureSQLiteReady() } catch (e: any) { console.log(`SQLite: ${e.message}`) }
  })
  import('./features.ts').then(({ loadFeatures }) => loadFeatures())
  import('./user-profiles.ts').then(({ loadProfiles }) => loadProfiles())

  // LLM config (only for /soul endpoint)
  const envBase = process.env.LLM_API_BASE
  const envKey = process.env.LLM_API_KEY
  const envModel = process.env.LLM_MODEL
  if (envBase && envKey) {
    configureLLM({ api_base: envBase, api_key: envKey, model: envModel || 'gpt-4o' })
  } else {
    console.log('[cc-soul] No LLM configured (POST /config or set LLM_API_BASE + LLM_API_KEY)')
    console.log('[cc-soul] /process and /feedback work without LLM. Only /soul needs it.')
  }

  setTimeout(() => startSoulApi(), 500)
}
