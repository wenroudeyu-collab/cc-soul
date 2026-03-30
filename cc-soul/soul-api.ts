/**
 * soul-api.ts — cc-soul Engine API Server
 *
 * Thin HTTP server that routes requests to the engine modules.
 * All business logic lives in separate files:
 *   soul-process.ts   — /process + /feedback
 *   soul-reply.ts     — /soul
 *   soul-proactive.ts — auto-insight generation
 */

import { createServer, IncomingMessage, ServerResponse } from 'http'
import { soulConfig } from './persistence.ts'

const SOUL_API_PORT = parseInt(process.env.SOUL_PORT || '18800', 10)

// ═══════════════════════════════════════════════════════════════════════════════
// LLM CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

interface LLMConfig { api_base: string; api_key: string; model: string }
let llmConfig: LLMConfig | null = null

export function configureLLM(config: LLMConfig) {
  llmConfig = config
  import('./cli.ts').then(({ setFallbackApiConfig }) => {
    setFallbackApiConfig({
      backend: 'openai-compatible' as any, cli_command: '', cli_args: [],
      api_base: config.api_base, api_key: config.api_key, api_model: config.model, max_concurrent: 8,
    })
  }).catch(() => {})
  console.log(`[cc-soul] LLM configured: ${config.model} @ ${config.api_base}`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// INIT + HEARTBEAT
// ═══════════════════════════════════════════════════════════════════════════════

let heartbeatTimer: ReturnType<typeof setInterval> | null = null

export async function initSoulEngine() {
  try { (await import('./persistence.ts')).ensureDataDir() } catch {}
  try { (await import('./memory.ts')).ensureSQLiteReady() } catch {}
  try { (await import('./features.ts')).loadFeatures() } catch {}
  try { (await import('./user-profiles.ts')).loadProfiles() } catch {}

  // LLM: env vars > OpenClaw config > POST /config
  const envBase = process.env.LLM_API_BASE
  const envKey = process.env.LLM_API_KEY
  const envModel = process.env.LLM_MODEL
  if (envBase && envKey) {
    configureLLM({ api_base: envBase, api_key: envKey, model: envModel || 'gpt-4o' })
  } else {
    try { (await import('./cli.ts')).loadAIConfig(); console.log('[cc-soul] LLM auto-detected') } catch {}
  }

  // Heartbeat (30 min)
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(async () => {
      try { (await import('./handler-heartbeat.ts')).runHeartbeat() } catch (e: any) { console.log(`[cc-soul][heartbeat] ${e.message}`) }
    }, 30 * 60 * 1000)
    setTimeout(async () => {
      try { (await import('./handler-heartbeat.ts')).runHeartbeat() } catch {}
    }, 5 * 60 * 1000)
    console.log(`[cc-soul] heartbeat scheduled`)
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
      if (url === '/health') {
        res.writeHead(200); res.end(JSON.stringify({ status: 'ok', port: SOUL_API_PORT, version: '1.0.0' })); return
      }

      const body = req.method === 'POST' ? JSON.parse(await readBody(req)) : {}

      // ── Core endpoints ──
      if (url === '/process' && req.method === 'POST') {
        const { handleProcess } = await import('./soul-process.ts')
        const result = await handleProcess(body)
        res.writeHead(result.error ? 400 : 200); res.end(JSON.stringify(result)); return
      }

      if (url === '/feedback' && req.method === 'POST') {
        const { handleFeedback } = await import('./soul-process.ts')
        const result = await handleFeedback(body)
        res.writeHead(result.error ? 400 : 200); res.end(JSON.stringify(result)); return
      }

      if (url === '/soul' && req.method === 'POST') {
        const { handleSoul } = await import('./soul-reply.ts')
        const result = await handleSoul(body)
        res.writeHead(result.error ? 400 : 200); res.end(JSON.stringify(result)); return
      }

      // ── Config ──
      if (url === '/config' && req.method === 'POST') {
        if (!body.api_base || !body.api_key || !body.model) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'need api_base, api_key, model' })); return
        }
        configureLLM(body)
        res.writeHead(200); res.end(JSON.stringify({ ok: true, model: body.model })); return
      }

      // ── Profile ──
      if (url === '/profile') {
        const userId = soulConfig.owner_open_id || 'default'
        const { getAvatarStats, loadAvatarProfile } = await import('./avatar.ts')
        const profile = loadAvatarProfile(userId)
        const stats = getAvatarStats(userId)
        let pm: any = {}; try { pm = (await import('./person-model.ts')).getPersonModel() } catch {}
        const { body: bodyState } = await import('./body.ts')
        res.writeHead(200); res.end(JSON.stringify({
          avatar: stats,
          social: Object.entries(profile.social || {}).map(([name, c]: [string, any]) => ({ name, relation: c.relation, samples: (c.samples || []).length })),
          identity: pm.identity || '', thinkingStyle: pm.thinkingStyle || '', values: pm.values || [],
          vocabulary: profile.vocabulary || {}, mood: bodyState.mood, energy: bodyState.energy,
        })); return
      }

      // ── Features ──
      if (url === '/features' && req.method === 'GET') {
        res.writeHead(200); res.end(JSON.stringify((await import('./features.ts')).getAllFeatures())); return
      }
      if (url === '/features' && req.method === 'POST') {
        const { setFeature, isEnabled } = await import('./features.ts')
        setFeature(body.feature, !!body.enabled)
        res.writeHead(200); res.end(JSON.stringify({ feature: body.feature, enabled: isEnabled(body.feature) })); return
      }

      // ── Command ──
      if (url === '/command' && req.method === 'POST') {
        const { routeCommand } = await import('./handler-commands.ts')
        const { getSessionState } = await import('./handler-state.ts')
        const session = getSessionState(body.user_id || 'default')
        let replyText = ''
        const mockCtx = { bodyForAgent: '', reply: (t: string) => { replyText = t } }
        const handled = routeCommand(body.message || '', mockCtx, session, body.user_id || '', '', { context: { senderId: body.user_id || '' } })
        res.writeHead(200); res.end(JSON.stringify({ handled, reply: replyText || (handled ? '(done)' : '(not a command)') })); return
      }

      // ── A2A ──
      if (url === '/.well-known/agent.json' && req.method === 'GET') {
        try {
          const { getAgentCard } = await import('./a2a.ts')
          res.writeHead(200); res.end(JSON.stringify(getAgentCard())); return
        } catch { res.writeHead(404); res.end(JSON.stringify({ error: 'a2a not available' })); return }
      }
      if (url === '/a2a' && req.method === 'POST') {
        try {
          const { handleA2ARequest } = await import('./a2a.ts')
          const result = await handleA2ARequest(body)
          res.writeHead(200); res.end(JSON.stringify(result)); return
        } catch (e: any) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); return }
      }

      // ── MCP ──
      if (url === '/mcp/tools' && req.method === 'GET') {
        try {
          const { getMCPTools } = await import('./mcp-provider.ts')
          res.writeHead(200); res.end(JSON.stringify(getMCPTools().map(t => ({ name: t.name, description: t.description })))); return
        } catch { res.writeHead(404); res.end(JSON.stringify({ error: 'mcp not available' })); return }
      }
      if (url === '/mcp/call' && req.method === 'POST') {
        try {
          const { getMCPTools } = await import('./mcp-provider.ts')
          const tool = getMCPTools().find(t => t.name === (body.tool || body.name))
          if (!tool) { res.writeHead(400); res.end(JSON.stringify({ error: `unknown tool` })); return }
          res.writeHead(200); res.end(JSON.stringify({ tool: tool.name, result: tool.handler(body.args || {}) })); return
        } catch (e: any) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); return }
      }

      // ── 404 ──
      res.writeHead(404); res.end(JSON.stringify({
        error: 'not found',
        endpoints: {
          'POST /process': '处理消息 → 返回增强上下文', 'POST /feedback': 'AI回复反馈 → 学习',
          'POST /soul': '灵魂模式回复', 'POST /config': '配置LLM',
          'GET  /profile': '人格档案', 'GET  /features': '功能开关', 'POST /features': '切换功能',
          'POST /command': '执行命令', 'GET  /health': '健康检查',
          'GET  /.well-known/agent.json': 'A2A', 'POST /a2a': 'A2A',
          'GET  /mcp/tools': 'MCP工具', 'POST /mcp/call': 'MCP调用',
        },
      }))
    } catch (e: any) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }))
    }
  })

  server.listen(SOUL_API_PORT, '0.0.0.0', () => {
    console.log(`\n  cc-soul Engine API — http://0.0.0.0:${SOUL_API_PORT}\n`)
  })
  server.on('error', (e: any) => {
    if (e.code === 'EADDRINUSE') console.log(`[cc-soul] port ${SOUL_API_PORT} in use`)
    else console.error(`[cc-soul] error: ${e.message}`)
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
// STANDALONE ENTRY
// ═══════════════════════════════════════════════════════════════════════════════

const isMain = typeof process !== 'undefined' && process.argv[1]?.endsWith('soul-api.ts')
if (isMain) {
  console.log('[cc-soul] Standalone mode')
  initSoulEngine().then(() => startSoulApi())
}
