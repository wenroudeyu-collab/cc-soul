/**
 * soul-api.ts — cc-soul Engine API Server
 *
 * One entry point: POST /api {action, ...params}
 * Individual endpoints (/process, /soul, etc.) also supported for convenience.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http'
import './persistence.ts' // ensure data dir + config init

const SOUL_API_PORT = parseInt(process.env.SOUL_PORT || '18800', 10)

// ═══════════════════════════════════════════════════════════════════════════════
// LLM CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

interface LLMConfig { api_base: string; api_key: string; model: string }

export function configureLLM(config: LLMConfig) {
  import('./cli.ts').then(({ setFallbackApiConfig }) => {
    setFallbackApiConfig({
      backend: 'openai-compatible' as any, cli_command: '', cli_args: [],
      api_base: config.api_base, api_key: config.api_key, api_model: config.model, max_concurrent: 8,
    })
  }).catch((e: any) => { console.error(`[cc-soul] module load failed (cli): ${e.message}`) })
  console.log(`[cc-soul] LLM configured: ${config.model} @ ${config.api_base}`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// INIT + HEARTBEAT
// ═══════════════════════════════════════════════════════════════════════════════

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let _initDelayTimer: ReturnType<typeof setTimeout> | null = null

export async function initSoulEngine() {
  try { (await import('./persistence.ts')).ensureDataDir() } catch {}
  try { (await import('./memory.ts')).ensureSQLiteReady() } catch {}
  try { (await import('./features.ts')).loadFeatures() } catch {}
  try { (await import('./user-profiles.ts')).loadProfiles() } catch {}

  const envBase = process.env.LLM_API_BASE
  const envKey = process.env.LLM_API_KEY
  if (envBase && envKey) {
    configureLLM({ api_base: envBase, api_key: envKey, model: process.env.LLM_MODEL || 'gpt-4o' })
  } else {
    try { (await import('./cli.ts')).loadAIConfig(); console.log('[cc-soul] LLM auto-detected') } catch {}
  }

  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(async () => {
      try { (await import('./handler-heartbeat.ts')).runHeartbeat() } catch {}
    }, 30 * 60 * 1000)
    _initDelayTimer = setTimeout(async () => { try { (await import('./handler-heartbeat.ts')).runHeartbeat() } catch {} }, 5 * 60 * 1000)
    console.log(`[cc-soul] heartbeat scheduled`)
  }
}

export function stopSoulEngine() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  if (_initDelayTimer) { clearTimeout(_initDelayTimer); _initDelayTimer = null }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNIFIED ACTION HANDLER — all logic in one place, no duplication
// ═══════════════════════════════════════════════════════════════════════════════

async function handleAction(action: string, body: any): Promise<any> {
  // 入参验证（不合法直接 400，不进业务逻辑）
  try {
    const { validateAction } = require('./validate.ts')
    const error = validateAction(action, body)
    if (error) return { error: `validation failed: ${error}` }
  } catch {}

  switch (action) {
    case 'process':
      return (await import('./soul-process.ts')).handleProcess(body)

    case 'feedback':
      return (await import('./soul-process.ts')).handleFeedback(body)

    case 'soul':
      return (await import('./soul-reply.ts')).handleSoul(body)

    case 'profile': {
      const userId = body.user_id || 'default'
      const { getAvatarStats, loadAvatarProfile } = await import('./avatar.ts')
      const profile = loadAvatarProfile(userId); const stats = getAvatarStats(userId)
      let pm: any = {}; try { pm = (await import('./person-model.ts')).getPersonModel() } catch {}
      const { body: bs } = await import('./body.ts')
      return {
        avatar: stats,
        social: Object.entries(profile.social || {}).map(([n, c]: [string, any]) => ({ name: n, relation: c.relation, samples: (c.samples || []).length })),
        identity: pm.identity || '', thinkingStyle: pm.thinkingStyle || '', values: pm.values || [],
        vocabulary: profile.vocabulary || {}, mood: bs.mood, energy: bs.energy,
      }
    }

    case 'features':
      if (body.feature) {
        const { setFeature, isEnabled } = await import('./features.ts')
        setFeature(body.feature, !!body.enabled)
        return { feature: body.feature, enabled: isEnabled(body.feature) }
      }
      return (await import('./features.ts')).getAllFeatures()

    case 'config':
      if (!body.api_base || !body.api_key || !body.model) return { error: 'need api_base, api_key, model' }
      configureLLM(body)
      return { ok: true, model: body.model }

    case 'command': {
      const { routeCommand, routeCommandDirect } = await import('./handler-commands.ts')
      const { getSessionState } = await import('./handler-state.ts')
      const session = getSessionState(body.user_id || 'default')
      let reply = ''; const ctx = { bodyForAgent: '', reply: (t: string) => { reply = t } }
      const handled = routeCommand(body.message || '', ctx, session, body.user_id || '', '', { context: { senderId: body.user_id || '' } })
      if (handled) return { handled, reply: reply || '(done)' }
      // Fallback: try routeCommandDirect (handles values, personas, features, etc.)
      const directHandled = await routeCommandDirect(body.message || '', { to: '', cfg: {}, event: {} })
      return { handled: directHandled, reply: directHandled ? '(done)' : '(not a command)' }
    }

    case 'health': {
      let workloadCosts = {}
      let recentEvents: any[] = []
      let sqliteStatus = 'unknown'
      let memoryCount = 0
      let factCount = 0
      let featureStats = {}

      try { workloadCosts = require('./cli.ts').getWorkloadCosts() } catch {}
      try { recentEvents = require('./flow.ts').getRecentEvents(3) } catch {}
      try {
        const db = (globalThis as any).__ccSoulSqlite?.db
        if (db) {
          sqliteStatus = 'connected'
          memoryCount = db.prepare('SELECT COUNT(*) as c FROM memories').get()?.c ?? 0
          factCount = db.prepare('SELECT COUNT(*) as c FROM structured_facts').get()?.c ?? 0
        } else {
          sqliteStatus = 'disconnected'
        }
      } catch { sqliteStatus = 'error' }
      try {
        const { getAllFeatures } = require('./features.ts')
        const all = getAllFeatures?.() ?? {}
        const entries = Object.entries(all)
        featureStats = { total: entries.length, enabled: entries.filter(([_, v]) => v).length }
      } catch {}

      return {
        status: 'ok',
        version: '2.9.2',
        port: SOUL_API_PORT,
        uptime: Math.floor(process.uptime()),
        sqlite: sqliteStatus,
        memoryCount,
        factCount,
        workloadCosts,
        recentEvents,
        features: featureStats,
      }
    }

    default:
      return { error: `unknown action: "${action}"`, actions: ['process', 'feedback', 'soul', 'profile', 'features', 'config', 'command', 'health'] }
  }
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

// Map URL paths to action names
const URL_TO_ACTION: Record<string, string> = {
  '/process': 'process', '/feedback': 'feedback', '/soul': 'soul',
  '/profile': 'profile', '/features': 'features', '/config': 'config',
  '/command': 'command', '/health': 'health',
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
      const body = req.method === 'POST' ? JSON.parse(await readBody(req)) : {}

      // ── Route: /api {action} OR /path directly ──
      let action = ''
      if (url === '/api' && body.action) {
        action = body.action
      } else if (URL_TO_ACTION[url]) {
        action = URL_TO_ACTION[url]
      } else if (url === '/health' && req.method === 'GET') {
        action = 'health'
      } else if (url === '/features' && req.method === 'GET') {
        action = 'features'
      } else if (url === '/profile' && req.method === 'GET') {
        action = 'profile'
      }

      if (action) {
        const result = await handleAction(action, body)
        res.writeHead(result?.error ? 400 : 200)
        res.end(JSON.stringify(result))
        return
      }

      // ── Mem0 风格简洁 API：/memory/search, /memory/add, /memory/list ──
      // 学 Mem0/Zep：任何平台调这些 API 获取/存储记忆

      if (url === '/memory/search' && req.method === 'POST') {
        try {
          const { recall, ensureMemoriesLoaded } = await import('./memory.ts')
          ensureMemoriesLoaded()
          const query = body.query || body.message || ''
          const userId = body.user_id || body.userId || 'default'
          const topN = body.top_n || body.limit || 5
          const results = recall(query, topN, userId)
          // 同时返回 facts（始终注入的核心记忆）
          const { getFactSummary, queryFacts } = await import('./fact-store.ts')
          const facts = queryFacts({ subject: 'user' })
          res.writeHead(200)
          res.end(JSON.stringify({
            memories: results.map(m => ({ content: m.content, scope: m.scope, ts: m.ts, confidence: m.confidence })),
            facts: facts.map(f => ({ predicate: f.predicate, object: f.object, confidence: f.confidence })),
            fact_summary: getFactSummary('user'),
          }))
        } catch (e: any) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })) }
        return
      }

      if (url === '/memory/add' && req.method === 'POST') {
        try {
          const { addMemory } = await import('./memory.ts')
          const { extractFacts, addFacts } = await import('./fact-store.ts')
          const content = body.content || body.message || body.text || ''
          const userId = body.user_id || body.userId || 'default'
          const scope = body.scope || 'fact'
          if (!content) { res.writeHead(400); res.end(JSON.stringify({ error: 'content required' })); return }
          // 存记忆
          addMemory(content, scope, userId, 'private')
          // 提取并存事实
          const facts = extractFacts(content, 'user_said', userId)
          if (facts.length > 0) addFacts(facts)
          res.writeHead(200)
          res.end(JSON.stringify({ stored: true, facts_extracted: facts.length }))
        } catch (e: any) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })) }
        return
      }

      if (url === '/memory/list' && req.method === 'GET') {
        try {
          const { queryFacts, getFactSummary } = await import('./fact-store.ts')
          const facts = queryFacts({ subject: 'user' })
          res.writeHead(200)
          res.end(JSON.stringify({
            facts: facts.map(f => ({ predicate: f.predicate, object: f.object, confidence: f.confidence, ts: f.ts })),
            summary: getFactSummary('user'),
            count: facts.length,
          }))
        } catch (e: any) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })) }
        return
      }

      // ── Special endpoints (non-standard patterns) ──

      // A2A
      if (url === '/.well-known/agent.json') {
        try {
          const { getAgentCard } = await import('./a2a.ts')
          res.writeHead(200); res.end(JSON.stringify(getAgentCard())); return
        } catch { res.writeHead(404); res.end(JSON.stringify({ error: 'not available' })); return }
      }
      if (url === '/a2a' && req.method === 'POST') {
        try {
          const { handleA2ARequest } = await import('./a2a.ts')
          res.writeHead(200); res.end(JSON.stringify(await handleA2ARequest(body))); return
        } catch (e: any) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); return }
      }

      // MCP
      if (url === '/mcp/tools') {
        try {
          const { getMCPTools } = await import('./mcp-provider.ts')
          res.writeHead(200); res.end(JSON.stringify(getMCPTools().map(t => ({ name: t.name, description: t.description })))); return
        } catch { res.writeHead(404); res.end(JSON.stringify({ error: 'not available' })); return }
      }
      if (url === '/mcp/call' && req.method === 'POST') {
        try {
          const { getMCPTools } = await import('./mcp-provider.ts')
          const tool = getMCPTools().find(t => t.name === (body.tool || body.name))
          if (!tool) { res.writeHead(400); res.end(JSON.stringify({ error: 'unknown tool' })); return }
          res.writeHead(200); res.end(JSON.stringify({ tool: tool.name, result: tool.handler(body.args || {}) })); return
        } catch (e: any) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); return }
      }

      // Soul spec
      if (url === '/soul-spec') {
        const { existsSync, readFileSync } = await import('fs')
        const { resolve } = await import('path')
        const { DATA_DIR } = await import('./persistence.ts')
        const read = (p: string) => { try { return existsSync(p) ? readFileSync(p, 'utf-8') : null } catch { return null } }
        const rootDir = resolve(DATA_DIR, '..')
        res.writeHead(200); res.end(JSON.stringify({
          soul_json: JSON.parse(read(resolve(rootDir, 'soul.json')) || '{}'),
          style: read(resolve(rootDir, 'STYLE.md')),
          identity: read(resolve(rootDir, 'IDENTITY.md')),
        })); return
      }

      // 404
      res.writeHead(404); res.end(JSON.stringify({
        error: 'not found',
        usage: 'POST /api {"action": "process|feedback|soul|profile|features|config|command|health", ...params}',
      }))
    } catch (e: any) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }))
    }
  })

  server.listen(SOUL_API_PORT, '0.0.0.0', () => {
    console.log(`\n  cc-soul Engine API — http://0.0.0.0:${SOUL_API_PORT}`)
    console.log(`  POST /api {"action": "process|feedback|soul|profile|features|config|command|health"}\n`)
  })
  server.on('error', (e: any) => {
    if (e.code === 'EADDRINUSE') console.log(`[cc-soul] port ${SOUL_API_PORT} in use`)
    else console.error(`[cc-soul] error: ${e.message}`)
  })

  // ── 优雅关闭（多维度考虑）──
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return  // 防止重复触发
    shuttingDown = true
    console.log(`[cc-soul] ${signal} received, shutting down...`)

    // 硬超时 5 秒：不管 flush 有没有完成都退出
    const forceExit = setTimeout(() => {
      console.error(`[cc-soul] forced exit after 5s timeout`)
      process.exit(1)
    }, 5000)

    // 1. 停止接新请求
    try { server.close() } catch {}

    // 2. 停 heartbeat
    try { stopSoulEngine() } catch {}

    // 3. flush 所有 debounced saves
    try { require('./persistence.ts').flushAll() } catch {}

    // 4. 保存记忆到 SQLite
    try { require('./memory.ts').saveMemories() } catch {}

    // 5. SQLite WAL checkpoint + 关闭
    try {
      const db = (globalThis as any).__ccSoulSqlite?.db
      if (db) { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close() }
    } catch {}

    // 6. 触发缓存事件让所有模块知道要停了
    try { require('./memory-utils.ts').emitCacheEvent('consolidation') } catch {}

    clearTimeout(forceExit)
    console.log(`[cc-soul] graceful shutdown complete`)
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

// ═══════════════════════════════════════════════════════════════════════════════
// STANDALONE ENTRY
// ═══════════════════════════════════════════════════════════════════════════════

const isMain = typeof process !== 'undefined' && process.argv[1]?.endsWith('soul-api.ts')
if (isMain) {
  console.log('[cc-soul] Standalone mode')
  initSoulEngine().then(() => startSoulApi())
}
