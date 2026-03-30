/**
 * plugin-entry.ts — OpenClaw Plugin Entry Point for cc-soul
 *
 * LIGHTWEIGHT registration only. OpenClaw creates a new JS context per message,
 * so register() runs on every single message. All heavy initialization (memory
 * loading, brain module registration, etc.) is deferred to handler.ts initializeSoul()
 * which runs when the first actual message arrives.
 *
 * register() target: < 200ms (was 4-5 seconds with full init)
 */

// ── Minimal imports for registration (no brain modules, no optional modules) ──
import { createCcSoulContextEngine, setStatsAccessor, setLastSenderId } from './context-engine.ts'
import { ensureDataDir } from './persistence.ts'
import { buildSoulPrompt } from './prompt-builder.ts'
import { taskState } from './tasks.ts'

import { writeFileSync, existsSync, readFileSync } from 'fs'
import { mkdirSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'

// ── Plugin API reference (available after register()) ──
let _api: any /* OpenClawPluginApi */ | undefined

export function getPluginApi(): any /* OpenClawPluginApi */ | undefined {
  return _api
}

// ── Stats (mirrored from handler.ts for context engine stats accessor) ──
const stats = {
  totalMessages: 0,
  corrections: 0,
  firstSeen: 0,
}

export function updatePluginStats(s: { totalMessages: number; corrections: number; firstSeen: number }) {
  stats.totalMessages = s.totalMessages
  stats.corrections = s.corrections
  stats.firstSeen = s.firstSeen
}

// ── SOUL.md file writer — inject soul prompt via OpenClaw's bootstrap-extra-files ──

let _soulDynamicLockUntil = 0  // timestamp: don't overwrite SOUL.md until this time

export function setSoulDynamicLock(durationMs = 30000) {
  _soulDynamicLockUntil = Date.now() + durationMs
}

function writeSoulFile() {
  // Skip if handler just wrote dynamic augments (avoid overwriting)
  if (Date.now() < _soulDynamicLockUntil) {
    console.log(`[cc-soul] SOUL.md write skipped (dynamic lock active)`)
    return
  }
  try {
    const soulPrompt = buildSoulPrompt(
      stats.totalMessages, stats.corrections, stats.firstSeen,
      taskState.workflows,
    )
    const workspaceDir = resolve(homedir(), '.openclaw/workspace')
    const soulPath = resolve(workspaceDir, 'SOUL.md')
    writeFileSync(soulPath, soulPrompt, 'utf-8')
    console.log(`[cc-soul] SOUL.md written to ${workspaceDir} (${soulPrompt.length} chars)`)
  } catch (e: any) {
    console.error(`[cc-soul] failed to write SOUL.md: ${e.message}`)
  }
}

// ── Auto-create hook bridge in ~/.openclaw/hooks/ ──

function ensureHookBridge() {
  try {
    const bridgeDir = resolve(homedir(), '.openclaw/hooks/cc-soul-hook/cc-soul-hook')
    const bridgePkg = resolve(homedir(), '.openclaw/hooks/cc-soul-hook/package.json')
    const bridgeHook = resolve(bridgeDir, 'HOOK.md')
    const bridgeHandler = resolve(bridgeDir, 'handler.ts')

    if (existsSync(bridgeHandler)) return // already created

    mkdirSync(bridgeDir, { recursive: true })

    writeFileSync(bridgePkg, JSON.stringify({
      name: 'cc-soul-hook',
      version: '1.0.0',
      type: 'module',
      openclaw: { hooks: ['./cc-soul-hook'] }
    }, null, 2))

    writeFileSync(bridgeHook, `---
name: cc-soul-hook
metadata:
  openclaw:
    events:
      - agent:bootstrap
      - message:preprocessed
      - message:sent
      - command:new
---
cc-soul hook bridge — auto-created by cc-soul plugin
`)

    const pluginDir = resolve(homedir(), '.openclaw/plugins/cc-soul')
    writeFileSync(bridgeHandler, `// Auto-generated hook bridge for cc-soul plugin
let loaded = false
let fns: any = {}

async function load() {
  if (loaded) return
  try {
    const mod = await import('${pluginDir}/cc-soul/handler.ts')
    fns = mod
    loaded = true
  } catch (e: any) {
    console.error('[cc-soul-hook] load failed:', e.message)
  }
}

export default async function handler(event: any) {
  await load()
  if (!loaded) return
  if (event.type === 'agent' && event.action === 'bootstrap') fns.handleBootstrap?.(event)
  else if (event.type === 'message' && event.action === 'preprocessed') fns.handlePreprocessed?.(event)
  else if (event.type === 'message' && event.action === 'sent') fns.handleSent?.(event)
  else if (event.type === 'command') fns.handleCommand?.(event)
}
`)

    console.log('[cc-soul] hook bridge auto-created at ~/.openclaw/hooks/cc-soul-hook/')
  } catch (e: any) {
    console.error(`[cc-soul] hook bridge creation failed: ${e.message}`)
  }
}

// ── Plugin Entry ──

export default {
  id: 'cc-soul',
  name: 'cc-soul',
  description: 'Soul layer for OpenClaw — memory, personality, context engine, and autonomous lifecycle',
  kind: 'context-engine' as const,
  configSchema: {},

  register(api: any /* OpenClawPluginApi */) {
    _api = api
    const log = api.logger || console
    const t0 = Date.now()

    // ── Lightweight registration only ──
    // OpenClaw creates a new JS context per message, so register() runs every time.
    // All heavy init (memory loading, brain modules) is deferred to handler.ts
    // initializeSoul() which runs on first actual message via hook handlers.
    // This keeps register() fast (target < 200ms).

    // 1. Data directory (mkdir, ~1ms)
    ensureDataDir()

    // 2. Wire stats accessor for context engine's assemble()
    setStatsAccessor(() => stats)

    // 3. Register context engine (just registration, no data loading)
    // Register context engine (once)
    if (!(globalThis as any).__ccSoulContextEngineRegistered) {
      try {
        api.registerContextEngine('cc-soul', () => createCcSoulContextEngine())
        ;(globalThis as any).__ccSoulContextEngineRegistered = true
        console.log(`[cc-soul] context engine registered`)
      } catch (e: any) {
        console.error(`[cc-soul] registerContextEngine FAILED: ${e.message}`)
      }
    }

    // Also try registerMemoryPromptSection — new API for injecting into system prompt
    if (typeof api.registerMemoryPromptSection === 'function') {
      try {
        api.registerMemoryPromptSection('cc-soul', async (params: any) => {
          // This gets called before each agent turn — inject augments here
          try {
            const { buildAndSelectAugments } = await import('./handler-augments.ts')
            const { getSessionState, getLastActiveSessionKey } = await import('./handler-state.ts')
            const { cogProcess } = await import('./cognition.ts')
            const { updateFlow } = await import('./flow.ts')

            const sessionKey = getLastActiveSessionKey()
            const session = getSessionState(sessionKey)
            const userMsg = params?.userMessage || session.lastPrompt || ''
            if (!userMsg) return { content: '' }

            const cog = cogProcess(userMsg, session.lastResponseContent)
            const flow = updateFlow(userMsg, session.lastResponseContent, sessionKey)
            const { selected } = await buildAndSelectAugments({
              userMsg, session,
              senderId: session.lastSenderId || '',
              channelId: session.lastChannelId || '',
              cog, flow, flowKey: sessionKey,
              followUpHints: [],
              workingMemKey: sessionKey,
            })

            if (selected.length > 0) {
              const cleaned = selected.map(s => s.replace(/^\[([^\]]+)\]\s*/, ''))
              // Ensure 举一反三 reminder with few-shot example at end of augments
              const hasExtraThink = cleaned.some(s => s.includes('顺便说一下') || s.includes('举一反三'))
              const reminder = hasExtraThink
                ? '\n\n📌 回复结尾固定格式（照做）：\n顺便说一下：\n1. 第一条补充（一句话）\n2. 第二条补充（不同角度）\n不要追问。'
                : ''
              console.log(`[cc-soul][memoryPromptSection] injecting ${cleaned.length} augments`)
              return { content: cleaned.join('\n') + reminder }
            }
          } catch (e: any) {
            console.error(`[cc-soul][memoryPromptSection] error: ${e.message}`)
          }
          return { content: '' }
        })
        console.log(`[cc-soul] registerMemoryPromptSection registered`)
      } catch (e: any) {
        console.log(`[cc-soul] registerMemoryPromptSection not available: ${e.message}`)
      }
    }

    // 4. Write SOUL.md (synchronous file write, ~5ms)
    writeSoulFile()

    // 5. Auto-create hook bridge (existsSync check + early return, ~1ms)
    ensureHookBridge()

    // 6. Register hooks (all handlers use dynamic import → no eager loading)
    try {
      api.registerHook(['agent:bootstrap'], async (_event: any) => {
        // SOUL.md already written in register(). handler.ts handles the rest.
      }, { name: 'cc-soul:bootstrap' })

      api.registerHook(['message:preprocessed'], async (event: any) => {
        if (event?.context?.senderId) setLastSenderId(String(event.context.senderId))
        const { handlePreprocessed } = await import('./handler.ts')
        await handlePreprocessed(event)
      }, { name: 'cc-soul:preprocessed' })

      api.registerHook(['message:sent'], async (event: any) => {
        const { handleSent } = await import('./handler.ts')
        handleSent(event)
      }, { name: 'cc-soul:sent' })

      // Plugin hooks (message_sent with underscore)
      if (typeof api.on === 'function') {
        api.on('message_sent', async (event: any, ctx: any) => {
          const content = event?.content || event?.text || ''
          if (!content) return
          import('./handler-state.ts').then(({ getSessionState, getLastActiveSessionKey }) => {
            const sk = ctx?.sessionKey || getLastActiveSessionKey()
            const sess = getSessionState(sk)
            if (sess) {
              sess.lastResponseContent = content
              console.log(`[cc-soul][plugin-hook] message_sent: synced response (${content.length} chars)`)
            }
          }).catch(() => {})
          import('./handler.ts').then(({ handleSent }) => {
            handleSent({ ...event, context: { ...(event?.context || {}), body: content }, sessionKey: ctx?.sessionKey })
          }).catch(() => {})
        })
      }

      // inbound_claim: intercept cc-soul commands before they reach AI
      if (typeof api.on === 'function') {
        api.on('inbound_claim', async (event: any, _ctx: any) => {
          const content = (event?.content || event?.body || '').trim()
          if (!content) return
          const { isCommand, handleCommandInbound } = await import('./handler-commands.ts')
          if (isCommand(content)) {
            const cfg = api.config || {}
            const senderId = event?.senderId || event?.context?.senderId || ''
            const chatId = event?.conversationId || event?.context?.chatId || ''
            const to = chatId ? `group:${chatId}` : (senderId ? `user:${senderId}` : '')
            const handled = await handleCommandInbound(content, to, cfg, event)
            if (handled) return { handled: true }
          }
        })
      }

      api.registerHook(['command:new'], async (event: any) => {
        const { handleCommand } = await import('./handler.ts')
        handleCommand(event)
      }, { name: 'cc-soul:command' })
    } catch (e: any) {
      console.error(`[cc-soul] hook registration failed: ${e.message}`)
    }

    // 7. A2A HTTP routes (deferred via dynamic import)
    if (typeof api.registerHttpRoute === 'function') {
      import('./a2a.ts').then(({ getAgentCard, handleA2ARequest }) => {
        api.registerHttpRoute({
          path: '/a2a/cc-soul/.well-known/agent.json',
          auth: 'gateway',
          handler: (_req: any, res: any) => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(getAgentCard()))
          },
        })
        api.registerHttpRoute({
          path: '/a2a/cc-soul/invoke',
          auth: 'gateway',
          handler: async (req: any, res: any) => {
            const chunks: Buffer[] = []
            for await (const chunk of req) chunks.push(chunk as Buffer)
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString())
              const result = await handleA2ARequest(body)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify(result))
            } catch (e: any) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ status: 'error', data: e.message }))
            }
          },
        })
      }).catch((e: any) => { console.error(`[cc-soul] A2A route registration failed: ${e.message}`) })
    }

    // 8. Slash commands + MCP tools (deferred via dynamic import)
    import('./plugin-commands.ts').then(({ registerPluginCommands }) => {
      registerPluginCommands(api)
    }).catch((e: any) => { console.error(`[cc-soul] slash command registration failed: ${e.message}`) })

    import('./mcp-provider.ts').then(({ getMCPTools }) => {
      for (const tool of getMCPTools()) {
        if (typeof api.registerTool === 'function') {
          api.registerTool(tool.name, tool.handler, { description: tool.description })
        }
      }
    }).catch(() => { /* MCP not supported — silently skip */ })

    // 9. Boot notification (file-lock guarded, 5min cooldown)
    const bootLockPath = resolve(homedir(), '.openclaw/plugins/cc-soul/data/.boot-lock')
    const now = Date.now()
    let shouldNotify = true
    try {
      if (existsSync(bootLockPath)) {
        const lockTs = parseInt(readFileSync(bootLockPath, 'utf-8').trim(), 10)
        if (now - lockTs < 5 * 60 * 1000) shouldNotify = false
      }
    } catch (_) {}

    if (shouldNotify) {
      try { writeFileSync(bootLockPath, String(now), 'utf-8') } catch (_) {}
      setTimeout(() => {
        Promise.all([
          import('./notify.ts'),
          import('./user-profiles.ts'),
          import('./persistence.ts'),
        ]).then(([{ notifyOwnerDM }, { getProfile }, { soulConfig: cfg }]) => {
          const lang = getProfile(cfg.owner_open_id || '')?.language || 'zh'
          const greetings: Record<string, string> = {
            zh: `cc-soul 已就绪`,
            en: `cc-soul ready`,
            ja: `cc-soul 準備完了`,
          }
          const msg = greetings[lang] || greetings.zh
          console.log(`[cc-soul][boot] sending startup notify: ${msg}`)
          notifyOwnerDM(msg)
        }).catch((e: any) => { console.error(`[cc-soul][boot] startup notify failed: ${e.message}`) })
      }, 5000)
    }

    log.info(`[cc-soul] register() done in ${Date.now() - t0}ms`)
  },
}
