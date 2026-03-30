/**
 * plugin-entry.ts — OpenClaw Adapter for cc-soul (Pure API Mode)
 *
 * Thin adapter: connects OpenClaw events to cc-soul API (localhost:18800).
 * Zero source code imports from engine modules. Only fetch calls.
 *
 * Soul API must be running separately: npx tsx cc-soul/soul-api.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'

const SOUL_API = process.env.SOUL_API || 'http://localhost:18800'

// ── Feedback dedup: track sent feedback by content hash ──
const _sentFeedbackHashes = new Set<string>()
const FEEDBACK_DEDUP_MAX = 200  // prevent unbounded growth

function _feedbackHash(userMsg: string, aiReply: string): string {
  return createHash('md5').update(userMsg.slice(0, 100) + '||' + aiReply.slice(0, 200)).digest('hex')
}

function _markFeedbackSent(userMsg: string, aiReply: string): boolean {
  const h = _feedbackHash(userMsg, aiReply)
  if (_sentFeedbackHashes.has(h)) return false  // already sent
  if (_sentFeedbackHashes.size >= FEEDBACK_DEDUP_MAX) {
    // evict oldest entries (Set iterates in insertion order)
    const it = _sentFeedbackHashes.values()
    for (let i = 0; i < 50; i++) it.next()
    // cheaper: just clear half
    const keep = [..._sentFeedbackHashes].slice(-100)
    _sentFeedbackHashes.clear()
    keep.forEach(k => _sentFeedbackHashes.add(k))
  }
  _sentFeedbackHashes.add(h)
  return true  // first time, ok to send
}

// ── Plugin API reference ──
let _api: any | undefined
export function getPluginApi() { return _api }

// ── Exports kept for backward compatibility (other modules may import these) ──
export function updatePluginStats(_s: any) {}
export function setSoulDynamicLock(_ms?: number) {}

export default {
  id: 'cc-soul',
  name: 'cc-soul',
  description: 'Soul engine for AI — memory, personality, cognition, emotion (API mode)',
  kind: 'context-engine' as const,
  configSchema: {},

  register(api: any) {
    _api = api
    const log = api.logger || console
    const t0 = Date.now()

    // ═══════════════════════════════════════════════════════════════
    // All logic runs in soul-api.ts (separate process on :18800).
    // This plugin only does fetch calls to forward OpenClaw events.
    // ═══════════════════════════════════════════════════════════════

    // Auto-start soul-api if not running
    fetch(`${SOUL_API}/health`).then(r => r.json()).then(d => {
      if (d.status === 'ok') console.log(`[cc-soul] Soul API already running`)
    }).catch(() => {
      console.log(`[cc-soul] Soul API not running, auto-starting...`)
      import('./soul-api.ts').then(async ({ initSoulEngine, startSoulApi }) => {
        await initSoulEngine()  // auto-detects OpenClaw LLM config
        startSoulApi()
      }).catch((e: any) => {
        console.error(`[cc-soul] Failed to auto-start Soul API: ${e.message}`)
      })
    })

    try {
      // ── Bootstrap: get system_prompt from API, write to SOUL.md ──
      api.registerHook(['agent:bootstrap'], async (_event: any) => {
        try {
          const resp = await fetch(`${SOUL_API}/process`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: '', user_id: '' }),
          })
          const data = await resp.json()
          if (data.system_prompt) {
            const soulPath = resolve(homedir(), '.openclaw/workspace/SOUL.md')
            writeFileSync(soulPath, data.system_prompt, 'utf-8')
            console.log(`[cc-soul][api] bootstrap: SOUL.md written (${data.system_prompt.length} chars)`)
          }
        } catch (e: any) {
          console.log(`[cc-soul][api] bootstrap: ${e.message}`)
        }
      }, { name: 'cc-soul:bootstrap' })

      // ── Preprocessed: commands go to source, everything else goes to API ──
      api.registerHook(['message:preprocessed'], async (event: any) => {
        const ctx = event.context || {}
        const rawMsg = (ctx.body || '')
          .replace(/^\[Feishu[^\]]*\]\s*/i, '')
          .replace(/^\[message_id:\s*\S+\]\s*/i, '')
          .replace(/^[a-zA-Z0-9_\u4e00-\u9fff]{1,20}:\s*/, '')
          .replace(/^\n+/, '').trim()
        const senderId = ctx.senderId || ''
        if (!rawMsg) return

        // Dedup: skip if we already processed this message
        const msgKey = rawMsg.slice(0, 50) + ':' + senderId
        if ((globalThis as any).__ccSoulLastProcessed === msgKey) return
        ;(globalThis as any).__ccSoulLastProcessed = msgKey

        // Commands go through /command API endpoint (no direct engine imports)
        try {
          const cmdResp = await fetch(`${SOUL_API}/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: rawMsg, user_id: senderId }),
          })
          const cmdData = await cmdResp.json()
          if (cmdData.handled) {
            if (cmdData.reply && ctx.reply) ctx.reply(cmdData.reply)
            return  // command handled, skip API
          }
        } catch {}

        // Non-commands go through API
        try {
          const resp = await fetch(`${SOUL_API}/process`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: rawMsg, user_id: senderId }),
          })
          const data = await resp.json()

          // Write augments into SOUL.md (only reliable injection path)
          if (data.system_prompt || data.augments) {
            const soulPath = resolve(homedir(), '.openclaw/workspace/SOUL.md')
            const fullPrompt = data.system_prompt
              ? data.system_prompt + (data.augments ? '\n\n## 内部指令（仅本轮有效）\n' + data.augments : '')
              : data.augments
            writeFileSync(soulPath, fullPrompt, 'utf-8')
            console.log(`[cc-soul][api] SOUL.md updated (${fullPrompt.length} chars)`)
          }

          // Store for feedback
          ;(globalThis as any).__ccSoulLastMsg = rawMsg
          ;(globalThis as any).__ccSoulLastSenderId = senderId
        } catch (e: any) {
          console.log(`[cc-soul][api] process: ${e.message}`)
        }
      }, { name: 'cc-soul:preprocessed' })

      // ── Sent: call /feedback so cc-soul learns from AI's reply ──
      // Problem: OpenClaw streaming card replies don't pass content in the event.
      // Solution: try event content first, fallback to reading session JSONL after delay.
      api.registerHook(['message:sent'], async (event: any) => {
        const content = (event.context?.content || event.content || event.text || '') as string
        const lastMsg = (globalThis as any).__ccSoulLastMsg || ''
        const lastSenderId = (globalThis as any).__ccSoulLastSenderId || ''
        if (!lastMsg) return

        if (content && content.length >= 5) {
          // Content available directly — send feedback immediately (with dedup)
          if (!_markFeedbackSent(lastMsg, content)) {
            console.log(`[cc-soul][api] feedback skipped (direct, dedup)`)
            return
          }
          try {
            await fetch(`${SOUL_API}/feedback`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ user_message: lastMsg, ai_reply: content, user_id: lastSenderId }),
            })
            console.log(`[cc-soul][api] feedback sent (direct)`)
          } catch {}
        }
      }, { name: 'cc-soul:sent' })

      // ── message_sent (plugin event) — also feedback ──
      if (typeof api.on === 'function') {
        api.on('message_sent', async (event: any) => {
          const content = event?.content || event?.text || ''
          if (!content || content.length < 5) return
          const lastMsg = (globalThis as any).__ccSoulLastMsg || ''
          const lastSenderId = (globalThis as any).__ccSoulLastSenderId || ''
          if (!lastMsg) return
          if (!_markFeedbackSent(lastMsg, content)) {
            console.log(`[cc-soul][api] feedback skipped (plugin event, dedup)`)
            return
          }
          try {
            await fetch(`${SOUL_API}/feedback`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ user_message: lastMsg, ai_reply: content, user_id: lastSenderId }),
            })
            console.log(`[cc-soul][api] feedback sent (plugin event)`)
          } catch {}
        })
      }

      // ── Delayed fallback: read bot reply from session JSONL (for streaming cards) ──
      api.registerHook(['message:preprocessed'], async (_event: any) => {
        const lastMsg = (globalThis as any).__ccSoulLastMsg
        const lastSenderId = (globalThis as any).__ccSoulLastSenderId
        if (!lastMsg) return

        // Dedup: only one JSONL fallback per message
        const feedbackKey = lastMsg.slice(0, 30) + ':' + lastSenderId
        if ((globalThis as any).__ccSoulLastFeedback === feedbackKey) return
        ;(globalThis as any).__ccSoulLastFeedback = feedbackKey

        setTimeout(async () => {
          try {
            const { readdirSync, readFileSync: rf } = await import('fs')
            const sessDir = resolve(homedir(), '.openclaw/agents/cc/sessions')
            const files = readdirSync(sessDir).filter((f: string) => f.endsWith('.jsonl')).sort()
            if (files.length === 0) return
            const lastFile = resolve(sessDir, files[files.length - 1])
            const lines = rf(lastFile, 'utf-8').trim().split('\n')
            let botReply = ''
            for (let i = lines.length - 1; i >= 0; i--) {
              try {
                const obj = JSON.parse(lines[i])
                if (obj?.message?.role === 'assistant') {
                  botReply = Array.isArray(obj.message.content)
                    ? obj.message.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text || '').join('')
                    : (obj.message.content || '')
                  break
                }
              } catch {}
            }
            if (!botReply || botReply.length < 10) return

            // Dedup: skip if same content already sent via direct or plugin event path
            if (!_markFeedbackSent(lastMsg, botReply)) {
              console.log(`[cc-soul][api] feedback skipped (JSONL fallback, dedup)`)
              return
            }

            await fetch(`${SOUL_API}/feedback`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ user_message: lastMsg, ai_reply: botReply, user_id: lastSenderId }),
            })
            console.log(`[cc-soul][api] feedback sent (JSONL fallback, ${botReply.length} chars)`)
          } catch {}
        }, 45000)
      }, { name: 'cc-soul:delayed-feedback' })

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
        try {
          const health = await fetch(`${SOUL_API}/health`).then(r => r.json())
          if (health.status === 'ok') {
            console.log(`[cc-soul] Soul API connected (${SOUL_API})`)
          }
        } catch {
          console.log(`[cc-soul] Soul API not reachable at ${SOUL_API} — is it running?`)
        }
      }, 3000)
    }

    log.info(`[cc-soul] register() done in ${Date.now() - t0}ms (API mode → ${SOUL_API})`)
  },
}
