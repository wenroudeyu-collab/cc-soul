/**
 * cc-soul — AI Backend Abstraction Layer
 *
 * Supports multiple backends:
 * - "cli": Claude CLI (default, for Max subscription users)
 * - "openai-compatible": Any OpenAI-compatible API (OpenAI/Ollama/智谱/通义/OpenRouter/Groq/...)
 *
 * All 29 modules call spawnCLI() — they don't know or care which backend is active.
 * Switching backend = change config, zero code changes.
 */

import { spawn, execSync } from 'child_process'
import { homedir } from 'os'
import { existsSync, readFileSync } from 'fs'
import type { PostResponseResult } from './types.ts'
import { DATA_DIR, MODULE_DIR, loadJson } from './persistence.ts'
import { resolve } from 'path'
import { extractJSON } from './utils.ts'

// ═══════════════════════════════════════════════════════════════════════════════
// AI BACKEND CONFIG — auto-detects from OpenClaw's openclaw.json
// ═══════════════════════════════════════════════════════════════════════════════

interface AIConfig {
  backend: 'cli' | 'openai-compatible'
  cli_command: string
  cli_args: string[]
  api_base: string
  api_key: string
  api_model: string
  max_concurrent: number
}

const OPENCLAW_CONFIG_PATH = resolve(homedir(), '.openclaw/openclaw.json')
const OPENCLAW_CONFIGJSON_PATH = resolve(homedir(), '.openclaw/config.json')
const OPENCLAW_MODELS_PATH = resolve(homedir(), '.openclaw/agents/main/agent/models.json')
const AI_CONFIG_PATH = resolve(DATA_DIR, 'ai_config.json')

/**
 * Auto-detect AI backend from OpenClaw's config.
 * Strategy: follow whatever model OpenClaw is using — read model.primary,
 * resolve provider from config.json + models.json, use the same backend.
 * Priority: ai_config.json (user override) > openclaw model.primary > defaults
 */
let _fallbackApiConfig: AIConfig | null = null

/**
 * Merge provider info from config.json (apiKey, baseUrl) and models.json (baseUrl, models list).
 * Returns { baseUrl, apiKey, model } for a given provider name.
 */
function resolveProvider(providerName: string, modelId: string): { baseUrl: string; apiKey: string; model: string } | null {
  let baseUrl = ''
  let apiKey = ''
  let model = modelId || ''

  // Read config.json providers
  try {
    if (existsSync(OPENCLAW_CONFIGJSON_PATH)) {
      const cfg = JSON.parse(readFileSync(OPENCLAW_CONFIGJSON_PATH, 'utf-8'))
      const p = cfg?.providers?.[providerName]
      if (p) {
        if (p.apiKey) apiKey = p.apiKey
        if (p.baseUrl) baseUrl = p.baseUrl
      }
    }
  } catch {}

  // Read models.json providers (may have baseUrl + apiKey + model list)
  try {
    if (existsSync(OPENCLAW_MODELS_PATH)) {
      const modelsRaw = JSON.parse(readFileSync(OPENCLAW_MODELS_PATH, 'utf-8'))
      const p = modelsRaw?.providers?.[providerName]
      if (p) {
        if (p.baseUrl && !baseUrl) baseUrl = p.baseUrl
        if (p.apiKey && !apiKey) apiKey = p.apiKey
        // If no model specified, use first model from list
        if (!model && p.models?.length > 0) model = p.models[0].id
      }
    }
  } catch {}

  // Read openclaw.json providers as last resort
  try {
    if (existsSync(OPENCLAW_CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8'))
      const p = raw?.providers?.[providerName]
      if (p) {
        if (p.apiKey && !apiKey) apiKey = p.apiKey
        if (p.baseUrl && !baseUrl) baseUrl = p.baseUrl
      }
    }
  } catch {}

  if (!baseUrl || !apiKey) return null
  return { baseUrl, apiKey, model }
}

function detectAIConfig(): AIConfig {
  // 1. User override: if ai_config.json exists, use it
  const userConfig = loadJson<Partial<AIConfig>>(AI_CONFIG_PATH, {})
  if (userConfig.backend) {
    console.log(`[cc-soul][ai] using user override from ai_config.json`)
    return {
      backend: userConfig.backend,
      cli_command: userConfig.cli_command || 'claude',
      cli_args: userConfig.cli_args || ['-p'],
      api_base: userConfig.api_base || 'https://api.openai.com/v1',
      api_key: userConfig.api_key || '',
      api_model: userConfig.api_model || 'gpt-4o',
      max_concurrent: userConfig.max_concurrent || 5,
    }
  }

  // 2. Follow OpenClaw's model.primary — whatever OpenClaw uses, we use
  try {
    if (existsSync(OPENCLAW_CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8'))
      const agents = raw?.agents?.defaults || {}
      const modelRef = agents?.model?.primary || '' // e.g. "volcengine/doubao-seed-1-8-251228"
      const cliBackends = agents?.cliBackends || {}

      if (modelRef) {
        const [provider, model] = modelRef.split('/')
        const backendDef = cliBackends[provider]

        if (backendDef?.command) {
          // CLI backend (claude/codex/gemini) — use CLI for main, resolve API fallback for background tasks
          const resolved = resolveProviderFallback()
          if (resolved) {
            _fallbackApiConfig = resolved
            console.log(`[cc-soul][ai] fallback API ready: ${resolved.api_model}`)
          }
          const command = backendDef.command
          console.log(`[cc-soul][ai] following OpenClaw: CLI "${command}" (${modelRef})`)
          return {
            backend: 'cli',
            cli_command: command,
            cli_args: command === 'claude' ? ['-p'] : (backendDef.args || []),
            api_base: '',
            api_key: '',
            api_model: '',
            max_concurrent: 5,
          }
        }

        // Not a CLI backend — resolve provider config from config.json + models.json
        const resolved = resolveProvider(provider, model)
        if (resolved) {
          console.log(`[cc-soul][ai] following OpenClaw: API "${provider}/${resolved.model}"`)
          return {
            backend: 'openai-compatible',
            cli_command: '',
            cli_args: [],
            api_base: resolved.baseUrl,
            api_key: resolved.apiKey,
            api_model: resolved.model,
            max_concurrent: 8,
          }
        }
        console.log(`[cc-soul][ai] model.primary "${modelRef}" — provider not resolved, trying fallback`)
      }

      // No model.primary or provider not found — try any available provider
      const fallback = resolveProviderFallback()
      if (fallback) return fallback
    }
  } catch (e: any) {
    console.error(`[cc-soul][ai] failed to read openclaw.json: ${e.message}`)
  }

  // 3. Default fallback: claude CLI
  console.log(`[cc-soul][ai] using default: claude CLI`)
  return {
    backend: 'cli',
    cli_command: 'claude',
    cli_args: ['-p'],
    api_base: '',
    api_key: '',
    api_model: '',
    max_concurrent: 5,
  }
}

/**
 * Fallback: try all known providers from models.json + config.json.
 * Used when model.primary is a CLI backend and we need an API for background tasks,
 * or when model.primary provider can't be resolved.
 */
function resolveProviderFallback(): AIConfig | null {
  const candidates = ['deepseek', 'moonshot', 'zhipu', 'volcengine', 'openai']
  for (const name of candidates) {
    const resolved = resolveProvider(name, '')
    if (resolved) {
      return {
        backend: 'openai-compatible',
        cli_command: '',
        cli_args: [],
        api_base: resolved.baseUrl,
        api_key: resolved.apiKey,
        api_model: resolved.model,
        max_concurrent: 8,
      }
    }
  }
  return null
}

export function getFallbackApiConfig(): AIConfig | null { return _fallbackApiConfig }

let aiConfig: AIConfig = detectAIConfig()

export function loadAIConfig() {
  aiConfig = detectAIConfig()
}

export function getAIConfig(): AIConfig {
  return aiConfig
}

// ═══════════════════════════════════════════════════════════════════════════════
// SPAWN CLI — unified AI invocation (routes to correct backend)
// ═══════════════════════════════════════════════════════════════════════════════

let activeCLICount = 0

// ── Agent 优先机制 ──
let agentBusy = false
export function getAgentBusy(): boolean { return agentBusy }
export function setAgentBusy(busy: boolean) {
  agentBusy = busy
  // Agent 释放后，自动处理排队任务
  if (!busy) drainQueue()
}

// ── CLI health monitoring ──
let consecutiveFailures = 0
const MAX_FAILURES_BEFORE_DEGRADE = 1
let degradedMode = false
let degradedAt = 0
const DEGRADE_RECOVERY_MS = 5 * 60 * 1000 // try recovery after 5 min

export function isCliDegraded(): boolean { return degradedMode }

// ── 任务队列（agent busy 时排队，释放后自动执行）──
interface QueuedTask {
  prompt: string
  callback: (output: string) => void
  timeoutMs: number
  label: string
}
const taskQueue: QueuedTask[] = []
const MAX_QUEUE_SIZE = 10

function drainQueue() {
  while (taskQueue.length > 0 && !agentBusy && activeCLICount < aiConfig.max_concurrent) {
    const task = taskQueue.shift()!
    console.log(`[cc-soul][ai] 队列取出: ${task.label} (剩余 ${taskQueue.length})`)
    executeTask(task.prompt, task.callback, task.timeoutMs, task.label)
  }
}

// ── 任务完成通知 ──
type TaskDoneCallback = (label: string, elapsed: number, success: boolean) => void
let onTaskDone: TaskDoneCallback | null = null
export function setOnTaskDone(cb: TaskDoneCallback) { onTaskDone = cb }

// ── 任务状态追踪 ──
interface CLITask {
  label: string
  startedAt: number
  hasOutput: boolean
}
const activeTasks = new Map<number, CLITask>()
let taskIdCounter = 0

export function getActiveTaskStatus(): string {
  if (activeTasks.size === 0 && taskQueue.length === 0) return ''
  const now = Date.now()
  const running = [...activeTasks.values()]
    .map(t => {
      const elapsed = Math.round((now - t.startedAt) / 1000)
      const status = t.hasOutput ? '⚙️' : '⏳'
      return `${status} ${t.label} (${elapsed}s)`
    })
  const queued = taskQueue.length > 0 ? [`📋 排队 ${taskQueue.length} 个`] : []
  return [...running, ...queued].join(' | ')
}

export function spawnCLI(prompt: string, callback: (output: string) => void, timeoutMs = 120000, label = 'ai-task') {
  // If fallback API is configured (from openclaw providers), prefer it for background tasks
  console.log(`[cc-soul][ai] spawnCLI: backend=${aiConfig.backend} fallback=${!!_fallbackApiConfig} label=${label}`)
  if (aiConfig.backend === 'cli' && _fallbackApiConfig) {
    callOpenAICompatibleDirect(_fallbackApiConfig, prompt, (result) => {
      if (onTaskDone) onTaskDone(label, 0, result.length > 0)
      callback(result)
    }, timeoutMs)
    return
  }

  // One-shot CLI with strict serial queue (max 1 concurrent)
  // No persistent daemon — each task spawns claude -p, gets result, process exits cleanly
  if (activeCLICount >= 1) {
    // Already one task running — queue it
    if (taskQueue.length >= MAX_QUEUE_SIZE) {
      console.log(`[cc-soul][ai] queue full (${MAX_QUEUE_SIZE}), dropping: ${label}`)
      callback('')
      return
    }
    taskQueue.push({ prompt, callback, timeoutMs, label })
    return
  }
  // No task running — execute immediately
  executeTask(prompt, callback, timeoutMs, label)
}

function executeTask(prompt: string, callback: (output: string) => void, timeoutMs: number, label: string) {
  activeCLICount++ // increment before async dispatch to prevent over-concurrency in drainQueue
  const taskId = taskIdCounter++
  const startedAt = Date.now()

  // 包装 callback：完成时通知 + 释放 + 处理队列
  const wrappedCallback = (result: string) => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    const success = result.length > 0
    // 通知完成
    if (onTaskDone) onTaskDone(label, elapsed, success)
    // 原始回调
    callback(result)
    // 处理排队任务
    setTimeout(() => drainQueue(), 100)
  }

  if (aiConfig.backend === 'openai-compatible') {
    activeTasks.set(taskId, { label, startedAt, hasOutput: false })
    callOpenAICompatible(prompt, (result) => {
      activeTasks.delete(taskId)
      wrappedCallback(result)
    }, timeoutMs)
  } else {
    callCLI(prompt, wrappedCallback, timeoutMs, label, taskId)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BACKEND 1: CLI — One-shot per task (openclaw manages session persistence)
// Each task spawns `claude -p`, gets result, process exits cleanly.
// Session continuity is handled by openclaw's sessionMode/--resume mechanism.
// ═══════════════════════════════════════════════════════════════════════════════

function callCLI(prompt: string, callback: (output: string) => void, timeoutMs: number, label: string, taskId: number) {
  activeTasks.set(taskId, { label, startedAt: Date.now(), hasOutput: false })
  let settled = false
  function release() {
    if (!settled) { settled = true; activeCLICount--; activeTasks.delete(taskId) }
  }
  try {
    const proc = spawn(aiConfig.cli_command, [...aiConfig.cli_args, prompt], {
      cwd: homedir(), timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'],
    })
    proc.stdin?.end()
    // Safety: force kill if process doesn't exit within timeout + 10s grace
    const killTimer = setTimeout(() => {
      if (proc.pid) {
        try { process.kill(proc.pid, 0); process.kill(proc.pid, 'SIGKILL'); console.log(`[cc-soul][ai] force-killed stuck PID ${proc.pid}`) } catch {}
      }
    }, timeoutMs + 10000)
    proc.on('close', () => clearTimeout(killTimer))
    const MAX_OUTPUT = 512 * 1024
    let output = ''

    proc.stdout?.on('data', (d: Buffer) => {
      const task = activeTasks.get(taskId)
      if (task) task.hasOutput = true
      if (output.length < MAX_OUTPUT) {
        output += d.toString()
        if (output.length > MAX_OUTPUT) output = output.slice(0, MAX_OUTPUT)
      }
    })
    proc.stderr?.on('data', () => {})

    const heartbeat = setInterval(() => {
      const task = activeTasks.get(taskId)
      const elapsed = task ? Math.round((Date.now() - task.startedAt) / 1000) : 0
      console.log(`[cc-soul][ai] ${label}: ${task?.hasOutput ? '工作中' : '等待中'} (${elapsed}s, ${Math.round(output.length / 1024)}kb)`)
    }, 30000)

    proc.on('close', (code: number | null, signal: string | null) => {
      clearInterval(heartbeat)
      const elapsed = Math.round((Date.now() - (activeTasks.get(taskId)?.startedAt || Date.now())) / 1000)
      release()
      if (signal === 'SIGTERM') {
        console.log(`[cc-soul][ai] ${label}: 超时 (${timeoutMs}ms)`)
        consecutiveFailures++
        if (consecutiveFailures >= MAX_FAILURES_BEFORE_DEGRADE && !degradedMode) {
          degradedMode = true; degradedAt = Date.now()
          console.error('[cc-soul][ai] CLI degraded mode: too many consecutive failures')
        }
        callback('')
        return
      }
      const trimmed = output.trim()
      // Detect known CLI error patterns in stdout (claude CLI may output errors to stdout)
      const isErrorOutput = /Invalid API key|API key expired|authentication failed|rate limit|overloaded/i.test(trimmed)
      if (isErrorOutput || code !== 0) {
        consecutiveFailures++
        if (consecutiveFailures >= MAX_FAILURES_BEFORE_DEGRADE && !degradedMode) {
          degradedMode = true; degradedAt = Date.now()
          console.error(`[cc-soul][ai] CLI degraded mode: too many failures (last: ${trimmed.slice(0, 80)})`)
        }
        console.log(`[cc-soul][ai] ${label}: CLI 错误 (code=${code}, ${trimmed.slice(0, 80)})`)
        callback('')
        return
      }
      consecutiveFailures = 0; degradedMode = false
      console.log(`[cc-soul][ai] ${label}: 完成 (${elapsed}s, ${output.length}bytes)`)
      callback(trimmed)
    })
    proc.on('error', (err: Error) => {
      clearInterval(heartbeat); release()
      consecutiveFailures++
      console.error(`[cc-soul][ai] ${label}: 错误 ${err.message}`)
      callback('')
    })
  } catch (err: any) {
    release()
    console.error(`[cc-soul][ai] CLI spawn failed: ${err.message}`)
    callback('')
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST-REPLY CLEANUP: kill gateway-spawned claude processes to free concurrency
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Kill claude CLI processes spawned by the gateway (CWD contains .openclaw/hooks).
 * Safe: never touches user terminal claude processes.
 * Called after message:sent to immediately free concurrency slots.
 */
export function killGatewayClaude() {
  // OpenClaw manages CLI lifecycle via ProcessSupervisor + sessionMode.
  // cc-soul should NOT kill any claude processes.
}

// ═══════════════════════════════════════════════════════════════════════════════
// BACKEND 2: OpenAI-compatible API (covers OpenAI/Ollama/智谱/通义/OpenRouter/Groq/...)
// ═══════════════════════════════════════════════════════════════════════════════

async function callOpenAICompatible(prompt: string, callback: (output: string) => void, timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const resp = await fetch(`${aiConfig.api_base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${aiConfig.api_key}`,
      },
      body: JSON.stringify({
        model: aiConfig.api_model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2048,
      }),
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      console.error(`[cc-soul][ai] API error ${resp.status}: ${errText.slice(0, 200)}`)
      consecutiveFailures++
      if (consecutiveFailures >= MAX_FAILURES_BEFORE_DEGRADE && !degradedMode) {
        degradedMode = true
        degradedAt = Date.now()
        console.error('[cc-soul][ai] CLI degraded mode: too many consecutive failures')
      }
      callback('')
      return
    }

    const data = await resp.json() as any
    const content = data.choices?.[0]?.message?.content || ''
    consecutiveFailures = 0
    degradedMode = false
    callback(content.trim())
  } catch (e: any) {
    clearTimeout(timer)
    consecutiveFailures++
    if (consecutiveFailures >= MAX_FAILURES_BEFORE_DEGRADE && !degradedMode) {
      degradedMode = true
      degradedAt = Date.now()
      console.error('[cc-soul][ai] CLI degraded mode: too many consecutive failures')
    }
    if (e.name === 'AbortError') {
      console.log(`[cc-soul][ai] API timeout after ${timeoutMs}ms`)
    } else {
      console.error(`[cc-soul][ai] API error: ${e.message}`)
    }
    callback('')
  } finally {
    activeCLICount--
  }
}

/**
 * Direct API call with explicit config (no global aiConfig mutation).
 * Used for fallback API calls when main backend is CLI.
 */
async function callOpenAICompatibleDirect(cfg: AIConfig, prompt: string, callback: (output: string) => void, timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(`${cfg.api_base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.api_key}`,
      },
      body: JSON.stringify({
        model: cfg.api_model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2048,
      }),
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      console.error(`[cc-soul][ai] fallback API error ${resp.status}: ${errText.slice(0, 200)}`)
      callback('')
      return
    }
    const data = await resp.json() as any
    const content = data.choices?.[0]?.message?.content || ''
    console.log(`[cc-soul][ai] fallback API ok: ${content.length} chars`)
    callback(content.trim())
  } catch (e: any) {
    clearTimeout(timer)
    console.error(`[cc-soul][ai] fallback API error: ${e.message}`)
    callback('')
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BACKEND 3: Anthropic API (Haiku) — dedicated channel for background tasks
// ═══════════════════════════════════════════════════════════════════════════════

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
let anthropicApiKey = ''

function getAnthropicApiKey(): string {
  if (anthropicApiKey) return anthropicApiKey
  try {
    const raw = JSON.parse(readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8'))
    anthropicApiKey = raw?.env?.ANTHROPIC_API_KEY || ''
  } catch { /* ignore */ }
  return anthropicApiKey
}

/**
 * Call Anthropic Messages API directly (Haiku model).
 * Independent of CLI — no concurrency conflict, no queue.
 */
async function callAnthropicHaiku(prompt: string, callback: (output: string) => void, timeoutMs: number) {
  const apiKey = getAnthropicApiKey()
  if (!apiKey) {
    console.log('[cc-soul][haiku] no ANTHROPIC_API_KEY, falling back to CLI')
    callback('')
    return
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      console.error(`[cc-soul][haiku] API error ${resp.status}: ${errText.slice(0, 200)}`)
      callback('')
      return
    }

    const data = await resp.json() as any
    const content = data.content?.[0]?.text || ''
    console.log(`[cc-soul][haiku] ok: ${content.length} chars, ${data.usage?.input_tokens || 0}+${data.usage?.output_tokens || 0} tokens`)
    callback(content.trim())
  } catch (e: any) {
    clearTimeout(timer)
    if (e.name === 'AbortError') {
      console.log(`[cc-soul][haiku] timeout after ${timeoutMs}ms`)
    } else {
      console.error(`[cc-soul][haiku] error: ${e.message}`)
    }
    callback('')
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MERGED POST-RESPONSE ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

const EMPTY_RESULT: PostResponseResult = {
  memories: [],
  entities: [],
  satisfaction: 'NEUTRAL',
  quality: { score: 5, issues: [] },
  emotion: 'neutral',
  reflection: null,
  curiosity: null,
}

export function runPostResponseAnalysis(
  userMsg: string,
  botResponse: string,
  callback: (result: PostResponseResult) => void,
) {
  const prompt = `分析以下对话，严格按JSON输出（不要其他文字）：

用户: "${userMsg.slice(0, 500)}"
回复: "${botResponse.slice(0, 500)}"

请同时完成以下分析：
1. memories: 提取值得长期记住的信息。每条: {"content":"内容","scope":"类型","visibility":"可见性"}，scope只能是: preference/fact/event/opinion。visibility只能是: global(通用知识/技术事实，对所有人有用)/channel(频道相关，只在当前群有用)/private(个人相关，只对当前用户有用)。没有就空数组。
2. memory_ops: 基于对话内容判断是否需要修改已有记忆。每条: {"action":"update/delete","keyword":"匹配关键词","reason":"原因","new_content":"新内容(仅update需要)"}。例如用户说"我换工作了"→删除旧公司记忆+新增新公司。没有就空数组。
3. entities: 提取人名、项目名、公司名、技术名。每条: {"name":"名","type":"类型","relation":"关系"}，type只能是: person/project/company/tech/place。没有就空数组。
4. satisfaction: 判断用户对回复的满意度: POSITIVE/NEUTRAL/NEGATIVE/TOO_VERBOSE
5. quality: 回复质量评分1-10 + 问题列表。{"score":N,"issues":["问题"]}
6. emotion: 对话情感标签: neutral/warm/important/painful/funny
7. reflection: 回复有什么遗憾或可改进的？1句话，没有就null
8. curiosity: 作为朋友想追问什么？1句话，没有就null

JSON格式(严格):
{"memories":[],"memory_ops":[],"entities":[],"satisfaction":"NEUTRAL","quality":{"score":5,"issues":[]},"emotion":"neutral","reflection":null,"curiosity":null}`

  spawnCLI(
    prompt,
    (output) => {
      try {
        const result = extractJSON(output)
        if (result) {
          // ── Anti-hallucination: validate & clamp AI self-assessment ──
          const rawScore = result.quality?.score
          const clampedScore = typeof rawScore === 'number'
            ? Math.max(1, Math.min(10, Math.round(rawScore)))
            : 5
          // Heuristic cross-check: if AI says POSITIVE but user msg is very short
          // or contains negative signals, downgrade to NEUTRAL
          let satisfaction = result.satisfaction || 'NEUTRAL'
          const validSatisfactions = ['POSITIVE', 'NEUTRAL', 'NEGATIVE', 'TOO_VERBOSE']
          if (!validSatisfactions.includes(satisfaction)) satisfaction = 'NEUTRAL'
          const userLower = userMsg.toLowerCase()
          const hasNegativeSignal = /不行|不对|错了|有问题|别|不要|不好|差|垃圾|废话|no|wrong|bad|stop|don't/.test(userLower)
          const hasPositiveSignal = /谢|好的|棒|赞|感谢|不错|厉害|可以|thank|great|good|nice|perfect|awesome/.test(userLower)
          if (satisfaction === 'POSITIVE' && hasNegativeSignal && !hasPositiveSignal) {
            console.log(`[cc-soul][anti-hallucination] satisfaction POSITIVE→NEUTRAL: user msg has negative signals`)
            satisfaction = 'NEUTRAL'
          }
          if (satisfaction === 'NEGATIVE' && hasPositiveSignal && !hasNegativeSignal) {
            console.log(`[cc-soul][anti-hallucination] satisfaction NEGATIVE→NEUTRAL: user msg has positive signals`)
            satisfaction = 'NEUTRAL'
          }
          // Cap memories per turn to prevent hallucinated bulk extraction
          const MAX_MEMORIES_PER_TURN = 5
          const MAX_OPS_PER_TURN = 3
          const memories = (result.memories || []).slice(0, MAX_MEMORIES_PER_TURN).map((m: any) => ({
            content: m.content,
            scope: m.scope,
            visibility: m.visibility || undefined,
          })).filter((m: any) => m.content && m.content.length >= 3)
          const memoryOps = (result.memory_ops || []).slice(0, MAX_OPS_PER_TURN).map((op: any) => ({
            action: op.action as 'update' | 'delete',
            keyword: op.keyword || '',
            reason: op.reason || '',
            newContent: op.new_content || '',
          }))

          callback({
            memories,
            memoryOps,
            entities: (result.entities || []).slice(0, 10),
            satisfaction,
            quality: { score: clampedScore, issues: result.quality?.issues || [] },
            emotion: result.emotion || 'neutral',
            reflection: result.reflection || null,
            curiosity: result.curiosity || null,
          })
          return
        }
      } catch (e: any) {
        console.error(`[cc-soul][ai] analysis parse error: ${e.message}`)
      }
      callback({ ...EMPTY_RESULT })
    },
    45000,
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
