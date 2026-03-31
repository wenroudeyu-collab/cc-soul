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

// Lock: when preprocessed writes SOUL.md with augments, block bootstrap from overwriting
let _soulMdLock = 0

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
      // Skip if preprocessed just wrote a richer version (with augments)
      api.registerHook(['agent:bootstrap'], async (_event: any) => {
        if (_soulMdLock > Date.now()) {
          console.log(`[cc-soul][api] bootstrap: skipped (preprocessed lock active)`)
          return
        }
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

        // Dedup: skip if this exact event was processed within 3s (hook registered multiple times)
        // But allow same content re-sent by user after a gap (user intentionally repeats)
        const msgKey = rawMsg.slice(0, 50) + ':' + senderId
        const now = Date.now()
        if ((globalThis as any).__ccSoulLastProcessed === msgKey && now - ((globalThis as any).__ccSoulLastProcessedTs || 0) < 3000) return
        ;(globalThis as any).__ccSoulLastProcessed = msgKey
        ;(globalThis as any).__ccSoulLastProcessedTs = now

        // Everything goes through /process — commands are detected there
        try {
          const resp = await fetch(`${SOUL_API}/process`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: rawMsg, user_id: senderId }),
          })
          const data = await resp.json()

          // Command detected: inject result into SOUL.md for LLM to relay
          if (data.command && data.command_reply) {
            const soulPath = resolve(homedir(), '.openclaw/workspace/SOUL.md')
            const basePrompt = data.system_prompt || ''
            const cmdBlock = `\n\n## 内部指令（仅本轮有效，最高优先级）\n用户输入了系统命令"${rawMsg}"。以下是命令执行结果，请原样转发给用户，保持全部格式，不要添加任何额外内容：\n\n${data.command_reply}`
            writeFileSync(soulPath, basePrompt + cmdBlock, 'utf-8')
            _soulMdLock = Date.now() + 120000
            console.log(`[cc-soul][api] command → SOUL.md (${data.command_reply.length} chars)`)
            return  // SOUL.md written, OpenClaw will read it for LLM
          }

          // Normal message: write augments into SOUL.md
          if (data.system_prompt || data.augments) {
            const soulPath = resolve(homedir(), '.openclaw/workspace/SOUL.md')
            const MAX_SOUL_CHARS = 6000  // keep SOUL.md under 6K for model attention
            let augmentStr = data.augments || ''
            const baseLen = (data.system_prompt || '').length
            if (baseLen + augmentStr.length > MAX_SOUL_CHARS) {
              // Trim augments to fit budget — keep first N lines
              const budget = MAX_SOUL_CHARS - baseLen - 50
              if (budget > 200) {
                augmentStr = augmentStr.slice(0, budget)
                // Cut at last complete line
                const lastNewline = augmentStr.lastIndexOf('\n')
                if (lastNewline > 100) augmentStr = augmentStr.slice(0, lastNewline)
              } else {
                augmentStr = ''  // no room for augments
              }
            }
            const fullPrompt = data.system_prompt
              ? data.system_prompt + (augmentStr ? '\n\n## 内部指令（仅本轮有效）\n' + augmentStr : '')
              : augmentStr
            writeFileSync(soulPath, fullPrompt, 'utf-8')
            _soulMdLock = Date.now() + 120000  // block bootstrap from overwriting for 2 min (30s was too short, bootstrap race condition)
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
      // Send feedback when AI reply is available.
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

      // (JSONL session fallback removed — no platform-specific workarounds)

      // ── Commands: route through /command API ──
      if (typeof api.on === 'function') {
        // Log available api methods once
        console.log(`[cc-soul][api] api methods: ${Object.keys(api).filter(k => typeof api[k] === 'function').join(', ')}`)
        api.on('inbound_claim', async (event: any, _ctx: any) => {
          const content = (event?.content || event?.body || '').trim()
          if (!content) return
          console.log(`[cc-soul][api] inbound_claim fired: "${content.slice(0,30)}" event_keys=${Object.keys(event||{}).join(',')}`)
          try {
            const senderId = event?.senderId || event?.context?.senderId || ''
            const cmdResp = await fetch(`${SOUL_API}/command`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: content, user_id: senderId }),
            })
            const cmdData = await cmdResp.json()
            if (cmdData.handled && cmdData.reply && cmdData.reply !== '(done)') {
              console.log(`[cc-soul][api] inbound_claim: command handled, reply=${cmdData.reply.length}c`)
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
