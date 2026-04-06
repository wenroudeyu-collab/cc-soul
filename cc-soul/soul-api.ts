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

  // LLM 配置（两级优先：ai_config.json → soul.json）
  let llmConfigured = false

  // 1. ai_config.json（用户通过"soul设置"命令或手动创建）
  try {
    (await import('./cli.ts')).loadAIConfig()
    const { hasLLM } = await import('./cli.ts')
    if (hasLLM()) {
      llmConfigured = true
    }
  } catch {}

  // 2. soul.json 的 llm 字段（备选）
  if (!llmConfigured) {
    try {
      const { resolve } = await import('path')
      const { DATA_DIR } = await import('./persistence.ts')
      const { readFileSync, existsSync } = await import('fs')
      const soulJsonPath = resolve(DATA_DIR, '..', 'soul.json')
      if (existsSync(soulJsonPath)) {
        const soulJson = JSON.parse(readFileSync(soulJsonPath, 'utf-8'))
        if (soulJson.llm?.base_url && soulJson.llm?.api_key) {
          configureLLM({ api_base: soulJson.llm.base_url, api_key: soulJson.llm.api_key, model: soulJson.llm.model || 'gpt-4o-mini' })
          llmConfigured = true
          console.log(`[cc-soul] LLM configured from soul.json: ${soulJson.llm.model || 'gpt-4o-mini'}`)
        }
      }
    } catch {}
  }

  // 3. LLM 连通性验证（异步，不阻塞启动）
  if (llmConfigured) {
    import('./cli.ts').then(async ({ validateLLM }) => {
      const result = await validateLLM()
      if (result.ok) console.log(`[cc-soul] ✅ LLM 连接正常`)
      else console.log(`[cc-soul] ⚠️ LLM 连接失败: ${result.error}（核心功能不受影响）`)
    }).catch(() => {})
  } else {
    console.log(`[cc-soul] 未配置 LLM，纯 NAM 模式。发送"/soul-llm"查看配置方法。`)
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

      let llm = { configured: false, connected: false, model: '', error: '' }
      try { llm = require('./cli.ts').getLLMStatus() } catch {}

      return {
        status: 'ok',
        version: '2.9.2',
        port: SOUL_API_PORT,
        uptime: Math.floor(process.uptime()),
        sqlite: sqliteStatus,
        memoryCount,
        factCount,
        llm,
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
          let query = body.query || body.message || ''
          const userId = body.user_id || body.userId || 'default'
          const topN = body.top_n || body.limit || 5

          const { hasLLM, spawnCLI } = await import('./cli.ts')
          const llmAvailable = hasLLM()

          // ── 增强 2: LLM Query Rewrite（抽象查询时扩展关键词）──
          // 只在有 LLM 且查询含抽象词时触发，在 NAM 召回之前执行
          if (llmAvailable) {
            const _abstractWords = /方式|习惯|品味|爱好|特点|性格|规划|想法|压力|活动|偏好|style|habit|taste|hobby|trait|plan|routine|preference/i
            if (_abstractWords.test(query)) {
              try {
                const keywords = await Promise.race([
                  new Promise<string>((resolve) => {
                    spawnCLI(
                      `用户问"${query.slice(0, 100)}"，请列出5个最可能相关的具体关键词，每行一个，只输出关键词不要解释`,
                      (output: string) => resolve(output || ''),
                      8000, 'query-rewrite'
                    )
                  }),
                  new Promise<string>((resolve) => setTimeout(() => resolve(''), 10000)),
                ])
                if (keywords) {
                  const kws = keywords.split('\n').map(l => l.trim().replace(/^[\d.、\-*]+/, '').trim()).filter(l => l.length >= 2 && l.length <= 20)
                  if (kws.length > 0) {
                    query = query + ' ' + kws.join(' ')
                    console.log(`[cc-soul][search] query rewrite: +${kws.length} keywords → "${query.slice(0, 80)}"`)
                  }
                }
              } catch {}  // rewrite 失败不影响召回
            }
          }

          // NAM 召回（有 LLM 时宽召回供精排，没 LLM 时只召回 topN）
          const recallN = llmAvailable ? Math.max(topN * 4, 20) : topN
          let results = recall(query, recallN, userId)

          // ── 增强 1: LLM Rerank（从宽召回里精选 topN）──
          if (llmAvailable && results.length > topN) {
            try {
              const candidates = results.map((m: any, i: number) => `[${i}] <<<${(m.content || '').replace(/\n/g, ' ').slice(0, 200)}>>>`).join('\n')
              const rerankPrompt = `Given the question: "${query.slice(0, 200)}"

Here are ${results.length} memory candidates:
${candidates}

Select the ${topN} most relevant memories for answering the question. Reply with ONLY the numbers separated by commas (e.g. "3,7,1"). Nothing else.`

              const reranked = await Promise.race([
                new Promise<typeof results>((resolve) => {
                  spawnCLI(rerankPrompt, (output: string) => {
                    try {
                      const indices = (output || '').match(/\d+/g)?.map(Number).filter(i => i >= 0 && i < results.length) || []
                      // 去重
                      const unique = [...new Set(indices)]
                      if (unique.length > 0) {
                        const picked = unique.slice(0, topN).map(i => results[i]).filter(Boolean)
                        resolve(picked.length > 0 ? picked : results.slice(0, topN))
                      } else {
                        resolve(results.slice(0, topN))
                      }
                    } catch {
                      resolve(results.slice(0, topN))
                    }
                  }, 10000, 'rerank')
                }),
                // 超时兜底：比 spawnCLI 的 10s 多 2s
                new Promise<typeof results>((resolve) => setTimeout(() => resolve(results.slice(0, topN)), 12000)),
              ])
              // ── CR: Consensus Recall — LLM 选了但 NAM 排低的 → 喂回 AAM 学习 ──
              // "LLM 当教练，AAM 当学生，学会后教练退场"
              try {
                const { learnAssociation: _crLearn } = await import('./aam.ts')
                const _namTopContents = new Set(results.slice(0, topN).map((r: any) => r.content))
                const queryKw = (query.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}/gi) || []).slice(0, 5)
                for (const mem of reranked) {
                  if (!_namTopContents.has((mem as any).content)) {
                    // LLM 选了但 NAM 没选 → NAM 漏了这条 → 学习关联
                    const memKw = (((mem as any).content || '').match(/[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}/gi) || []).slice(0, 5)
                    if (queryKw.length > 0 && memKw.length > 0) {
                      _crLearn(queryKw.join(' ') + ' ' + memKw.join(' '), 0.8)
                    }
                  }
                }
              } catch {}
              results = reranked
              console.log(`[cc-soul][search] LLM rerank: ${recallN} → ${results.length} results`)
            } catch {
              results = results.slice(0, topN)  // LLM 失败 → 纯 NAM 降级
            }
          } else {
            results = results.slice(0, topN)
          }

          // 返回结果 + facts
          const { getFactSummary, queryFacts } = await import('./fact-store.ts')
          const facts = queryFacts({ subject: userId })
          res.writeHead(200)
          res.end(JSON.stringify({
            memories: results.map((m: any) => ({ content: m.content, scope: m.scope, ts: m.ts, confidence: m.confidence })),
            facts: facts.map((f: any) => ({ predicate: f.predicate, object: f.object, confidence: f.confidence })),
            fact_summary: getFactSummary(userId),
            _meta: { reranked: llmAvailable && recallN > topN, query_rewritten: query !== (body.query || body.message || '') },
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

      // A2A / MCP / soul-spec 已移除

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
