/**
 * plugin-entry.ts — OpenClaw Adapter for cc-soul (Hybrid Mode)
 *
 * Primary: Context Engine interface (assemble/afterTurn — reliable, first-class)
 * Fallback: Hooks + SOUL.md file writing (for older OpenClaw versions)
 * External: Soul API (:18800) for Feishu/other AI/third-party HTTP access
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'

const SOUL_API = process.env.SOUL_API || 'http://localhost:18800'

// ── Dedup state (module-level, no need for globalThis) ──
let _lastProcessed = ''
let _lastProcessedTs = 0
let _lastMsg = ''
let _lastSenderId = ''

// ── Feedback dedup: track sent feedback by content hash ──
const _sentFeedbackHashes = new Set<string>()
const FEEDBACK_DEDUP_MAX = 200

function _feedbackHash(userMsg: string, aiReply: string): string {
  return createHash('md5').update(userMsg.slice(0, 100) + '||' + aiReply.slice(0, 200)).digest('hex')
}

function _markFeedbackSent(userMsg: string, aiReply: string): boolean {
  const h = _feedbackHash(userMsg, aiReply)
  if (_sentFeedbackHashes.has(h)) return false
  if (_sentFeedbackHashes.size >= FEEDBACK_DEDUP_MAX) {
    const keep = [..._sentFeedbackHashes].slice(-100)
    _sentFeedbackHashes.clear()
    keep.forEach(k => _sentFeedbackHashes.add(k))
  }
  _sentFeedbackHashes.add(h)
  return true
}

// ── Plugin API reference ──
let _api: any | undefined
export function getPluginApi() { return _api }

// ── Exports kept for backward compatibility ──
export function updatePluginStats(_s: any) {}
export function setSoulDynamicLock(_ms?: number) {}

// ── Context engine registration state ──
let _contextEngineRegistered = false

export default {
  id: 'cc-soul',
  name: 'cc-soul',
  description: 'Soul engine for AI — memory, personality, cognition, emotion',
  kind: 'context-engine' as const,
  configSchema: {},

  register(api: any) {
    _api = api
    const log = api.logger || console
    const t0 = Date.now()

    // ═══════════════════════════════════════════════════════════════
    // 1. Try Context Engine registration (primary, reliable path)
    // ═══════════════════════════════════════════════════════════════

    import('./context-engine.ts').then(async (mod) => {
      // Initialize soul engine first (loads memories, starts subsystems)
      try {
        const { initSoulEngine } = await import('./soul-api.ts')
        await initSoulEngine()
      } catch (e: any) {
        console.error(`[cc-soul] soul engine init failed: ${e.message}`)
      }

      // Context Engine 注册已移除——cc-soul 只通过独立 API (soul-api.ts) 提供记忆
      // 学 Mem0：记忆系统是被调用的 API，不嵌入宿主平台内部
      // 调用方通过 POST /api {"action":"process"} 获取 system_prompt + augments
      console.log(`[cc-soul] 独立 API 模式（不注册 Context Engine）`)

      // Start soul-api for external access (Feishu, other AI, HTTP clients)
      try {
        const { startSoulApi } = await import('./soul-api.ts')
        startSoulApi()
        console.log(`[cc-soul] Soul API started (${SOUL_API}) for external access`)
      } catch (e: any) {
        console.log(`[cc-soul] Soul API start failed: ${e.message} (external access unavailable)`)
      }
    }).catch((e: any) => {
      console.error(`[cc-soul] context-engine load failed: ${e.message}, falling back to pure API mode`)
      // Fallback: start soul-api as before
      _startSoulApiFallback()
    })

    // ═══════════════════════════════════════════════════════════════
    // 2. Hooks — preprocessed always runs (augment prep for assemble)
    //    message:sent only needed as backup when context-engine unavailable
    // ═══════════════════════════════════════════════════════════════

    try {
      // ── Preprocessed: prepare augments + handle commands ──
      api.registerHook(['message:preprocessed'], async (event: any) => {
        const ctx = event.context || {}
        const rawMsg = (ctx.body || '')
          .replace(/^\[Feishu[^\]]*\]\s*/i, '')
          .replace(/^\[message_id:\s*\S+\]\s*/i, '')
          .replace(/^[a-zA-Z0-9_\u4e00-\u9fff]{1,20}:\s*/, '')
          .replace(/^\n+/, '').trim()
        const senderId = ctx.senderId || ''
        if (!rawMsg) return

        // Dedup: skip if this exact event was processed within 3s
        const msgKey = rawMsg.slice(0, 50) + ':' + senderId
        const now = Date.now()
        if (_lastProcessed === msgKey && now - _lastProcessedTs < 3000) return
        _lastProcessed = msgKey
        _lastProcessedTs = now

        // Pass sender context to context-engine
        try {
          const { setLastSenderId } = await import('./context-engine.ts')
          setLastSenderId(senderId)
        } catch {}

        // If context-engine is active, let it handle via assemble()
        // Still call /process to trigger command detection + augment building
        try {
          const resp = await fetch(`${SOUL_API}/process`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: rawMsg, user_id: senderId }),
          })
          const data = await resp.json()

          // Command: always write to SOUL.md (commands need immediate relay)
          if (data.command && data.command_reply) {
            const soulPath = resolve(homedir(), '.openclaw/workspace/SOUL.md')
            const basePrompt = data.system_prompt || ''
            const cmdBlock = `\n\n## 内部指令（仅本轮有效，最高优先级）\n用户输入了系统命令"${rawMsg}"。以下是命令执行结果，请原样转发给用户，保持全部格式，不要添加任何额外内容：\n\n${data.command_reply}`
            writeFileSync(soulPath, basePrompt + cmdBlock, 'utf-8')
            console.log(`[cc-soul] command → SOUL.md (${data.command_reply.length} chars)`)
            return
          }

          // Context Engine 推送已移除——cc-soul 独立 API 模式

          // Fallback: if context-engine NOT registered, write SOUL.md as before
          if (!_contextEngineRegistered && (data.system_prompt || data.augments)) {
            const soulPath = resolve(homedir(), '.openclaw/workspace/SOUL.md')
            const MAX_SOUL_CHARS = 6000
            let augmentStr = data.augments || ''
            const baseLen = (data.system_prompt || '').length
            if (baseLen + augmentStr.length > MAX_SOUL_CHARS) {
              const budget = MAX_SOUL_CHARS - baseLen - 50
              if (budget > 200) {
                augmentStr = augmentStr.slice(0, budget)
                const lastNewline = augmentStr.lastIndexOf('\n')
                if (lastNewline > 100) augmentStr = augmentStr.slice(0, lastNewline)
              } else {
                augmentStr = ''
              }
            }
            const fullPrompt = data.system_prompt
              ? data.system_prompt + (augmentStr ? '\n\n## 内部指令（仅本轮有效）\n' + augmentStr : '')
              : augmentStr
            writeFileSync(soulPath, fullPrompt, 'utf-8')
            console.log(`[cc-soul] SOUL.md updated (${fullPrompt.length} chars, fallback mode)`)
          }

          // Store for feedback
          _lastMsg = rawMsg
          _lastSenderId = senderId
        } catch (e: any) {
          console.log(`[cc-soul] process: ${e.message}`)
        }
      }, { name: 'cc-soul:preprocessed' })

      // ── Sent: feedback (only when context-engine NOT active) ──
      api.registerHook(['message:sent'], async (event: any) => {
        // Context engine handles feedback via afterTurn() — skip hook
        if (_contextEngineRegistered) return

        const content = (event.context?.content || event.content || event.text || '') as string
        const lastMsg = _lastMsg
        const lastSenderId = _lastSenderId
        if (!lastMsg || !content || content.length < 5) return

        if (!_markFeedbackSent(lastMsg, content)) return
        try {
          await fetch(`${SOUL_API}/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_message: lastMsg, ai_reply: content, user_id: lastSenderId }),
          })
          console.log(`[cc-soul] feedback sent (hook fallback)`)
        } catch {}
      }, { name: 'cc-soul:sent' })

      // ── Commands: route through /command API ──
      if (typeof api.on === 'function') {
        api.on('inbound_claim', async (event: any, _ctx: any) => {
          const content = (event?.content || event?.body || '').trim()
          if (!content) return
          try {
            const senderId = event?.senderId || event?.context?.senderId || ''
            const cmdResp = await fetch(`${SOUL_API}/command`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: content, user_id: senderId }),
            })
            const cmdData = await cmdResp.json()
            if (cmdData.handled && cmdData.reply && cmdData.reply !== '(done)') {
              return { handled: true, reply: cmdData.reply }
            }
            if (cmdData.handled) return { handled: true }
          } catch {}
        })
      }

    } catch (e: any) {
      console.error(`[cc-soul] hook registration failed: ${e.message}`)
    }

    // ── Boot notification ──
    const bootLockPath = resolve(homedir(), '.openclaw/plugins/cc-soul/data/.boot-lock')
    const now = Date.now()
    let shouldNotify = true
    try {
      if (existsSync(bootLockPath)) {
        const lockTs = parseInt(readFileSync(bootLockPath, 'utf-8').trim(), 10)
        if (now - lockTs < 5 * 60 * 1000) shouldNotify = false
      }
    } catch {}
    if (shouldNotify) {
      try { writeFileSync(bootLockPath, String(now), 'utf-8') } catch {}
      setTimeout(async () => {
        const mode = _contextEngineRegistered ? 'Context Engine' : 'Hook + SOUL.md'
        console.log(`[cc-soul] boot complete — mode: ${mode}, API: ${SOUL_API}`)
      }, 3000)
    }

    log.info(`[cc-soul] register() done in ${Date.now() - t0}ms`)
  },
}

// ── Fallback: pure API mode (when context-engine fails to load) ──
function _startSoulApiFallback() {
  fetch(`${SOUL_API}/health`).then(r => r.json()).then(d => {
    if (d.status === 'ok') console.log(`[cc-soul] Soul API already running (fallback)`)
  }).catch(() => {
    console.log(`[cc-soul] Soul API not running, auto-starting (fallback)...`)
    import('./soul-api.ts').then(async ({ initSoulEngine, startSoulApi }) => {
      await initSoulEngine()
      startSoulApi()
    }).catch((e: any) => {
      console.error(`[cc-soul] Failed to auto-start Soul API: ${e.message}`)
    })
  })
}
