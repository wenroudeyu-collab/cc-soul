/**
 * memory.ts — Memory System (barrel + core CRUD)
 *
 * Sub-modules:
 *   memory-utils.ts      — trigrams, synonyms, compression, constants
 *   memory-recall.ts     — BM25 + recall engine + stats
 *   memory-lifecycle.ts  — consolidation, decay, episodes, association, commands, audit
 */

import { resolve } from 'path'
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'

import type { Memory } from './types.ts'
import { MEMORIES_PATH, HISTORY_PATH, DATA_DIR, loadJson, debouncedSave } from './persistence.ts'
// spawnCLI import removed — AUDN gray zone now uses local multi-signal voting
import { autoExtractFromMemory } from './fact-store.ts'
import { getParam } from './auto-tune.ts'
import {
  initSQLite, migrateFromJSON, migrateHistoryFromJSON,
  sqliteAddMemory, sqliteUpdateMemory,
  sqliteFindByContent, sqliteCount, sqliteGetAll,
  sqliteAddChatTurn, sqliteGetRecentHistory, sqliteTrimHistory,
  backfillEmbeddings, hasVectorSearch,
} from './sqlite-store.ts'
import { initEmbedder } from './embedder.ts'
import { appendAudit } from './audit.ts'
import { addRelation } from './graph.ts'

// ── Imports from sub-modules ──
import {
  trigrams, trigramSimilarity, timeDecay,
  MAX_MEMORIES, MAX_HISTORY, INJECT_HISTORY,
  compressMemory, detectMemoryPoisoning, extractReasoning, defaultVisibility,
} from './memory-utils.ts'
import { invalidateIDF, incrementalIDFUpdate, updateRecallIndex, rebuildRecallIndex } from './memory-recall.ts'

// ── Re-exports (barrel) ──
export {
  trigrams, trigramSimilarity, shuffleArray, compressMemory,
  SYNONYM_MAP, MAX_MEMORIES, MAX_HISTORY, INJECT_HISTORY,
  detectMemoryPoisoning, extractReasoning, defaultVisibility,
} from './memory-utils.ts'
export {
  recall, recallFused, getCachedFusedRecall, invalidateIDF, degradeMemoryConfidence,
  trackRecallImpact, getRecallImpactBoost, getRecallRate, recallStats, recallImpact,
  recallWithScores, recallWithMetamemory, updateRecallIndex, rebuildRecallIndex, incrementalIDFUpdate,
} from './memory-recall.ts'
export type { MetamemoryResult } from './memory-recall.ts'
export {
  consolidateMemories, generateInsights, recallFeedbackLoop,
  associateSync, triggerAssociativeRecall, getAssociativeRecall,
  parseMemoryCommands, executeMemoryCommands, getPendingSearchResults,
  scanForContradictions,
  predictiveRecall, generatePrediction, triggerSessionSummary,
  cleanupNetworkKnowledge, resolveNetworkConflicts,
  episodes, loadEpisodes, recordEpisode, recallEpisodes, buildEpisodeContext,
  processMemoryDecay, pruneExpiredMemories, compressOldMemories, reviveDecayedMemories,
  restoreArchivedMemories,
  sqliteMaintenance, getStorageStatus,
  auditMemoryHealth,
} from './memory-lifecycle.ts'

// Lazy-loaded modules (avoid circular deps + ESM require issues)
let _handlerState: any = null
let _bodyMod: any = null
let _signalsMod: any = null
let _distillMod: any = null

export function getLazyModule(name: string) {
  switch (name) {
    case 'handler-state':
      if (!_handlerState) { import('./handler-state.ts').then(m => { _handlerState = m }).catch(() => {}) }
      return _handlerState
    case 'body':
      if (!_bodyMod) { import('./body.ts').then(m => { _bodyMod = m }).catch(() => {}) }
      return _bodyMod
    case 'signals':
      if (!_signalsMod) { import('./signals.ts').then(m => { _signalsMod = m }).catch(() => {}) }
      return _signalsMod
    case 'distill':
      if (!_distillMod) { import('./distill.ts').then(m => { _distillMod = m }).catch(() => {}) }
      return _distillMod
    default: return null
  }
}
// Pre-load lazily in background
setTimeout(() => {
  import('./handler-state.ts').then(m => { _handlerState = m }).catch(() => {})
  import('./body.ts').then(m => { _bodyMod = m }).catch(() => {})
  import('./signals.ts').then(m => { _signalsMod = m }).catch(() => {})
  import('./distill.ts').then(m => { _distillMod = m }).catch(() => {})
}, 1000)

// ═══════════════════════════════════════════════════════════════════════════════
// BAYESIAN CONFIDENCE — Beta distribution posterior update
// ═══════════════════════════════════════════════════════════════════════════════

const BAYES_DEFAULT_ALPHA = 2
const BAYES_DEFAULT_BETA = 1

/** Compute confidence from Beta distribution: α / (α + β) */
export function bayesConfidence(mem: Memory): number {
  const a = mem.bayesAlpha ?? BAYES_DEFAULT_ALPHA
  const b = mem.bayesBeta ?? BAYES_DEFAULT_BETA
  return a / (a + b)
}

/** Ensure Bayes fields exist on a memory (backward-compatible init) */
function ensureBayesFields(mem: Memory) {
  if (mem.bayesAlpha == null) {
    // Reverse-engineer from existing confidence if present
    const c = mem.confidence ?? 0.67
    // alpha / (alpha + beta) ≈ c, keep sum ≈ 3 for prior strength
    const sum = BAYES_DEFAULT_ALPHA + BAYES_DEFAULT_BETA
    mem.bayesAlpha = c * sum
    mem.bayesBeta = (1 - c) * sum
  }
  if (mem.bayesBeta == null) mem.bayesBeta = BAYES_DEFAULT_BETA
}

/** Positive evidence: recall confirmed by user context */
export function bayesBoost(mem: Memory, delta = 0.5) {
  ensureBayesFields(mem)
  mem.bayesAlpha! += delta
  mem.confidence = bayesConfidence(mem)
}

/** Negative evidence: recall ignored by user */
export function bayesPenalize(mem: Memory, delta = 0.5) {
  ensureBayesFields(mem)
  mem.bayesBeta! += delta
  mem.confidence = bayesConfidence(mem)
}

/** Strong negative: user corrected this memory */
export function bayesCorrect(mem: Memory, delta = 2) {
  ensureBayesFields(mem)
  mem.bayesBeta! += delta
  mem.confidence = bayesConfidence(mem)
}

/**
 * Sync memory confidence/scope changes to SQLite.
 * Call this whenever you modify mem.confidence or mem.scope in-memory.
 */
export function syncToSQLite(mem: Memory, updates: { confidence?: number; scope?: string; tier?: string; recallCount?: number; lastAccessed?: number; lastRecalled?: number }) {
  if (!useSQLite) return
  const found = sqliteFindByContent(mem.content)
  if (found) {
    sqliteUpdateMemory(found.id, updates)
  }
}

/** Whether SQLite is the active storage backend (vs JSON fallback) */
export let useSQLite = false

/** Whether memories have been loaded into memoryState (lazy) */
export let _memoriesLoaded = false

/** Whether SQLite has been initialized for direct queries (lightweight) */
let _sqliteInitDone = false

/**
 * Ensure SQLite is initialized for direct queries (no memory loading).
 * This is cheap (~10ms) and enables recall() to work without loadMemories().
 */
export function ensureSQLiteReady(): boolean {
  if (_sqliteInitDone) return useSQLite
  _sqliteInitDone = true
  const ok = initSQLite()
  if (ok) useSQLite = true
  return ok
}

/**
 * Ensure memoryState.memories is populated (lazy load).
 * Call this only when you actually need the in-memory array.
 */
export function ensureMemoriesLoaded(): void {
  if (_memoriesLoaded) return
  _memoriesLoaded = true
  loadMemories()
}


// ═══════════════════════════════════════════════════════════════════════════════
// Mutable state — exported as object so ESM consumers can read live values
// ═══════════════════════════════════════════════════════════════════════════════

interface ChatTurn { user: string; assistant: string; ts: number }

export const memoryState = {
  memories: [] as Memory[],
  chatHistory: [] as ChatTurn[],
}

// ═══════════════════════════════════════════════════════════════════════════════
// MEMORY INDEX — O(1) lookup by scope (maintained on add/remove)
// ═══════════════════════════════════════════════════════════════════════════════

export const scopeIndex = new Map<string, Memory[]>()

// ── Content hash index for O(1) exact-match dedup in decideMemoryAction ──
const contentIndex = new Map<string, string>() // content前50字符(lowercase) → full content (stable across splices)

function rebuildContentIndex() {
  contentIndex.clear()
  for (let i = 0; i < memoryState.memories.length; i++) {
    const key = memoryState.memories[i].content.slice(0, 50).toLowerCase()
    contentIndex.set(key, memoryState.memories[i].content)
  }
}

export function rebuildScopeIndex() {
  scopeIndex.clear()
  for (const mem of memoryState.memories) {
    const arr = scopeIndex.get(mem.scope) || []
    arr.push(mem)
    scopeIndex.set(mem.scope, arr)
  }
  rebuildContentIndex()
}

export function getMemoriesByScope(scope: string): Memory[] {
  return scopeIndex.get(scope) || []
}

// ═══════════════════════════════════════════════════════════════════════════════
// WORKING MEMORY — per-session context, auto-cleared between sessions
// ═══════════════════════════════════════════════════════════════════════════════

interface WorkingMemoryEntry {
  content: string
  sessionKey: string    // which session this belongs to
  addedAt: number
}

const MAX_WORKING = 20  // max entries per session
const MAX_WORKING_SESSIONS = 100  // P0-2: cap total sessions to prevent unbounded Map growth
const workingMemory = new Map<string, WorkingMemoryEntry[]>()

/**
 * Add to working memory for current session.
 * This stays in memory (not persisted) and is cleared when session ends.
 */
export function addWorkingMemory(content: string, sessionKey: string) {
  if (!content || content.length < 5) return
  let entries = workingMemory.get(sessionKey)
  if (!entries) {
    entries = []
    workingMemory.set(sessionKey, entries)
  }
  // Dedup
  if (entries.some(e => e.content === content)) return
  entries.push({ content, sessionKey, addedAt: Date.now() })
  // Trim per-session entries
  if (entries.length > MAX_WORKING) entries.splice(0, entries.length - MAX_WORKING)
  // P0-2: LRU eviction — cap total sessions
  if (workingMemory.size > MAX_WORKING_SESSIONS) {
    const oldest = workingMemory.keys().next().value
    if (oldest) workingMemory.delete(oldest)
  }
}

/**
 * Get working memory context for current session.
 * Always injected — no recall needed.
 */
export function buildWorkingMemoryContext(sessionKey: string): string {
  const entries = workingMemory.get(sessionKey)
  if (!entries || entries.length === 0) return ''
  return `[Working Memory — this session]\n${entries.map(e => `- ${e.content}`).join('\n')}`
}

/**
 * Clear working memory for a session (called on session end/reset).
 * Important facts get archived to regular memories before clearing.
 */
export function archiveWorkingMemory(sessionKey: string) {
  const entries = workingMemory.get(sessionKey)
  if (!entries || entries.length === 0) return

  let archived = 0
  for (const entry of entries) {
    // Only archive entries that are likely important
    if (entry.content.length < 50) continue // too short to be meaningful
    // Check if it contains actionable/factual content (simple heuristic)
    const hasSubstance = /[：:=→]|因为|所以|结论|发现|决定|计划|问题|解决|配置|版本|密码|账号|地址/.test(entry.content)
    if (!hasSubstance && entry.content.length < 100) continue

    addMemory(entry.content, 'event', undefined, 'channel', sessionKey)
    archived++
  }
  if (archived > 0) console.log(`[cc-soul][memory] archived ${archived}/${entries.length} working memory entries`)
  workingMemory.delete(sessionKey)
}

/**
 * Cleanup stale working memory (sessions older than 6 hours).
 */
export function cleanupWorkingMemory() {
  const cutoff = Date.now() - 6 * 3600000
  for (const [key, entries] of workingMemory) {
    if (entries.length > 0 && entries[entries.length - 1].addedAt < cutoff) {
      archiveWorkingMemory(key)
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// CORE MEMORY — always-available critical knowledge (MemGPT-inspired tiering)
// ═══════════════════════════════════════════════════════════════════════════════

const CORE_MEMORY_PATH = resolve(DATA_DIR, 'core_memory.json')
const MAX_CORE_MEMORIES = 100

interface CoreMemory {
  content: string
  category: 'user_fact' | 'preference' | 'rule' | 'identity' | 'relationship'
  addedAt: number
  source: string  // how it got promoted: "auto" | "manual" | "reflection"
}

export let coreMemories: CoreMemory[] = []

export function loadCoreMemories() {
  coreMemories = loadJson<CoreMemory[]>(CORE_MEMORY_PATH, [])
  console.log(`[cc-soul][core-memory] loaded ${coreMemories.length} core memories`)
}

function saveCoreMemories() {
  debouncedSave(CORE_MEMORY_PATH, coreMemories)
}

/**
 * Promote a regular memory to core (always-available, never evicted).
 */
export function promoteToCore(content: string, category: CoreMemory['category'], source = 'auto') {
  // Dedup
  if (coreMemories.some(m => m.content === content)) return

  // Reject system augment content that shouldn't be in core memory
  const REJECT_PREFIXES = ['[goal completed]', '[Working Memory', '[当前面向:', '[隐私模式]', '[当前对话者]', '[内部矛盾警告]', '[System]', '[安全警告]', 'Rating:', '→ **Rating']
  if (REJECT_PREFIXES.some(p => content.includes(p))) {
    console.log(`[cc-soul][core-memory] REJECT (system augment): ${content.slice(0, 60)}`)
    return
  }

  coreMemories.push({ content, category, addedAt: Date.now(), source })

  // If over limit, remove oldest auto-promoted (keep manual ones)
  if (coreMemories.length > MAX_CORE_MEMORIES) {
    const autoIdx = coreMemories.findIndex(m => m.source === 'auto')
    if (autoIdx >= 0) coreMemories.splice(autoIdx, 1)
  }

  saveCoreMemories()
  console.log(`[cc-soul][core-memory] promoted: ${content.slice(0, 50)} [${category}]`)
}

/**
 * Remove from core memory.
 */
export function demoteFromCore(keyword: string): boolean {
  const idx = coreMemories.findIndex(m => m.content.toLowerCase().includes(keyword.toLowerCase()))
  if (idx >= 0) {
    coreMemories.splice(idx, 1)
    saveCoreMemories()
    return true
  }
  return false
}

/**
 * Build core memory context for prompt injection (always included, no recall needed).
 */
export function buildCoreMemoryContext(): string {
  if (coreMemories.length === 0) return ''
  const lines = coreMemories.map(m => `- [${m.category}] ${m.content}`)
  return `[Core Memory — always available]\n${lines.join('\n')}`
}

/**
 * Auto-promote: scan regular memories for candidates worthy of core status.
 * Called periodically from heartbeat.
 * Criteria: high emotion weight, high recall count (tags>8), or correction-derived rules.
 */
export function autoPromoteToCoreMemory() {
  if (coreMemories.length >= MAX_CORE_MEMORIES) return

  for (const mem of memoryState.memories) {
    if (mem.scope === 'expired') continue
    if (coreMemories.some(c => c.content === mem.content)) continue

    let shouldPromote = false
    let category: CoreMemory['category'] = 'user_fact'

    // High emotional importance
    if (mem.emotion === 'important' || mem.emotion === 'warm') {
      shouldPromote = true
      category = mem.scope === 'preference' ? 'preference' : 'user_fact'
    }

    // Frequently recalled (lowered from 10 → 3 to fix starvation)
    if (mem.tags && mem.tags.length >= 3) {
      shouldPromote = true
      category = 'user_fact'
    }

    // Recalled multiple times (recallCount tracks actual usage)
    if ((mem.recallCount ?? 0) >= 3) {
      shouldPromote = true
      category = mem.scope === 'preference' ? 'preference' : 'user_fact'
    }

    // Preference/fact scope — user's stated preferences are always important
    if (mem.scope === 'preference' || mem.scope === 'fact') {
      shouldPromote = true
      category = mem.scope === 'preference' ? 'preference' : 'user_fact'
    }

    // Consolidated memories (already distilled from many)
    if (mem.scope === 'consolidated') {
      shouldPromote = true
      category = 'user_fact'
    }

    // Correction-derived (learned rules)
    if (mem.scope === 'correction' && mem.content.startsWith('[纠正归因]')) {
      shouldPromote = true
      category = 'rule'
    }

    if (shouldPromote) {
      promoteToCore(mem.content, category, 'auto')
      if (coreMemories.length >= MAX_CORE_MEMORIES) break
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Chat History
// ═══════════════════════════════════════════════════════════════════════════════

export function addToHistory(user: string, assistant: string) {
  memoryState.chatHistory.push({
    user: user.slice(0, 1000),
    assistant: assistant.slice(0, 2000),
    ts: Date.now(),
  })
  // 超过上限：保留最近的
  if (memoryState.chatHistory.length > MAX_HISTORY) {
    const trimmed = memoryState.chatHistory.slice(-MAX_HISTORY)
    memoryState.chatHistory.length = 0
    memoryState.chatHistory.push(...trimmed)
  }
  // Write to SQLite + JSON
  if (useSQLite) {
    sqliteAddChatTurn(user, assistant)
    sqliteTrimHistory(MAX_HISTORY)
  }
  debouncedSave(HISTORY_PATH, memoryState.chatHistory)
}

export function buildHistoryContext(maxTokens = 4000): string {
  if (memoryState.chatHistory.length === 0) return ''

  const recent = memoryState.chatHistory.slice(-INJECT_HISTORY)
  const lines: string[] = []
  let totalTokens = 0

  // Build from most recent backward, stop when budget exceeded
  for (let i = recent.length - 1; i >= 0; i--) {
    const t = recent[i]
    const timeStr = new Date(t.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    const line = `[${timeStr}] 用户: ${t.user.slice(0, 200)}\n助手: ${t.assistant.slice(0, 400)}`
    const lineTokens = Math.ceil(line.length * 0.8) // rough char-to-token estimate
    if (totalTokens + lineTokens > maxTokens) break
    lines.unshift(line) // prepend (we're going backward)
    totalTokens += lineTokens
  }

  if (lines.length === 0) return ''
  return `[对话历史（最近${lines.length}轮）]\n${lines.join('\n\n')}`
}

// ═══════════════════════════════════════════════════════════════════════════════
// Semantic Tag Generation (local extraction — no LLM needed)
// ═══════════════════════════════════════════════════════════════════════════════

/** Well-known tech keywords for tag extraction */
const TECH_KEYWORDS = new Set([
  'python', 'javascript', 'typescript', 'rust', 'golang', 'swift', 'kotlin',
  'java', 'ruby', 'php', 'c++', 'docker', 'kubernetes', 'k8s', 'git',
  'github', 'gitlab', 'npm', 'pip', 'cargo', 'webpack', 'vite', 'react',
  'vue', 'angular', 'svelte', 'node', 'deno', 'bun', 'flask', 'django',
  'fastapi', 'express', 'nginx', 'redis', 'mysql', 'postgres', 'mongodb',
  'sqlite', 'elasticsearch', 'kafka', 'rabbitmq', 'grpc', 'graphql',
  'rest', 'api', 'http', 'https', 'websocket', 'tcp', 'udp',
  'linux', 'macos', 'windows', 'ios', 'android', 'arm64', 'x86',
  'cpu', 'gpu', 'cuda', 'llm', 'gpt', 'claude', 'openai', 'transformer',
  'embedding', 'vector', 'rag', 'fine-tune', 'lora', 'bert',
  'ida', 'frida', 'mach-o', 'elf', 'dyld', 'objc', 'runtime',
  'ci', 'cd', 'aws', 'gcp', 'azure', 'terraform', 'ansible',
  'json', 'yaml', 'toml', 'xml', 'csv', 'protobuf', 'sql',
  'html', 'css', 'scss', 'tailwind', 'figma',
  'test', 'debug', 'deploy', 'build', 'compile', 'lint',
  'async', 'await', 'promise', 'thread', 'mutex', 'lock',
  'feishu', 'wechat', 'telegram', 'slack', 'discord',
])

/**
 * Extract tags from text locally — no LLM call needed.
 * Extracts: Chinese 2-4 char words, English 3+ letter words, tech keywords.
 * Returns 5-10 unique tags.
 */
export function extractTagsLocal(content: string): string[] {
  const tags = new Set<string>()
  const lower = content.toLowerCase()

  // 1. Chinese word extraction: 2-4 char continuous CJK sequences
  const zhMatches = content.match(/[\u4e00-\u9fff]{2,4}/g) || []
  for (const w of zhMatches) {
    if (w.length >= 2) tags.add(w)
  }

  // 2. English/Latin words: 3+ letters, lowercased
  const enMatches = lower.match(/[a-z][a-z0-9._-]{2,}/g) || []
  for (const w of enMatches) {
    // Skip very common stopwords
    if (['the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were',
         'been', 'have', 'has', 'had', 'not', 'but', 'what', 'all', 'can', 'her',
         'his', 'our', 'their', 'will', 'would', 'could', 'should', 'may', 'might',
         'shall', 'also', 'into', 'than', 'then', 'them', 'these', 'those',
         'very', 'just', 'about', 'some', 'other', 'more', 'only', 'your',
         'how', 'its', 'let', 'being', 'both', 'each', 'few', 'most',
         'such', 'too', 'any', 'own', 'same', 'did', 'does', 'got'].includes(w)) continue
    tags.add(w)
  }

  // 3. Tech keywords: boost priority by adding them regardless of stopword filter
  for (const kw of TECH_KEYWORDS) {
    if (lower.includes(kw)) tags.add(kw)
  }

  // 4. Scope-like patterns: URLs, file paths, version numbers
  const urlMatch = lower.match(/(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})/g)
  if (urlMatch) {
    for (const u of urlMatch.slice(0, 2)) tags.add(u.replace(/^https?:\/\//, ''))
  }

  // Deduplicate and limit to 5-10 tags, preferring shorter (more specific) tags
  const sorted = [...tags]
    .filter(t => t.length >= 2 && t.length <= 20)
    .sort((a, b) => a.length - b.length)
  return sorted.slice(0, 10)
}

/**
 * Batch tag queue — tags are extracted locally, no CLI call needed.
 */
const tagQueue: { content: string; ts?: number; index?: number }[] = []
let tagBatchTimer: ReturnType<typeof setTimeout> | null = null

function queueForTagging(content: string, ts?: number, index?: number) {
  tagQueue.push({ content, ts, index })
  // Batch every 2 seconds or when queue reaches 20 (local is fast, can handle more)
  if (tagQueue.length >= 20) {
    flushTagQueue()
  } else if (!tagBatchTimer) {
    tagBatchTimer = setTimeout(flushTagQueue, 2000)
  }
}

function flushTagQueue() {
  if (tagBatchTimer) { clearTimeout(tagBatchTimer); tagBatchTimer = null }
  if (tagQueue.length === 0) return

  const batch = tagQueue.splice(0, 50) // local extraction is fast — take up to 50
  let tagged = 0

  for (const item of batch) {
    const tags = extractTagsLocal(item.content)
    if (tags.length < 2) continue

    let target: typeof memoryState.memories[0] | undefined
    // Primary: ts exact match (ts is unique timestamp)
    if (item.ts) {
      target = memoryState.memories.find(m => m.ts === item.ts && m.content === item.content && !m.tags)
    }
    // Fallback: index + content verification
    if (!target && item.index !== undefined && item.index >= 0 && item.index < memoryState.memories.length) {
      const candidate = memoryState.memories[item.index]
      if (candidate.content === item.content && !candidate.tags) {
        target = candidate
      }
    }
    // Last resort: content-only match
    if (!target) {
      target = memoryState.memories.find(m => m.content === item.content && !m.tags)
    }
    if (target) {
      target.tags = tags
      tagged++
    }
  }

  if (tagged > 0) saveMemories()
}

/**
 * Batch-tag untagged memories in background with throttling.
 * Called from handler.ts initialization with a delay.
 */
export function batchTagUntaggedMemories() {
  const untagged = memoryState.memories
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => !m.tags || m.tags.length === 0)
    .slice(0, 5) // small batch — CLI concurrency is limited

  if (untagged.length === 0) return
  console.log(`[cc-soul][tags] batch tagging ${untagged.length} untagged memories`)

  for (const { m, i } of untagged) {
    queueForTagging(m.content, m.ts, i)
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// Memory Smart CRUD — decide add/update/skip before writing
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * AUDN Decision Gate — Decide whether to ADD, UPDATE, DELETE, or NOOP a new memory.
 *
 * Three-tier decision:
 *   Fast path (rules):  exact match → NOOP, trigram > 0.9 → UPDATE, trigram < 0.3 → ADD
 *   Medium path (rules): trigram 0.3-0.9 + same scope → UPDATE (merge)
 *   Slow path (LLM):     fact/preference/correction in gray zone → async LLM arbitration
 *
 * Inspired by mem0's AUDN cycle but with rule-first approach to minimize LLM calls.
 */
export type AUDNAction = 'add' | 'update' | 'delete' | 'noop'

export function decideMemoryAction(newContent: string, scope?: string): { action: 'add' | 'update' | 'skip'; targetIndex: number } {
  if (memoryState.memories.length === 0) return { action: 'add', targetIndex: -1 }

  // O(1) exact-match via content hash index
  const shortKey = newContent.slice(0, 50).toLowerCase()
  const exactContent = contentIndex.get(shortKey)
  if (exactContent !== undefined && exactContent === newContent) {
    const exactIdx = memoryState.memories.findIndex(m => m.content === newContent)
    if (exactIdx >= 0) return { action: 'skip', targetIndex: exactIdx }
  }

  // Trigram scan — find top 3 similar memories (not just top 1)
  const newTri = trigrams(newContent)
  const candidates: { idx: number; sim: number }[] = []
  const startIdx = Math.max(0, memoryState.memories.length - 500)

  for (let i = startIdx; i < memoryState.memories.length; i++) {
    const mem = memoryState.memories[i]
    if (mem.scope === 'expired') continue

    // Exact match → NOOP
    if (mem.content === newContent) return { action: 'skip', targetIndex: i }

    const memTri = trigrams(mem.content)
    const sim = trigramSimilarity(newTri, memTri)
    if (sim > 0.25) {
      candidates.push({ idx: i, sim })
    }
  }

  candidates.sort((a, b) => b.sim - a.sim)
  const best = candidates[0]

  if (!best) return { action: 'add', targetIndex: -1 }

  // Fast path: very high similarity → UPDATE (near-duplicate)
  if (best.sim > 0.9) return { action: 'update', targetIndex: best.idx }

  // Fast path: low similarity → ADD (clearly new)
  if (best.sim < 0.5) return { action: 'add', targetIndex: -1 }

  // Medium path: moderate similarity — scope-aware decision
  const existingMem = memoryState.memories[best.idx]
  const dedupThreshold = getParam('memory.trigram_dedup_threshold')

  if (best.sim > dedupThreshold) {
    return { action: 'update', targetIndex: best.idx }
  }

  // Gray zone (0.5-0.8): local multi-signal voting (replaces async LLM arbitration)
  const existingLen = existingMem.content.length
  const newLen = newContent.length
  const lengthRatio = Math.min(existingLen, newLen) / Math.max(existingLen, newLen)
  const scopeMatch = (scope === existingMem.scope) ? 1 : 0
  const sameDay = Math.abs(Date.now() - existingMem.ts) < 86400000 ? 1 : 0

  const dupScore = best.sim * 0.5 + scopeMatch * 0.2 + lengthRatio * 0.2 + sameDay * 0.1
  if (dupScore > 0.75) {
    return { action: 'skip', targetIndex: best.idx }  // high confidence duplicate
  }
  if (dupScore > 0.55) {
    return { action: 'update', targetIndex: best.idx }  // merge into existing
  }
  return { action: 'add', targetIndex: -1 }  // sufficiently different, add
}

/**
 * Update an existing memory's content and timestamp, reset tags for re-tagging.
 */
export function updateMemory(index: number, newContent: string) {
  if (index < 0 || index >= memoryState.memories.length) return
  const mem = memoryState.memories[index]
  const oldContent = mem.content
  // Bi-temporal version tracking
  createMemoryVersion(oldContent, newContent, mem.scope)
  // P1-#9: 语义版本化 — 保留旧版本
  if (!mem.history) mem.history = []
  mem.history.push({ content: oldContent, ts: mem.ts })
  if (mem.history.length > 5) mem.history.shift() // 最多保留5个版本
  mem.content = newContent
  mem.ts = Date.now()
  mem.lastAccessed = Date.now()
  mem.tags = undefined // re-tag on next cycle
  invalidateIDF()
  rebuildScopeIndex()
  saveMemories()

  // Async re-tag
  if (newContent.length > 10) {
    queueForTagging(newContent, mem.ts, index)
  }
  console.log(`[cc-soul][memory] updated: "${oldContent.slice(0, 40)}" → "${newContent.slice(0, 40)}"`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// Retroactive Interference — new memories reshape (not just suppress) similar old memories
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 记忆干涉演化：新信息重塑旧记忆而非替换
 * 基于 Retroactive Interference Theory
 */
function retroactiveInterference(oldMem: Memory, newContent: string, similarity: number): boolean {
  // 只对中等相似度的记忆做干涉（太相似=重复，太不相似=无关）
  if (similarity < 0.3 || similarity > 0.85) return false
  // 只对 fact 和 preference 做干涉
  if (oldMem.scope !== 'fact' && oldMem.scope !== 'preference') return false

  // 提取新旧记忆的差异部分
  const oldWords = new Set((oldMem.content.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase()))
  const newWords = new Set((newContent.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase()))

  // 找出新增的关键词
  const addedWords: string[] = []
  for (const w of newWords) {
    if (!oldWords.has(w)) addedWords.push(w)
  }

  if (addedWords.length === 0) return false

  // 保存原文到 history
  if (!oldMem.history) oldMem.history = []
  if (oldMem.history.length < 5) {
    oldMem.history.push({ content: oldMem.content, ts: Date.now() })
  }

  // 重塑：在旧记忆后面追加新条件/补充
  const supplement = addedWords.slice(0, 3).join('、')
  oldMem.content = `${oldMem.content}（补充：${supplement}）`
  oldMem.confidence = Math.max(0.3, (oldMem.confidence ?? 0.7) * 0.85) // 置信度轻微降低
  oldMem.ts = Date.now() // 更新时间戳（重塑=部分重建）

  console.log(`[cc-soul][interference] reshaped: "${oldMem.content.slice(0, 50)}" (+${supplement})`)
  return true
}

/**
 * When a new fact/preference/correction is added, suppress or reshape
 * similar older memories. This prevents the 60K memory pile-up.
 *
 * Mechanism: trigram similarity > 0.6 with same scope →
 *   1. Try retroactive interference (reshape) for medium similarity (0.3-0.85)
 *   2. Fall back to confidence penalty if reshape not applicable
 * If confidence drops below 0.2 → mark as expired (effectively forgotten).
 * Only suppresses memories older than 1 hour (avoid self-interference).
 */
function suppressSimilarMemories(newMem: Memory) {
  const newTri = trigrams(newMem.content)
  const MIN_AGE_MS = 3600000 // 1 hour — don't suppress very recent memories
  let suppressed = 0
  let reshaped = 0

  const startIdx = Math.max(0, memoryState.memories.length - 500)
  for (let i = startIdx; i < memoryState.memories.length - 1; i++) { // -1 to skip the just-added one
    const old = memoryState.memories[i]
    if (old.scope === 'expired' || old.scope === 'archived') continue
    if (old.content === newMem.content) continue
    if (Date.now() - old.ts < MIN_AGE_MS) continue

    // Only suppress within same or related scopes
    const relatedScope = old.scope === newMem.scope ||
      (newMem.scope === 'correction' && old.scope === 'fact') ||
      (newMem.scope === 'fact' && old.scope === 'fact')
    if (!relatedScope) continue

    const oldTri = trigrams(old.content)
    const sim = trigramSimilarity(newTri, oldTri)

    if (sim > 0.6) {
      const oldContent = old.content // 记住旧 content 用于 SQLite 查找
      // 先尝试 retroactive interference（重塑而非压制）
      const wasReshaped = retroactiveInterference(old, newMem.content, sim)
      if (wasReshaped) {
        reshaped++
        // reshaped 后 old.content 已变，需用旧 content 查 SQLite 再更新
        if (useSQLite) {
          const found = sqliteFindByContent(oldContent)
          if (found) sqliteUpdateMemory(found.id, { content: old.content, confidence: old.confidence, ts: old.ts } as any)
        }
      } else {
        // 如果没有被重塑（不适用），维持原有的 confidence 降低
        bayesPenalize(old, 1.5)  // interference suppression: β += 1.5
        if (old.confidence < 0.2) {
          old.scope = 'expired'
          console.log(`[cc-soul][interference] expired: "${old.content.slice(0, 50)}" (suppressed by new memory)`)
        }
        suppressed++
        syncToSQLite(old, { confidence: old.confidence, scope: old.scope })
      }
      if (suppressed + reshaped >= 5) break // cap per new memory
    }
  }

  if (suppressed > 0 || reshaped > 0) {
    console.log(`[cc-soul][interference] ${suppressed} suppressed, ${reshaped} reshaped`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Memory CRUD
// ═══════════════════════════════════════════════════════════════════════════════

export function loadMemories() {
  _memoriesLoaded = true
  // Try SQLite first, fall back to JSON
  const sqliteOk = initSQLite()
  _sqliteInitDone = true
  if (sqliteOk) {
    migrateFromJSON()
    migrateHistoryFromJSON(HISTORY_PATH)

    // Load from SQLite — if empty, fall back to JSON (migration may have failed)
    const fromDb = sqliteGetAll(true)
    if (fromDb.length > 0) {
      useSQLite = true
      memoryState.memories.length = 0
      memoryState.memories.push(...fromDb)
    } else {
      // SQLite empty (migration failed?) — load from JSON instead
      const jsonLoaded = loadJson<Memory[]>(MEMORIES_PATH, [])
      if (jsonLoaded.length > 0) {
        console.log(`[cc-soul][memory] SQLite empty, falling back to JSON (${jsonLoaded.length} memories)`)
        useSQLite = false
        memoryState.memories.length = 0
        memoryState.memories.push(...jsonLoaded)
      } else {
        useSQLite = true // genuinely empty, use SQLite going forward
      }
    }

    const historyFromDb = sqliteGetRecentHistory(MAX_HISTORY)
    memoryState.chatHistory.length = 0
    memoryState.chatHistory.push(...historyFromDb)

    console.log(`[cc-soul][memory] loaded ${fromDb.length} memories from SQLite`)

    // Async: init embedder for vector search (non-blocking)
    initEmbedder().then(ready => {
      if (ready) {
        console.log(`[cc-soul][memory] embedder ready — vector search enabled`)
        // Backfill embeddings for existing memories in background
        backfillEmbeddings(50).catch(() => {})
      }
    }).catch(() => {})
  } else {
    // JSON fallback
    const loaded = loadJson<Memory[]>(MEMORIES_PATH, [])
    memoryState.memories.length = 0
    memoryState.memories.push(...loaded)

    const loadedHistory = loadJson<ChatTurn[]>(HISTORY_PATH, [])
    memoryState.chatHistory.length = 0
    memoryState.chatHistory.push(...loadedHistory)

    console.log(`[cc-soul][memory] loaded ${loaded.length} memories from JSON (SQLite unavailable)`)
  }

  // One-time fix: repair ts=0 memories on load
  let repaired = 0
  const loadNow = Date.now()
  for (const mem of memoryState.memories) {
    if (!mem.ts || mem.ts === 0) {
      mem.ts = mem.lastAccessed || (loadNow - Math.random() * 30 * 86400000)
      repaired++
    }
  }
  if (repaired > 0) {
    console.log(`[cc-soul][memory] repaired ${repaired} memories with ts=0`)
    saveMemories()
  }

  // One-time recovery: re-evaluate decayed memories after ts repair
  // Memories were wrongly decayed because ts=0 made age appear infinite
  const RECOVERY_FLAG = resolve(DATA_DIR, '.decay_recovered')
  if (!existsSync(RECOVERY_FLAG)) {
    let recovered = 0
    for (const mem of memoryState.memories) {
      if (mem.scope === 'decayed' && mem.ts > 0) {
        const age = Date.now() - mem.ts
        if (age < 90 * 86400000) {
          mem.scope = 'mid_term'
          mem.tier = 'mid_term'
          recovered++
        }
      }
    }
    if (recovered > 0) {
      console.log(`[cc-soul][memory] recovered ${recovered} wrongly-decayed memories`)
      saveMemories()
    }
    try { writeFileSync(RECOVERY_FLAG, Date.now().toString()) } catch (e: any) { console.error(`[cc-soul][memory] failed to write recovery flag: ${e.message}`) }
  }

  rebuildScopeIndex()
  rebuildRecallIndex(memoryState.memories)
}

export function saveMemories() {
  // Safety: never overwrite a non-empty file with an empty array
  if (memoryState.memories.length === 0) {
    try {
      const { size } = statSync(MEMORIES_PATH)
      if (size > 2) {
        console.error(`[cc-soul][memory] BLOCKED: refusing to overwrite ${size}-byte file with empty array`)
        return
      }
    } catch { /* file doesn't exist, ok to write */ }
  }
  // JSON backup alongside SQLite — prevents single-point-of-failure data loss
  if (memoryState.memories.length > 0) {
    debouncedSave(MEMORIES_PATH, memoryState.memories, 5000)
  }
}

// defaultVisibility + extractReasoning → memory-utils.ts

/**
 * Create a new version of an existing memory (bi-temporal update).
 * Old version gets validUntil=now, new version gets validFrom=now.
 * Preserves version chain in history field.
 */
export function createMemoryVersion(oldContent: string, newContent: string, scope?: string) {
  const existing = memoryState.memories.find(m =>
    m.content === oldContent && m.scope !== 'expired' && (!m.validUntil || m.validUntil === 0)
  )
  if (!existing) {
    // No existing memory found, just add new one
    addMemory(newContent, scope || 'fact')
    return
  }

  // Close old version
  existing.validUntil = Date.now()

  // Carry forward history chain
  const history = [...(existing.history || [])]
  history.push({ content: existing.content, ts: existing.ts })
  // Limit history to 10 versions
  if (history.length > 10) history.splice(0, history.length - 10)

  // Create new version
  const newMem: Memory = {
    content: newContent,
    scope: existing.scope,
    ts: Date.now(),
    userId: existing.userId,
    visibility: existing.visibility,
    channelId: existing.channelId,
    confidence: existing.confidence ?? 0.7,
    lastAccessed: Date.now(),
    tier: existing.tier || 'short_term',
    recallCount: 0,
    validFrom: Date.now(),
    validUntil: 0,
    tags: existing.tags,
    history,
  }
  memoryState.memories.push(newMem)
  if (useSQLite) { sqliteAddMemory(newMem) }
  saveMemories()
  appendAudit('memory_version', `[${existing.scope}] "${oldContent.slice(0, 50)}" → "${newContent.slice(0, 50)}"`)
}

/**
 * Query memory timeline: what was the state of a fact at a given point in time?
 */
export function queryMemoryTimeline(keyword: string): { content: string; from: number; until: number | null }[] {
  const results: { content: string; from: number; until: number | null }[] = []
  for (const mem of memoryState.memories) {
    if (!mem.content.toLowerCase().includes(keyword.toLowerCase())) continue
    if (typeof mem.validFrom === 'number') {
      results.push({
        content: mem.content,
        from: mem.validFrom,
        until: (mem.validUntil && mem.validUntil > 0) ? mem.validUntil : null,
      })
    }
    // Also check history chain
    if (mem.history) {
      for (const h of mem.history) {
        if (h.content.toLowerCase().includes(keyword.toLowerCase())) {
          results.push({ content: h.content, from: h.ts, until: mem.validFrom || mem.ts })
        }
      }
    }
  }
  results.sort((a, b) => b.from - a.from) // newest first
  return results
}

// detectMemoryPoisoning → memory-utils.ts

// ── #15 记忆图谱化：自动在新记忆和最近记忆之间建立关系边 ──
function autoLinkMemories(newMem: Memory) {
  const recent = memoryState.memories.slice(-6, -1) // 最近5条（不含自己）
  if (recent.length === 0) return
  const newTri = trigrams(newMem.content)
  const newLabel = newMem.content.slice(0, 20)
  for (const old of recent) {
    const oldTri = trigrams(old.content)
    const overlap = trigramSimilarity(newTri, oldTri)
    // 因果关系：新记忆包含因果关键词 + 话题重叠
    if (/因为|所以|导致|结果|于是|because|therefore/.test(newMem.content) && overlap > 0.15) {
      addRelation(newLabel, old.content.slice(0, 20), 'caused_by')
      continue // 一条旧记忆只建一种关系
    }
    // 矛盾关系：correction 覆盖 fact，内容高度相似
    if (newMem.scope === 'correction' && old.scope === 'fact' && overlap > 0.3) {
      addRelation(newLabel, old.content.slice(0, 20), 'contradicts')
      continue
    }
    // 时序关系：同一话题、时间间隔 < 5分钟
    if (Math.abs(newMem.ts - (old.ts || 0)) < 300000 && overlap > 0.2) {
      addRelation(newLabel, old.content.slice(0, 20), 'follows')
    }
  }
}

/**
 * 预期违背编码：只有出乎预料的信息才值得记忆
 * 基于 Predictive Coding Theory (Friston 2005)
 */
function computeSurprise(content: string, scope: string, _userId?: string): number {
  let score = 5 // 默认中等

  // 身份信息 → 高 surprise（重要但稀少）
  if (/名字|叫我|职业|住在|工作|年龄|生日|毕业/.test(content)) score = 9
  // 偏好信息 → 中高
  if (/喜欢|讨厌|偏好|习惯|最爱|受不了/.test(content)) score = 7
  // 纠正 → 高（意味着之前的理解错了）
  if (scope === 'correction') score = 8
  // 情绪爆发 → 高
  if (/[！!]{2,}|卧槽|崩溃|太开心|难受|焦虑/.test(content)) score += 2
  // 时效性信息 → 降级（"今天""刚才"这类信息过期快）
  if (/今天|刚才|现在|刚刚/.test(content)) score -= 2
  // 常见寒暄 → 极低
  if (/^(你好|嗯|好的|谢谢|哈哈|ok|行|收到)$/i.test(content.trim())) score = 1
  // 短内容 → 降级
  if (content.length < 10) score -= 1

  return Math.max(1, Math.min(10, score))
}

export function addMemory(content: string, scope: string, userId?: string, visibility?: 'global' | 'channel' | 'private', channelId?: string, situationCtx?: Memory['situationCtx']) {
  // Check skip flag from session (inclusion/exclusion control)
  try {
    const mod = getLazyModule('handler-state'); const getSessionState = mod?.getSessionState; const getLastActiveSessionKey = mod?.getLastActiveSessionKey
    const sess = getSessionState(getLastActiveSessionKey())
    if (sess?._skipNextMemory) {
      sess._skipNextMemory = false
      console.log('[cc-soul][memory] skipped by user request (别记这个)')
      return
    }
  } catch {}

  if (!content || content.length < 3) return

  // Reject system augment content that was accidentally fed back as memory
  const SYSTEM_PREFIXES = ['[Working Memory', '[当前面向:', '[隐私模式]', '[System]', '[安全警告]', '[元认知警告]']
  if (SYSTEM_PREFIXES.some(p => content.includes(p))) {
    console.log(`[cc-soul][memory-crud] REJECT (system augment): ${content.slice(0, 60)}`)
    return
  }

  // Memory integrity check: reject suspicious content (poisoning defense)
  if (detectMemoryPoisoning(content)) {
    console.log(`[cc-soul][memory-integrity] REJECT (poisoning pattern): ${content.slice(0, 60)}`)
    return
  }

  // Smart dedup: decide add/update/skip based on trigram similarity
  const decision = decideMemoryAction(content, scope)
  if (decision.action === 'skip') {
    console.log(`[cc-soul][memory-crud] SKIP (duplicate): ${content.slice(0, 60)}`)
    return
  }
  if (decision.action === 'update') {
    console.log(`[cc-soul][memory-crud] UPDATE #${decision.targetIndex}: ${content.slice(0, 60)}`)
    updateMemory(decision.targetIndex, content)
    return
  }

  // ── Surprise-Only Encoding (Predictive Coding Theory, Friston 2005) ──
  // 只有出乎预料的信息才值得记忆
  const surprise = computeSurprise(content, scope, userId)
  if (surprise <= 2 && scope !== 'correction' && scope !== 'preference') {
    console.log(`[cc-soul][memory-crud] SKIP (low surprise=${surprise}): ${content.slice(0, 60)}`)
    return // 太平凡了，不存储
  }

  // Auto-attach current emotional state to every memory
  let autoSituationCtx = situationCtx
  if (!autoSituationCtx) {
    try {
      const bodyMod = getLazyModule('body'); const body = bodyMod?.body
      if (body && typeof body.mood === 'number') {
        autoSituationCtx = { mood: body.mood, energy: body.energy }
      }
    } catch {}
  }

  const resolvedVisibility = visibility || defaultVisibility(scope)
  const newIndex = memoryState.memories.length
  const FACT_SCOPES = ['fact', 'preference', 'correction', 'discovery']
  // Auto-detect memory source: user_said (from user message), ai_inferred (from LLM analysis), system
  const autoSource: Memory['source'] =
    scope === 'correction' || scope === 'preference' || scope === 'gratitude' ? 'user_said'
    : scope === 'fact' || scope === 'event' || scope === 'visual' ? 'ai_observed'
    : scope === 'reflexion' || scope === 'curiosity' || scope === 'dream' ? 'ai_inferred'
    : 'system'
  // Auto-detect emotional intensity from emotion tag + scope
  const autoEmotionIntensity =
    content.includes('！') || content.includes('!') ? 0.8
    : scope === 'correction' ? 0.7  // corrections are emotionally significant
    : scope === 'gratitude' ? 0.6
    : 0.3  // default low intensity
  const newMem: Memory = {
    content, scope, ts: Date.now(), userId, visibility: resolvedVisibility, channelId,
    bayesAlpha: BAYES_DEFAULT_ALPHA, bayesBeta: BAYES_DEFAULT_BETA,
    confidence: BAYES_DEFAULT_ALPHA / (BAYES_DEFAULT_ALPHA + BAYES_DEFAULT_BETA), // ≈ 0.67
    lastAccessed: Date.now(),
    tier: 'short_term',
    recallCount: 0,
    source: autoSource,
    emotionIntensity: autoEmotionIntensity,
    importance: surprise, surprise,
    ...(FACT_SCOPES.includes(scope) ? { validFrom: Date.now(), validUntil: 0 } : {}),
    ...extractReasoning(content),
    ...(autoSituationCtx ? { situationCtx: autoSituationCtx } : {}),
  }
  // ── Decision causal recording: extract WHY from causal keywords ──
  const causalMatch = content.match(/(?:because|因为|由于|是因为|之所以.*?是|所以选.*?是因为)\s*[,，:：]?\s*(.{4,80}?)(?:[。.!！;；]|$)/i)
  if (causalMatch) newMem.because = causalMatch[1].trim()

  memoryState.memories.push(newMem)
  updateRecallIndex(newMem)

  // #15 记忆图谱化：自动建立记忆间关系边
  try { autoLinkMemories(newMem) } catch {}

  // Auto-extract structured facts (Mem0-style key-value triples)
  try { autoExtractFromMemory(content, scope, autoSource) } catch {}

  // Write to SQLite if available
  if (useSQLite) {
    sqliteAddMemory(newMem)
  }

  // ── Interference forgetting: new memory suppresses similar old memories ──
  if (FACT_SCOPES.includes(scope)) {
    suppressSimilarMemories(newMem)
  }

  // Smart eviction: dynamic threshold + topic protection
  if (memoryState.memories.length > MAX_MEMORIES) {
    // Score each memory: low score = eviction candidate
    const evictionScores = memoryState.memories.map((m, idx) => {
      const decay = timeDecay(m)
      const conf = m.confidence ?? 0.7
      const emotionBoost = m.emotion === 'important' ? 2.0 : m.emotion === 'painful' ? 1.5 : 1.0
      const scopeBoost = (m.scope === 'correction' || m.scope === 'reflexion' || m.scope === 'consolidated') ? 1.5 : 1.0
      const tagBoost = (m.tags && m.tags.length > 5) ? 1.3 : 1.0
      const score = decay * conf * emotionBoost * scopeBoost * tagBoost
      return { idx, score, scope: m.scope }
    })
    // Dynamic threshold: only evict memories scoring below median * 0.3
    const scores = evictionScores.map(e => e.score).sort((a, b) => a - b)
    const median = scores[Math.floor(scores.length / 2)] || 0.5
    const evictionThreshold = median * 0.3

    // Count memories per scope for topic protection
    const scopeCounts = new Map<string, number>()
    for (const m of memoryState.memories) {
      scopeCounts.set(m.scope, (scopeCounts.get(m.scope) || 0) + 1)
    }

    const toEvict = new Set<number>()
    // Sort ascending — lowest scores first
    evictionScores.sort((a, b) => a.score - b.score)
    for (const e of evictionScores) {
      if (e.score >= evictionThreshold) break // dynamic: stop once above threshold
      // Topic protection: if this scope has ≤2 remaining, don't evict
      const remaining = (scopeCounts.get(e.scope) || 0) - [...toEvict].filter(i => memoryState.memories[i]?.scope === e.scope).length
      if (remaining <= 2) continue
      toEvict.add(e.idx)
    }

    if (toEvict.size > 0) {
      const filtered = memoryState.memories.filter((_, i) => !toEvict.has(i))
      memoryState.memories.length = 0
      memoryState.memories.push(...filtered)
      rebuildScopeIndex() // full rebuild after eviction
      rebuildRecallIndex(memoryState.memories)
    }
  } else {
    // Incremental index update
    const arr = scopeIndex.get(scope) || []
    arr.push(memoryState.memories[memoryState.memories.length - 1])
    scopeIndex.set(scope, arr)
    // Incremental content index update
    const ck = content.slice(0, 50).toLowerCase()
    contentIndex.set(ck, content)
  }
  incrementalIDFUpdate(content)
  saveMemories()
  appendAudit('memory_add', `[${scope}] ${content.slice(0, 100)}`)

  // Async embedding store (fire-and-forget)
  // (already handled by sqliteAddMemory → storeEmbedding)

  // Async: queue semantic tag generation for the new memory (batched)
  // Bug #8 fix: don't pass index — eviction may shift it; use content+ts for stable lookup
  if (content.length > 10) {
    const lastIdx = memoryState.memories.length - 1
    if (lastIdx >= 0 && memoryState.memories[lastIdx].content === content && !memoryState.memories[lastIdx].tags) {
      queueForTagging(content, memoryState.memories[lastIdx].ts)
    }
  }
}

// ── Emotional memory tags: CLI judges emotional weight ──
export function addMemoryWithEmotion(content: string, scope: string, userId?: string, visibility?: 'global' | 'channel' | 'private', channelId?: string, emotion?: string) {
  addMemory(content, scope, userId, visibility, channelId)

  // Bug #9 fix: only set emotion if addMemory actually added/updated a new entry (not dedup skip)
  // Check if any memory has this content — handles both new-add and update scenarios
  const found = memoryState.memories.some(m => m.content === content)
  if (!found) return

  // Find the newly added memory (last one with matching content)
  const target = memoryState.memories.length > 0
    ? memoryState.memories.reduce<Memory | undefined>((best, m) =>
        m.content === content && m.ts >= (best?.ts ?? 0) ? m : best,
        undefined)
    : undefined
  if (!target) return

  if (emotion) {
    // Use provided emotion directly, skip CLI call
    const validEmotions = ['neutral', 'warm', 'important', 'painful', 'funny']
    const matched = validEmotions.find(e => emotion.includes(e)) || 'neutral'
    target.emotion = matched
    saveMemories()
  } else if (content.length > 20) {
    // Use rule-based emotion detection (no LLM call needed)
    try {
      const sigMod = getLazyModule('signals'); const detectEmotionLabel = sigMod?.detectEmotionLabel; const emotionLabelToLegacy = sigMod?.emotionLabelToLegacy
      const detected = detectEmotionLabel(content)
      if (detected.confidence > 0.4) {
        target.emotion = emotionLabelToLegacy(detected.label)
        // Store fine-grained label as well
        ;(target as any).emotionLabel = detected.label
        saveMemories()
      }
    } catch {}
  }
}

