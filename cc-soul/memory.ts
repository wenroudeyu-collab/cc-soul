/**
 * memory.ts — Memory System + Semantic Tag recall + TF-IDF fallback + Chat History
 * CLI-powered extraction + emotional tagging + semantic tag indexing.
 *
 * ═══════════ SECTION MAP (for future file split) ═══════════
 * SECTION 1: Imports, Trigram Utils, Mutable State & Index     (line ~1-103)
 * SECTION 2: Working Memory (per-session, not persisted)       (line ~104-184)
 * SECTION 3: Synonym Map & Time Decay Constants                (line ~186-242)
 * SECTION 4: Core Memory (always-available tiered knowledge)   (line ~244-361)
 * SECTION 5: Chat History                                      (line ~363-407)
 * SECTION 6: Semantic Tag Generation (CLI batch tagging)       (line ~409-493)
 * SECTION 7: Smart CRUD & Semantic Compression                 (line ~496-599)
 * SECTION 8: Memory CRUD (load/save/add/addWithEmotion)        (line ~600-841)
 * SECTION 9: Recall Engine (BM25 + tag + trigram + hybrid)     (line ~843-1193)
 * SECTION 10: Consolidation & Insight Generation               (line ~1197-1373)
 * SECTION 11: Recall Feedback & Associative Recall             (line ~1375-1507)
 * SECTION 12: Active Memory Commands (model-driven CRUD)       (line ~1510-1640)
 * SECTION 13: Contradiction Detection                          (line ~1642-1719)
 * SECTION 14: Predictive Memory & Session Summary              (line ~1721-1790)
 * SECTION 15: Network Knowledge & Episodic Memory              (line ~1792-1946)
 * SECTION 16: Time-Decay Tiered Memory                         (line ~1948-2033)
 * SECTION 17: Network Conflicts, SQLite Maintenance, Export    (line ~2035-end)
 * ════════════════════════════════════════════════════════════
 */

import { resolve } from 'path'
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'

import type { Memory } from './types.ts'
import { MEMORIES_PATH, HISTORY_PATH, DATA_DIR, loadJson, debouncedSave } from './persistence.ts'
import { spawnCLI } from './cli.ts'
import { getParam } from './auto-tune.ts'
import {
  initSQLite, migrateFromJSON, migrateHistoryFromJSON, isSQLiteReady,
  sqliteAddMemory, sqliteUpdateMemory, sqliteExpireMemory,
  sqliteRecall as sqliteRecallAsync, tagRecall as sqliteTagRecall,
  sqliteFindByContent, sqliteCount, sqliteGetAll,
  sqliteAddChatTurn, sqliteGetRecentHistory, sqliteTrimHistory,
  sqliteCleanupExpired, backfillEmbeddings, hasVectorSearch,
  sqliteUpdateRawLine, getDb,
} from './sqlite-store.ts'
import { initEmbedder } from './embedder.ts'
import { findMentionedEntities, getRelatedEntities, graphWalkRecall } from './graph.ts'
import { appendAudit } from './audit.ts'
import { isEnabled } from './features.ts'

/**
 * Sync memory confidence/scope changes to SQLite.
 * Call this whenever you modify mem.confidence or mem.scope in-memory.
 */
function syncToSQLite(mem: Memory, updates: { confidence?: number; scope?: string; tier?: string }) {
  if (!useSQLite) return
  const found = sqliteFindByContent(mem.content)
  if (found) {
    sqliteUpdateMemory(found.id, updates)
  }
}

/** Whether SQLite is the active storage backend (vs JSON fallback) */
let useSQLite = false

/** Whether memories have been loaded into memoryState (lazy) */
let _memoriesLoaded = false

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

// ── Recall rate tracking ──
export let recallStats = { total: 0, successful: 0, rate: 0 }
export function getRecallRate(): { total: number; successful: number; rate: number } {
  const rate = recallStats.total > 0
    ? (recallStats.successful / recallStats.total * 100)
    : (recallStats.rate * 100)  // use last-cycle rate after periodic reset
  return { total: recallStats.total, successful: recallStats.successful, rate }
}

// ── Recall impact tracking: which memories actually helped? ──
export const recallImpact = new Map<string, { recalled: number; helpedQuality: number; avgImpact: number }>()

export function trackRecallImpact(recalledContents: string[], qualityScore: number) {
  for (const content of recalledContents) {
    const key = content.slice(0, 80)
    const entry = recallImpact.get(key) || { recalled: 0, helpedQuality: 0, avgImpact: 0 }
    entry.recalled++
    entry.helpedQuality += qualityScore
    entry.avgImpact = entry.helpedQuality / entry.recalled
    recallImpact.set(key, entry)

    // ── Reinforcement feedback: propagate quality back to memory confidence ──
    // Good response (≥7) → this memory helped → boost confidence
    // Bad response (≤3) → this memory may have misled → reduce confidence
    if (entry.recalled >= 2) { // only after enough data points
      const mem = memoryState.memories.find(m => m.content.startsWith(key.slice(0, 40)) && m.scope !== 'expired')
      if (mem) {
        if (qualityScore >= 7) {
          mem.confidence = Math.min(1.0, (mem.confidence ?? 0.7) + 0.03)
        } else if (qualityScore <= 3) {
          mem.confidence = Math.max(0.1, (mem.confidence ?? 0.7) - 0.05)
          if (mem.confidence < 0.2) {
            console.log(`[cc-soul][recall-feedback] low-quality memory demoted: "${content.slice(0, 50)}" (avgImpact=${entry.avgImpact.toFixed(1)})`)
          }
        }
        syncToSQLite(mem, { confidence: mem.confidence })
      }
    }
  }
  // Cap map size
  if (recallImpact.size > 500) {
    const sorted = [...recallImpact.entries()].sort((a, b) => a[1].recalled - b[1].recalled)
    const deleteCount = recallImpact.size - 300
    for (const [key] of sorted.slice(0, deleteCount)) recallImpact.delete(key)
  }
}

export function getRecallImpactBoost(content: string): number {
  const key = content.slice(0, 80)
  const entry = recallImpact.get(key)
  if (!entry || entry.recalled < 3) return 1.0
  // High avg impact → boost, low → penalize
  if (entry.avgImpact >= 7) return 1.3
  if (entry.avgImpact >= 5) return 1.1
  if (entry.avgImpact < 3) return 0.7
  return 1.0
}

/** Fisher-Yates shuffle — unbiased random ordering */
function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

// ═══════════════════════════════════════════════════════════════════════════════
// Trigram Fuzzy Matching — fills the gap between exact-tag and TF-IDF
// ═══════════════════════════════════════════════════════════════════════════════

/** Extract character trigrams from text (works for CJK + Latin) — LRU cached (max 500) */
const _trigramCache = new Map<string, { set: Set<string>; ts: number }>()
function trigrams(text: string): Set<string> {
  const s = text.toLowerCase().replace(/\s+/g, ' ').trim()
  const cached = _trigramCache.get(s)
  if (cached) { cached.ts = Date.now(); return cached.set }
  const set = new Set<string>()
  for (let i = 0; i <= s.length - 3; i++) {
    set.add(s.slice(i, i + 3))
  }
  if (_trigramCache.size >= 500) {
    let oldestKey = '', oldestTs = Infinity
    for (const [k, v] of _trigramCache) { if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k } }
    if (oldestKey) _trigramCache.delete(oldestKey)
  }
  _trigramCache.set(s, { set, ts: Date.now() })
  return set
}

/** Jaccard similarity between two trigram sets: |A∩B| / |A∪B| */
function trigramSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const t of a) {
    if (b.has(t)) intersection++
  }
  const union = a.size + b.size - intersection
  return union > 0 ? intersection / union : 0
}

/** Exportable for reuse in evolution.ts rule dedup */
export { trigrams, trigramSimilarity }

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

const scopeIndex = new Map<string, Memory[]>()

// ── Content hash index for O(1) exact-match dedup in decideMemoryAction ──
const contentIndex = new Map<string, string>() // content前50字符(lowercase) → full content (stable across splices)

function rebuildContentIndex() {
  contentIndex.clear()
  for (let i = 0; i < memoryState.memories.length; i++) {
    const key = memoryState.memories[i].content.slice(0, 50).toLowerCase()
    contentIndex.set(key, memoryState.memories[i].content)
  }
}

function rebuildScopeIndex() {
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
// Synonym Map — lightweight semantic expansion for tag matching
// ═══════════════════════════════════════════════════════════════════════════════

const SYNONYM_MAP: Record<string, string[]> = {
  // Chinese synonyms
  '二进制': ['binary', 'mach-o', 'elf', '可执行文件', '逆向'],
  '逆向': ['reverse', '反编译', 'ida', 'frida', 'hook', '破解'],
  '代码': ['code', '函数', '脚本', 'script', '程序'],
  '部署': ['deploy', '上线', '发布', 'release', '服务器'],
  '数据库': ['database', 'sql', 'mysql', 'redis', 'mongodb', 'db'],
  '性能': ['performance', '优化', '速度', '延迟', 'latency'],
  '错误': ['error', 'bug', 'crash', '报错', '异常', 'exception'],
  '图片': ['image', 'ocr', '识别', '照片', 'screenshot', '截图'],
  '调试': ['debug', 'breakpoint', 'lldb', 'gdb', '断点'],
  '网络': ['network', 'http', 'tcp', 'socket', '请求', 'request'],
  '内存': ['memory', '泄漏', 'leak', 'malloc', '堆', 'heap'],
  '线程': ['thread', '并发', 'concurrent', '锁', 'lock', 'async'],
  // English synonyms
  'binary': ['二进制', 'mach-o', 'executable', 'elf'],
  'hook': ['frida', '拦截', 'intercept', 'swizzle'],
  'debug': ['调试', 'breakpoint', 'lldb', 'gdb'],
  'api': ['接口', 'endpoint', 'rest', 'http'],
  'deploy': ['部署', '上线', '发布', 'release'],
  'performance': ['性能', '优化', 'optimize', 'latency'],
  'error': ['错误', 'bug', 'crash', 'exception', '异常'],
  'memory': ['内存', 'leak', 'malloc', 'heap'],
  'thread': ['线程', '并发', 'concurrent', 'lock'],
  'python': ['py', 'pip', 'flask', 'django', '脚本'],
  'swift': ['swiftui', 'ios', 'xcode', 'objc', 'objective-c'],
  'test': ['测试', 'unittest', 'pytest', 'vitest', '单元测试'],
}

function expandQueryWithSynonyms(words: Set<string>): Set<string> {
  const expanded = new Set(words)
  for (const word of words) {
    const synonyms = SYNONYM_MAP[word]
    if (synonyms) {
      for (const s of synonyms) expanded.add(s)
    }
  }
  return expanded
}

// ═══════════════════════════════════════════════════════════════════════════════
// Time Decay — exponential decay with configurable half-life
// ═══════════════════════════════════════════════════════════════════════════════

function timeDecay(mem: Memory): number {
  const ageDays = (Date.now() - (mem.lastAccessed || mem.ts || Date.now())) / 86400000
  // Exponential decay: half-life configurable (default 90 days)
  return Math.pow(0.5, ageDays / getParam('memory.time_decay_halflife_days'))
}

const MAX_MEMORIES = 10000
const MAX_HISTORY = 100      // 保留最近 100 轮完整历史
const INJECT_HISTORY = 30    // 注入最近 30 轮到 prompt（token 限制）

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
// Semantic Tag Generation (CLI-powered)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Batch tag queue — instead of one CLI call per memory, batch up to 10.
 */
const tagQueue: { content: string; ts?: number; index?: number }[] = []
let tagBatchTimer: ReturnType<typeof setTimeout> | null = null

function queueForTagging(content: string, ts?: number, index?: number) {
  tagQueue.push({ content, ts, index })
  // Batch every 5 seconds or when queue reaches 10
  if (tagQueue.length >= 10) {
    flushTagQueue()
  } else if (!tagBatchTimer) {
    tagBatchTimer = setTimeout(flushTagQueue, 5000)
  }
}

function flushTagQueue() {
  if (tagBatchTimer) { clearTimeout(tagBatchTimer); tagBatchTimer = null }
  if (tagQueue.length === 0) return

  const batch = tagQueue.splice(0, 10) // take up to 10
  const contents = batch.map((b, i) => `${i + 1}. ${b.content.slice(0, 100)}`).join('\n')

  spawnCLI(
    `为以下${batch.length}条内容各生成5-8个语义标签。每行格式: 序号|标签1,标签2,...\n\n${contents}`,
    (output) => {
      if (!output) return
      const lines = output.split('\n').filter(l => l.includes('|'))
      for (const line of lines) {
        const [numStr, tagsStr] = line.split('|')
        const num = parseInt(numStr) - 1
        if (num >= 0 && num < batch.length && tagsStr) {
          const tags = tagsStr.split(/[,，]/).map(t => t.trim().toLowerCase()).filter(t => t.length >= 2 && t.length <= 20)
          if (tags.length >= 2) {
            // P0-5: use ts precise match first (ts is unique), index as fallback
            const item = batch[num]
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
            // Last resort: content-only match (original behavior)
            if (!target) {
              target = memoryState.memories.find(m => m.content === item.content && !m.tags)
            }
            if (target) {
              target.tags = tags
            }
          }
        }
      }
      saveMemories()
    },
    45000,
    'batch-tag'
  )
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
  if (best.sim < 0.3) return { action: 'add', targetIndex: -1 }

  // Medium path: moderate similarity — scope-aware decision
  const existingMem = memoryState.memories[best.idx]
  const dedupThreshold = getParam('memory.trigram_dedup_threshold')

  if (best.sim > dedupThreshold) {
    return { action: 'update', targetIndex: best.idx }
  }

  // Gray zone (0.3-0.7): for fact/preference/correction, fire async LLM arbitration
  const AUDN_SCOPES = ['fact', 'preference', 'correction', 'consolidated']
  if (AUDN_SCOPES.includes(scope || '') || AUDN_SCOPES.includes(existingMem.scope)) {
    // Fire-and-forget: LLM decides in background, result applied retroactively
    fireAUDNArbitration(newContent, scope || 'fact', candidates.slice(0, 3).map(c => ({
      content: memoryState.memories[c.idx].content,
      index: c.idx,
      sim: c.sim,
    })))
  }

  // Default: ADD now, LLM may UPDATE/DELETE later
  return { action: 'add', targetIndex: -1 }
}

/**
 * Async LLM arbitration for gray-zone memories.
 * Fires in background, applies ADD/UPDATE/DELETE/NOOP retroactively.
 */
let _audnQueue = 0
const MAX_AUDN_CONCURRENT = 3

function fireAUDNArbitration(
  newContent: string,
  scope: string,
  candidates: { content: string; index: number; sim: number }[],
) {
  if (_audnQueue >= MAX_AUDN_CONCURRENT) return // throttle
  _audnQueue++

  const existingList = candidates.map((c, i) =>
    `${i + 1}. [相似度${(c.sim * 100).toFixed(0)}%] ${c.content.slice(0, 120)}`
  ).join('\n')

  const prompt = [
    '新记忆和已有记忆可能冲突或重复。决定操作：',
    '',
    `新记忆 [${scope}]: ${newContent.slice(0, 150)}`,
    '',
    '已有相似记忆:',
    existingList,
    '',
    '回答格式（只回一行）:',
    '  ADD — 新记忆是全新信息，保留',
    '  UPDATE 序号 — 新记忆是对某条的更新/补充，合并内容',
    '  DELETE 序号 — 新记忆与某条矛盾，删除旧的',
    '  NOOP — 新记忆是冗余重复，丢弃',
    '',
    '如果 UPDATE，第二行写合并后的内容。',
  ].join('\n')

  spawnCLI(prompt, (output) => {
    _audnQueue--
    if (!output) return
    const line = output.trim().split('\n')[0].toUpperCase()

    if (line.startsWith('NOOP')) {
      // Remove the just-added memory
      const idx = memoryState.memories.findIndex(m => m.content === newContent && m.scope !== 'expired')
      if (idx >= 0) {
        memoryState.memories[idx].scope = 'expired'
        console.log(`[cc-soul][AUDN] NOOP: "${newContent.slice(0, 50)}" (redundant)`)
      }
    } else if (line.startsWith('DELETE')) {
      const num = parseInt(line.replace(/\D/g, ''))
      if (num >= 1 && num <= candidates.length) {
        const target = candidates[num - 1]
        if (target.index >= 0 && target.index < memoryState.memories.length) {
          memoryState.memories[target.index].scope = 'expired'
          console.log(`[cc-soul][AUDN] DELETE: "${memoryState.memories[target.index]?.content.slice(0, 50)}" (contradicted by new)`)
          saveMemories()
        }
      }
    } else if (line.startsWith('UPDATE')) {
      const num = parseInt(line.replace(/\D/g, ''))
      const mergedLine = output.trim().split('\n')[1]
      if (num >= 1 && num <= candidates.length && mergedLine && mergedLine.length > 10) {
        const target = candidates[num - 1]
        // Remove the just-added duplicate
        const newIdx = memoryState.memories.findIndex(m => m.content === newContent && m.scope !== 'expired')
        if (newIdx >= 0) memoryState.memories[newIdx].scope = 'expired'
        // Update the existing one with merged content
        if (target.index >= 0 && target.index < memoryState.memories.length) {
          updateMemory(target.index, mergedLine.trim().slice(0, 300))
          console.log(`[cc-soul][AUDN] UPDATE #${num}: merged "${mergedLine.trim().slice(0, 50)}"`)
        }
      }
    }
    // ADD: no action needed (already added synchronously)
  }, 30000)
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
// Memory Semantic Compression — condense verbose memories into compact facts
// ═══════════════════════════════════════════════════════════════════════════════

/** Redundant prefixes/fillers to strip from memory text */
const COMPRESS_PATTERNS: [RegExp, string][] = [
  // Remove "用户说/提到/表示/告诉我" etc. prefixes
  [/^(?:用户|他|她|对方)(?:说|提到|表示|告诉我|跟我说|反馈|回复|回答|补充|指出|觉得|认为|希望|想要|需要|打算|计划)\s*(?:了|过|着)?\s*(?:，|,)?\s*/g, ''],
  // Remove "我觉得/我认为/我发现" etc.
  [/(?:我觉得|我认为|我发现|我注意到|我看到|据说|好像|似乎|可能是|应该是)\s*(?:，|,)?\s*/g, ''],
  // Remove "其实/事实上/实际上/说实话/老实说"
  [/(?:其实|事实上|实际上|说实话|老实说|总的来说|简单来说|换句话说)\s*(?:，|,)?\s*/g, ''],
  // Remove "非常/特别/很/比较/相当" intensity modifiers (keep the adjective)
  [/(?:非常|特别|很|比较|相当|十分|极其|超级)\s*(?=[\u4e00-\u9fff])/g, ''],
  // Remove "的话/来说/而言/方面"
  [/(?:的话|来说|而言|方面|这块|这个)/g, ''],
  // Remove trailing "了/的/呢/吧/啊/嘛"
  [/[了的呢吧啊嘛]+\s*$/g, ''],
  // Collapse multiple spaces/punctuation
  [/\s{2,}/g, ' '],
  [/(?:，|,){2,}/g, '，'],
]

/**
 * Compress a verbose memory into a compact factual statement.
 * Pure text rules — no LLM call.
 */
export function compressMemory(memory: Memory): string {
  let text = memory.content.trim()

  // Short enough already — don't compress
  if (text.length <= 30) return text

  // Apply pattern-based compression
  for (const [pattern, replacement] of COMPRESS_PATTERNS) {
    text = text.replace(pattern, replacement)
  }

  // Trim leading/trailing punctuation
  text = text.replace(/^[，,、。：:；;\s]+/, '').replace(/[，,、。：:；;\s]+$/, '').trim()

  // If compression removed too much, return original
  if (text.length < 5) return memory.content.trim()

  return text
}
// ═══════════════════════════════════════════════════════════════════════════════
// Interference Forgetting — new memories suppress similar old memories
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * When a new fact/preference/correction is added, suppress (lower confidence of)
 * similar older memories. This prevents the 60K memory pile-up.
 *
 * Mechanism: trigram similarity > 0.6 with same scope → reduce confidence by 0.15.
 * If confidence drops below 0.2 → mark as expired (effectively forgotten).
 * Only suppresses memories older than 1 hour (avoid self-interference).
 */
function suppressSimilarMemories(newMem: Memory) {
  const newTri = trigrams(newMem.content)
  const MIN_AGE_MS = 3600000 // 1 hour — don't suppress very recent memories
  let suppressed = 0

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
      old.confidence = Math.max(0, (old.confidence ?? 0.7) - 0.15)
      if (old.confidence < 0.2) {
        old.scope = 'expired'
        console.log(`[cc-soul][interference] expired: "${old.content.slice(0, 50)}" (suppressed by new memory)`)
      }
      syncToSQLite(old, { confidence: old.confidence, scope: old.scope })
      suppressed++
      if (suppressed >= 5) break // cap per new memory
    }
  }

  if (suppressed > 0) {
    console.log(`[cc-soul][interference] ${suppressed} old memories suppressed`)
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

/**
 * Default visibility based on scope:
 * - fact/discovery → global (technical facts everyone can use)
 * - correction/preference → channel (specific to where it happened)
 * - proactive/curiosity/reflection → private
 * - others → channel
 */
function defaultVisibility(scope: string): 'global' | 'channel' | 'private' {
  if (scope === 'fact' || scope === 'discovery') return 'global'
  if (scope === 'correction' || scope === 'preference') return 'channel'
  if (scope === 'proactive' || scope === 'curiosity' || scope === 'reflection') return 'private'
  return 'channel'
}

// ── Chain-of-Thought reasoning extraction ──
function extractReasoning(content: string): { reasoning?: Memory['reasoning'] } {
  // Chinese: 因为X所以Y
  let m = content.match(/因为(.{3,80})所以(.{3,120})/)
  if (m) return { reasoning: { context: m[1].trim(), conclusion: m[2].trim(), confidence: 0.7 } }
  // English: based on X therefore Y / because X therefore Y
  m = content.match(/(?:based on|because)\s+(.{3,80})(?:therefore|so|thus)\s+(.{3,120})/i)
  if (m) return { reasoning: { context: m[1].trim(), conclusion: m[2].trim(), confidence: 0.7 } }
  // X → Y / X => Y (arrow notation)
  m = content.match(/(.{3,80})\s*[=\-]>\s*(.{3,120})/)
  if (m) return { reasoning: { context: m[1].trim(), conclusion: m[2].trim(), confidence: 0.6 } }
  return {}
}

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

/**
 * Memory poisoning defense: detect attempts to inject malicious content into memory store.
 * Checks for patterns that could manipulate future behavior via stored memories.
 */
function detectMemoryPoisoning(content: string): boolean {
  const patterns = [
    /\bignore\s+(all\s+)?previous\b/i,
    /忽略(之前|上面|所有)(的)?指令/,
    /\byou\s+(are|must|should)\s+now\b/i,
    /\bfrom\s+now\s+on\b/i,
    /\bnew\s+(instructions?|rules?|persona)\s*:/i,
    /\bsystem\s*prompt\s*:/i,
    /\boverride\s+(all|system|safety|rules)\b/i,
    /你(现在|必须|应该)(是|变成|扮演)/,
    /\[INST\]|\[SYS\]|<<SYS>>|<\|im_start\|>/i,
  ]
  return patterns.some(p => p.test(content))
}

export function addMemory(content: string, scope: string, userId?: string, visibility?: 'global' | 'channel' | 'private', channelId?: string, situationCtx?: Memory['situationCtx']) {
  // Check skip flag from session (inclusion/exclusion control)
  try {
    const { getSessionState, getLastActiveSessionKey } = require('./handler-state.ts')
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

  // Auto-attach current emotional state to every memory
  let autoSituationCtx = situationCtx
  if (!autoSituationCtx) {
    try {
      const { body } = require('./body.ts')
      if (body && typeof body.mood === 'number') {
        autoSituationCtx = { mood: body.mood, energy: body.energy }
      }
    } catch {}
  }

  const resolvedVisibility = visibility || defaultVisibility(scope)
  const newIndex = memoryState.memories.length
  const FACT_SCOPES = ['fact', 'preference', 'correction', 'discovery']
  const newMem: Memory = {
    content, scope, ts: Date.now(), userId, visibility: resolvedVisibility, channelId,
    confidence: 0.7,
    lastAccessed: Date.now(),
    tier: 'short_term',
    recallCount: 0,
    ...(FACT_SCOPES.includes(scope) ? { validFrom: Date.now(), validUntil: 0 } : {}),
    ...extractReasoning(content),
    ...(autoSituationCtx ? { situationCtx: autoSituationCtx } : {}),
  }
  memoryState.memories.push(newMem)

  // Write to SQLite if available
  if (useSQLite) {
    sqliteAddMemory(newMem)
  }

  // ── Interference forgetting: new memory suppresses similar old memories ──
  if (FACT_SCOPES.includes(scope)) {
    suppressSimilarMemories(newMem)
  }

  // Memory competition: new memory suppresses similar old ones
  if (scope === 'preference' || scope === 'fact') {
    const newTri = trigrams(content)
    for (const old of memoryState.memories) {
      if (old === newMem) continue
      if (old.scope !== scope || old.scope === 'expired') continue
      const sim = trigramSimilarity(newTri, trigrams(old.content))
      if (sim > 0.4 && sim < 0.9) {
        // Similar but not duplicate — suppress old one's confidence
        old.confidence = Math.max(0.1, (old.confidence ?? 0.7) - 0.15)
        syncToSQLite(old, { confidence: old.confidence })
      }
    }
  }

  // Smart eviction: score-based instead of brute-force oldest-20%
  if (memoryState.memories.length > MAX_MEMORIES) {
    // Score each memory: low score = eviction candidate
    const evictionScores = memoryState.memories.map((m, idx) => {
      const decay = timeDecay(m)
      const conf = m.confidence ?? 0.7
      const emotionBoost = m.emotion === 'important' ? 2.0 : m.emotion === 'painful' ? 1.5 : 1.0
      const scopeBoost = (m.scope === 'correction' || m.scope === 'reflexion' || m.scope === 'consolidated') ? 1.5 : 1.0
      const tagBoost = (m.tags && m.tags.length > 5) ? 1.3 : 1.0
      const score = decay * conf * emotionBoost * scopeBoost * tagBoost
      return { idx, score }
    })
    // Sort ascending — lowest scores get evicted
    evictionScores.sort((a, b) => a.score - b.score)
    const toEvict = new Set(evictionScores.slice(0, Math.floor(MAX_MEMORIES * 0.2)).map(e => e.idx))
    const filtered = memoryState.memories.filter((_, i) => !toEvict.has(i))
    memoryState.memories.length = 0
    memoryState.memories.push(...filtered)
    rebuildScopeIndex() // full rebuild after eviction
  } else {
    // Incremental index update
    const arr = scopeIndex.get(scope) || []
    arr.push(memoryState.memories[memoryState.memories.length - 1])
    scopeIndex.set(scope, arr)
    // Incremental content index update
    const ck = content.slice(0, 50).toLowerCase()
    contentIndex.set(ck, content)
  }
  invalidateIDF()
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
      const { detectEmotionLabel, emotionLabelToLegacy } = require('./signals.ts')
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

// ═══════════════════════════════════════════════════════════════════════════════
// BM25 scoring (replaces TF-IDF — better term frequency saturation + doc length normalization)
// ═══════════════════════════════════════════════════════════════════════════════

let idfCache: Map<string, number> | null = null
let avgDocLenCache: number | null = null
let lastIdfBuildTs = 0

// BM25 parameters — now tunable via auto-tune
function getBM25K1() { return getParam('memory.bm25_k1') }
function getBM25B() { return getParam('memory.bm25_b') }

function buildIDF(): Map<string, number> {
  if (idfCache && idfCache.size > 0) return idfCache
  const df = new Map<string, number>()
  const N = memoryState.memories.length || 1
  let totalDocLen = 0
  for (const mem of memoryState.memories) {
    const words = (mem.content.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase())
    totalDocLen += words.length
    const unique = new Set(words)
    for (const w of unique) {
      df.set(w, (df.get(w) || 0) + 1)
    }
  }
  const idf = new Map<string, number>()
  for (const [word, count] of df) {
    idf.set(word, Math.log(N / (1 + count)))
  }
  idfCache = idf
  avgDocLenCache = N > 0 ? totalDocLen / N : 1
  lastIdfBuildTs = Date.now()
  return idf
}

function bm25Score(queryWords: Set<string>, doc: string, avgDocLen: number): number {
  const docWords = (doc.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase())
  const docLen = docWords.length
  if (docLen === 0) return 0

  const tf = new Map<string, number>()
  for (const w of docWords) tf.set(w, (tf.get(w) || 0) + 1)

  let score = 0
  for (const qw of queryWords) {
    // Check synonyms too
    const expandedTerms = [qw, ...(SYNONYM_MAP[qw] || [])]
    for (const term of expandedTerms) {
      const termFreq = tf.get(term) || 0
      if (termFreq === 0) continue
      const idfVal = idfCache?.get(term) || 1.0
      // BM25 formula
      const k1 = getBM25K1(), b = getBM25B()
      const numerator = termFreq * (k1 + 1)
      const denominator = termFreq + k1 * (1 - b + b * (docLen / avgDocLen))
      score += idfVal * (numerator / denominator)
      break // only count best synonym match per query word
    }
  }
  return score
}

// ═══════════════════════════════════════════════════════════════════════════════
// Recall: tag-based (primary) + TF-IDF (fallback for untagged)
// ═══════════════════════════════════════════════════════════════════════════════

/** Internal recall that preserves `score` on returned memories (for fusion ranking). */
function recallWithScores(msg: string, topN = 3, userId?: string, channelId?: string, moodCtx?: { mood: number; alertness: number }): (Memory & { score: number })[] {
  if (memoryState.memories.length === 0 || !msg) return []

  // Extract query keywords (Chinese 2+ char sequences + English 3+ char words)
  const rawWords = new Set(
    (msg.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase())
  )
  if (rawWords.size === 0) return []

  // Graph-augmented query expansion
  const mentionedEntities = findMentionedEntities(msg)
  const relatedEntities = mentionedEntities.length > 0
    ? getRelatedEntities(mentionedEntities, 2, 8)
    : []
  const expansionWords = new Set<string>()
  for (const entity of relatedEntities) {
    const words = (entity.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map((w: string) => w.toLowerCase())
    for (const w of words) {
      if (!rawWords.has(w)) expansionWords.add(w)
    }
  }

  // Expand with synonyms for broader semantic matching
  const queryWords = expandQueryWithSynonyms(rawWords)

  // Lazy-build IDF + avgDocLen only if needed (for BM25 scoring)
  let idf: Map<string, number> | null = null
  let avgDocLen = 1

  // Lazy-build trigrams for fuzzy matching (outside loop)
  let queryTrigrams: Set<string> | null = null

  // Use scopeIndex to skip expired/decayed scopes in bulk instead of per-item check
  const SKIP_SCOPES = new Set(['expired', 'decayed'])
  const activeMemories: Memory[] = []
  for (const [scope, mems] of scopeIndex) {
    if (SKIP_SCOPES.has(scope)) continue
    for (const m of mems) activeMemories.push(m)
  }

  const scored: (Memory & { score: number })[] = []
  for (const mem of activeMemories) {
    // ── Visibility filter ──
    // Existing memories without visibility field → treat as 'global' (backward compat)
    const vis = mem.visibility || 'global'
    if (vis === 'channel' && channelId && mem.channelId && mem.channelId !== channelId) continue
    if (vis === 'private' && userId && mem.userId && mem.userId !== userId) continue
    // If no channelId provided (e.g. DM), include private + global (skip channel-scoped from other channels)
    let sim = 0

    if (mem.tags && mem.tags.length > 0) {
      // ── Layer 1: Tag-based matching: semantic overlap between query words and tags ──
      // Optimized: pre-join tags into a single string for fast substring check
      const tagStr = mem.tags.join('|').toLowerCase()
      let hits = 0
      for (const qw of queryWords) {
        if (tagStr.includes(qw)) { hits++; continue }
        // Reverse check: any tag is substring of query word
        if (mem.tags.some(t => qw.includes(t))) hits++
      }
      sim = hits / Math.max(1, queryWords.size)

      // ── Layer 2: Trigram fuzzy boost — catches typos, partial matches, morphological variants ──
      if (sim < 0.3) {
        // Tag matching missed, try trigram on content directly
        if (!queryTrigrams) queryTrigrams = trigrams(msg)
        const memTrigrams = trigrams(mem.content)
        const triSim = trigramSimilarity(queryTrigrams, memTrigrams)
        // Blend: take the better of tag sim and trigram sim (weighted down slightly)
        sim = Math.max(sim, triSim * 0.8)
      }
    } else {
      // ── Layer 2: Trigram matching for untagged memories (before expensive TF-IDF) ──
      if (!queryTrigrams) queryTrigrams = trigrams(msg)
      const memTrigrams = trigrams(mem.content)
      const triSim = trigramSimilarity(queryTrigrams, memTrigrams)

      if (triSim > 0.1) {
        sim = triSim * 0.8
      } else {
        // ── Layer 3: BM25 fallback for untagged memories with no trigram match ──
        if (!idf) {
          idf = buildIDF()
          avgDocLen = avgDocLenCache || 1
        }
        sim = bm25Score(queryWords, mem.content, avgDocLen)
      }
    }

    if (sim < 0.03) continue

    // Weighted scoring: recency + scope boost + emotion boost + userId boost + confidence + time decay
    // Exponential time decay: memories not recalled in 30+ days lose weight fast
    const ageDays = mem.ts > 0 ? (Date.now() - mem.ts) / 86400000 : 30
    const ageDecayRate = getParam('memory.age_decay_rate')
    const recency = Math.exp(-ageDays * ageDecayRate) // exponential decay
    // Bonus for recently recalled memories (tags indicate they've been useful)
    const usageBoost = (mem.tags && mem.tags.length > 5) ? 1.2 : 1.0
    const scopeBoost = (mem.scope === 'preference' || mem.scope === 'fact') ? 1.3 :
                       (mem.scope === 'correction') ? 1.5 : 1.0
    let emotionBoost = 1.0
    // Legacy labels
    if (mem.emotion === 'important') emotionBoost = 1.4
    else if (mem.emotion === 'painful') emotionBoost = 1.3
    else if (mem.emotion === 'warm') emotionBoost = 1.2
    // New fine-grained labels (stored in emotionLabel)
    const eLabel = (mem as any).emotionLabel
    if (eLabel === 'anger' || eLabel === 'anxiety') emotionBoost = Math.max(emotionBoost, 1.4)
    else if (eLabel === 'pride' || eLabel === 'relief') emotionBoost = Math.max(emotionBoost, 1.3)
    else if (eLabel === 'frustration' || eLabel === 'sadness') emotionBoost = Math.max(emotionBoost, 1.3)
    // #5 Multi-user memory isolation: same user ×2.0, global ×1.0, other user's private → already filtered above
    const userBoost = (userId && mem.userId && mem.userId === userId) ? 2.0
                    : (userId && mem.userId && mem.userId !== userId) ? 0.7 : 1.0
    // #3 HOT/WARM/COLD tier weighting
    const lastAcc = mem.lastAccessed || mem.ts || 0
    const accAgeDays = (Date.now() - lastAcc) / 86400000
    const tierWeight = ((accAgeDays <= 1 || (mem.recallCount ?? 0) >= 5) ? 1.5   // HOT
                      : (accAgeDays <= 7) ? 1.0                                    // WARM
                      : (accAgeDays <= 30) ? 0.8 : 0.5)                            // COLD
    const consolidatedBoost = mem.scope === 'consolidated' ? 1.5 : mem.scope === 'pinned' ? 2.0 : 1.0
    const reflexionBoost = mem.scope === 'reflexion' ? 2.0 : 1.0
    // Confidence factor (time decay removed — recency already covers age-based weighting)
    const confidenceWeight = mem.confidence ?? 0.7
    // Temporal validity: past facts (validUntil set and elapsed) get reduced weight but not zero
    const temporalWeight = (mem.validUntil && mem.validUntil > 0 && mem.validUntil < Date.now()) ? 0.3 : 1.0

    // Graph-augmented boost: memories mentioning related entities get a boost
    let graphBoost = 1.0
    if (expansionWords.size > 0) {
      const memLower = mem.content.toLowerCase()
      let graphHits = 0
      for (const w of expansionWords) {
        if (memLower.includes(w)) graphHits++
      }
      if (graphHits > 0) {
        graphBoost = 1.0 + Math.min(0.5, graphHits * 0.15)
      }
    }

    const impactBoost = getRecallImpactBoost(mem.content)
    // Archived memories participate in search but with reduced weight (DAG archive)
    const archiveWeight = mem.scope === 'archived' ? 0.3 : 1.0

    // ── Emotion-driven recall: mood/alertness influence memory scoring ──
    let moodMatchBoost = 1.0
    if (moodCtx) {
      // Mood congruence: positive mood boosts warm memories, negative mood boosts painful memories
      if (moodCtx.mood > 0.3 && mem.emotion === 'warm') moodMatchBoost = 1.3
      else if (moodCtx.mood < -0.3 && mem.emotion === 'painful') moodMatchBoost = 1.3
      else if (moodCtx.mood < -0.3 && mem.emotion === 'warm') moodMatchBoost = 0.8
      // High alertness: boost corrections and important memories (hyper-vigilant state)
      if (moodCtx.alertness > 0.7 && (mem.emotion === 'important' || mem.scope === 'correction')) moodMatchBoost *= 1.3

      // Fine-grained emotion congruence: same emotion type → boost
      if (eLabel && moodCtx) {
        try {
          const { lastDetectedEmotion } = require('./body.ts')
          if (lastDetectedEmotion && eLabel === lastDetectedEmotion.label) {
            moodMatchBoost *= 1.4 // same emotion state → strong context match
          }
        } catch {}
      }

      // Situational context match: same mood context at creation → boost
      if (mem.situationCtx?.mood !== undefined) {
        const moodDelta = Math.abs(moodCtx.mood - mem.situationCtx.mood)
        if (moodDelta < 0.3) moodMatchBoost *= 1.2 // similar mood state → context-dependent recall
      }
    }

    scored.push({ ...mem, score: sim * recency * scopeBoost * emotionBoost * userBoost * consolidatedBoost * usageBoost * reflexionBoost * confidenceWeight * temporalWeight * graphBoost * tierWeight * impactBoost * archiveWeight * moodMatchBoost })
  }

  // ── Spreading Activation: memories activate related memories ──
  // High-scoring memories "wake up" other memories that share keywords
  if (scored.length >= 3) {
    const topActivators = scored.filter(s => s.score > 0.1).slice(0, 3)
    const activatedWords = new Set<string>()
    for (const act of topActivators) {
      const words = (act.content.match(/[\u4e00-\u9fff]{2,4}|[a-zA-Z]{3,}/gi) || [])
      words.forEach(w => activatedWords.add(w.toLowerCase()))
    }
    // Boost other scored memories that share keywords with top activators
    for (const s of scored) {
      if (topActivators.includes(s)) continue
      const sWords = (s.content.match(/[\u4e00-\u9fff]{2,4}|[a-zA-Z]{3,}/gi) || []).map(w => w.toLowerCase())
      let activationHits = 0
      for (const w of sWords) { if (activatedWords.has(w)) activationHits++ }
      if (activationHits >= 2) {
        s.score *= (1 + activationHits * 0.15) // spreading activation boost
      }
    }
  }

  scored.sort((a, b) => b.score - a.score)
  const topResults = scored.slice(0, topN)

  // ── Graph Walk Recall: supplement with memories reachable via entity graph BFS ──
  if (mentionedEntities.length > 0 && topResults.length < topN) {
    // Pre-build content→Memory map for O(1) lookup instead of repeated .find()
    const contentMap = new Map<string, Memory>()
    for (const m of memoryState.memories) contentMap.set(m.content, m)

    const topContents = new Set(topResults.map(r => r.content))
    for (const entity of mentionedEntities) {
      const walked = graphWalkRecall(entity, memoryState.memories, 2, 6)
      for (const wContent of walked) {
        if (topContents.has(wContent) || topResults.length >= topN) break
        const mem = contentMap.get(wContent)
        if (mem) {
          topResults.push({ ...mem, score: 0 })
          topContents.add(wContent)
        }
      }
    }
  }

  // Pre-build content+ts key→Memory map for O(1) recall boost lookup
  const memLookup = new Map<string, Memory>()
  for (const m of memoryState.memories) memLookup.set(`${m.content}\0${m.ts}`, m)

  // Boost confidence + update lastAccessed + recallCount on recalled memories
  for (const result of topResults) {
    const mem = memLookup.get(`${result.content}\0${result.ts}`)
    if (mem) {
      mem.lastAccessed = Date.now()
      mem.confidence = Math.min(1.0, (mem.confidence ?? 0.7) + 0.02)
      mem.recallCount = (mem.recallCount ?? 0) + 1
      mem.lastRecalled = Date.now()
      syncToSQLite(mem, { confidence: mem.confidence, recallCount: mem.recallCount, lastAccessed: mem.lastAccessed, lastRecalled: mem.lastRecalled })
      // Memory reconsolidation: blend current context into recalled memory
      if (mem.recallCount && mem.recallCount >= 3) {
        // After 3+ recalls, memory starts absorbing context
        if (!mem.recallContexts) mem.recallContexts = []
        const ctxSnippet = msg.slice(0, 40)
        if (!mem.recallContexts.includes(ctxSnippet)) {
          mem.recallContexts.push(ctxSnippet)
          if (mem.recallContexts.length > 5) mem.recallContexts.shift()
        }
      }
    }
  }
  if (topResults.length > 0) saveMemories()

  // ── Hybrid: merge with OpenClaw native memory (FTS5 full-text search) ──
  try {
    const ocMemDb = resolve(homedir(), '.openclaw/memory/main.sqlite')
    if (existsSync(ocMemDb)) {
      const { DatabaseSync } = require('node:sqlite')
      const db = new DatabaseSync(ocMemDb, { open: true, readOnly: true })
      const ftsResults = db.prepare(
        `SELECT text, path FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`
      ).all(msg.replace(/['"*(){}^~<>|\\]/g, '').replace(/\b(AND|OR|NOT|NEAR)\b/gi, ''), topN) as { text: string; path: string }[]
      db.close()

      if (ftsResults.length > 0) {
        // Merge: add OpenClaw results that aren't already in cc-soul results
        const existingContents = new Set(topResults.map(r => r.content.slice(0, 200)))
        for (const fts of ftsResults) {
          if (!existingContents.has(fts.text.slice(0, 200))) {
            topResults.push({
              content: fts.text,
              scope: 'fact',
              ts: Date.now(),
              source: 'openclaw-memory',
              confidence: 0.7,
              recallCount: 0,
              lastAccessed: Date.now(),
            } as Memory)
          }
        }
        console.log(`[cc-soul][memory-hybrid] merged ${ftsResults.length} OpenClaw FTS results`)
      }
    }
  } catch { /* OpenClaw memory unavailable — no problem, cc-soul recall is primary */ }

  // ── Track recall stats ──
  recallStats.total++
  if (topResults.length > 0) recallStats.successful++
  // P0-1: periodic reset to prevent unbounded growth
  if (recallStats.total > 1000) {
    recallStats.rate = recallStats.successful / recallStats.total
    recallStats.total = 0
    recallStats.successful = 0
  }

  return topResults
}

/** Public recall — strips internal score field from results. Merges OpenClaw native memory if available. */
export function recall(msg: string, topN = 3, userId?: string, channelId?: string, moodCtx?: { mood: number; alertness: number }): Memory[] {
  // ── Fast path: SQLite direct query (no need for loadMemories) ──
  // If memories haven't been loaded into memoryState yet, use SQLite directly.
  // This avoids the 4-5 second loadMemories() cost on first call.
  let ccResults: Memory[]

  if (!_memoriesLoaded && ensureSQLiteReady()) {
    // Use synchronous tagRecall — queries SQLite directly
    ccResults = sqliteTagRecall(msg, topN, userId, channelId)
  } else if (_memoriesLoaded) {
    // Memories already in-memory, use the full scoring pipeline
    ccResults = recallWithScores(msg, topN, userId, channelId, moodCtx).map(({ score, ...rest }) => rest) as Memory[]
  } else {
    // No SQLite, no in-memory — lightweight JSON file search (no full load)
    ccResults = recallFromJsonFile(msg, topN)
  }

  // ── Async vector recall: fire-and-forget, cache for next turn ──
  if (ensureSQLiteReady() && hasVectorSearch()) {
    const cacheKey = `${userId || ''}:${channelId || ''}`
    sqliteRecallAsync(msg, topN, userId, channelId).then(vecResults => {
      if (vecResults.length > 0) {
        console.log(`[cc-soul][recall] vector search found ${vecResults.length} semantic matches`)
        _lastVectorResults = vecResults.slice(0, 5)
        _lastVectorResultsKey = cacheKey
      }
    }).catch(() => {})
  }

  // Merge OpenClaw native memory results (best-effort, non-blocking)
  try {
    const nativeResults = recallFromOpenClawMemory(msg, topN)
    if (nativeResults.length > 0) {
      // Dedup by content
      const seen = new Set(ccResults.map(m => m.content.slice(0, 60)))
      for (const m of nativeResults) {
        if (!seen.has(m.content.slice(0, 60))) {
          ccResults.push(m)
          seen.add(m.content.slice(0, 60))
        }
      }
    }
  } catch (_) {}

  // Merge cached vector results from previous turn (available synchronously)
  const cacheKeyCheck = `${userId || ''}:${channelId || ''}`
  if (_lastVectorResults.length > 0 && _lastVectorResultsKey === cacheKeyCheck) {
    const seen = new Set(ccResults.map(m => m.content.slice(0, 60)))
    for (const m of _lastVectorResults) {
      if (!seen.has(m.content.slice(0, 60))) {
        ccResults.push(m)
        seen.add(m.content.slice(0, 60))
      }
    }
  }

  // Adaptive depth: if too few results, expand search
  if (ccResults.length < topN && _memoriesLoaded) {
    const expanded = recallWithScores(msg, topN * 3, userId, channelId, moodCtx)
      .map(({ score, ...rest }) => rest) as Memory[]
    const seen = new Set(ccResults.map(m => m.content.slice(0, 60)))
    for (const m of expanded) {
      if (!seen.has(m.content.slice(0, 60)) && ccResults.length < topN) {
        ccResults.push(m)
        seen.add(m.content.slice(0, 60))
      }
    }
  }

  // Fusion rerank: sort merged results by relevance
  if (ccResults.length > topN) {
    const queryTri = trigrams(msg)
    ccResults.sort((a, b) => {
      const simA = trigramSimilarity(queryTri, trigrams(a.content))
      const simB = trigramSimilarity(queryTri, trigrams(b.content))
      const scopeA = (a.scope === 'preference' || a.scope === 'fact') ? 1.3 : a.scope === 'correction' ? 1.5 : 1.0
      const scopeB = (b.scope === 'preference' || b.scope === 'fact') ? 1.3 : b.scope === 'correction' ? 1.5 : 1.0
      return (simB * scopeB) - (simA * scopeA)
    })
    ccResults = ccResults.slice(0, topN)
  }

  return ccResults.slice(0, topN)
}

// Cache vector results from async search for synchronous use in next turn
let _lastVectorResults: Memory[] = []
let _lastVectorResultsKey = ''

// ── Read from OpenClaw native memory (cc.sqlite FTS) ──

let _openclawMemDb: any = null
let _openclawMemDbAttempted = false

function getOpenClawMemDb() {
  if (_openclawMemDbAttempted) return _openclawMemDb
  _openclawMemDbAttempted = true
  try {
    const Database = require('better-sqlite3')
    const dbPath = resolve(homedir(), '.openclaw/memory/cc.sqlite')
    if (existsSync(dbPath)) {
      _openclawMemDb = new Database(dbPath, { readonly: true, fileMustExist: true })
    }
  } catch (_) {
    // better-sqlite3 not available or db doesn't exist
  }
  return _openclawMemDb
}

/** Lightweight JSON file search — reads file, filters by keyword, no full memory load */
function recallFromJsonFile(msg: string, topN: number): Memory[] {
  try {
    const memPath = resolve(DATA_DIR, 'memories.json')
    if (!existsSync(memPath)) return []
    const data = JSON.parse(readFileSync(memPath, 'utf-8')) as Memory[]
    const keywords = (msg.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase())
    if (keywords.length === 0) return []

    const scored: (Memory & { score: number })[] = []
    for (const m of data) {
      if (m.scope === 'expired' || m.scope === 'decayed') continue
      const content = m.content.toLowerCase()
      const tags = (m.tags || []).map((t: string) => t.toLowerCase())
      let hits = 0
      for (const kw of keywords) {
        if (content.includes(kw) || tags.some(t => t.includes(kw) || kw.includes(t))) hits++
      }
      if (hits === 0) continue
      const sim = hits / Math.max(1, keywords.length)
      const scopeBoost = m.scope === 'preference' || m.scope === 'fact' ? 1.3 : m.scope === 'correction' ? 1.5 : 1.0
      const archiveWeight = m.scope === 'archived' ? 0.3 : 1.0
      scored.push({ ...m, score: sim * scopeBoost * archiveWeight })
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topN).map(({ score, ...rest }) => rest) as Memory[]
  } catch (e: any) {
    console.error(`[cc-soul][recall] JSON file search failed: ${e.message}`)
    return []
  }
}

function recallFromOpenClawMemory(msg: string, topN: number): Memory[] {
  const db = getOpenClawMemDb()
  if (!db) return []

  try {
    // Use FTS if available
    const results = db.prepare(
      `SELECT text, updated_at FROM chunks WHERE text LIKE ? ORDER BY updated_at DESC LIMIT ?`
    ).all(`%${msg.slice(0, 20)}%`, topN) as any[]

    return results.map((r: any) => ({
      content: r.text,
      scope: 'fact' as string,
      ts: r.updated_at || Date.now(),
      emotion: 'neutral' as string,
      confidence: 0.5,
      tier: 'long_term' as const,
    }))
  } catch (_) {
    return []
  }
}

/**
 * Multi-modal recall fusion: combines tag/trigram/BM25 (recall()) with SQLite vector search.
 * Results found by multiple strategies get a confidence boost (ensemble agreement).
 * Falls back to recall() when vector search is unavailable or errors.
 */
let cachedFusedRecall: { query: string; results: Memory[]; ts: number } | null = null

export function getCachedFusedRecall(): Memory[] {
  if (!cachedFusedRecall) return []
  if (Date.now() - cachedFusedRecall.ts > 300000) { // 5 min expiry
    cachedFusedRecall = null
    return []
  }
  return cachedFusedRecall.results
}

export async function recallFused(msg: string, topN = 3, userId?: string, channelId?: string): Promise<Memory[]> {
  if (memoryState.memories.length === 0 || !msg) return []

  // Strategy 1: existing text-based recall (tag + trigram + BM25) — with scores for fusion ranking
  const textResults = recallWithScores(msg, topN * 2, userId, channelId)

  // Strategy 2: SQLite vector search (async, optional)
  let vectorResults: Memory[] = []
  if (hasVectorSearch() && isSQLiteReady()) {
    try {
      vectorResults = await sqliteRecallAsync(msg, topN * 2, userId, channelId)
    } catch {
      // vector search failed — continue with text-only results
    }
  }

  if (vectorResults.length === 0) {
    return textResults.slice(0, topN)
  }

  // Fusion: merge results from both strategies and re-rank
  const fusionMap = new Map<string, { memory: Memory; textScore: number; vecScore: number; sources: number }>()

  // Normalize scores relative to each strategy's top result
  const maxTextScore = textResults[0]?.score || 1
  const maxVecScore = (vectorResults[0] as any)?.score || 1

  for (const m of textResults) {
    const key = m.content + '|' + m.ts
    fusionMap.set(key, {
      memory: m,
      textScore: (m.score || 0) / maxTextScore,
      vecScore: 0,
      sources: 1,
    })
  }

  for (const m of vectorResults) {
    const key = m.content + '|' + m.ts
    const existing = fusionMap.get(key)
    if (existing) {
      existing.vecScore = ((m as any).score || 0) / maxVecScore
      existing.sources = 2
    } else {
      fusionMap.set(key, {
        memory: m,
        textScore: 0,
        vecScore: ((m as any).score || 0) / maxVecScore,
        sources: 1,
      })
    }
  }

  // Final score: weighted sum + multi-source agreement bonus
  const fused = Array.from(fusionMap.values())
    .map(entry => {
      const textWeight = getParam('memory.fusion_text_weight')    // 0.5
      const vecWeight = getParam('memory.fusion_vec_weight')      // 0.5
      const baseScore = entry.textScore * textWeight + entry.vecScore * vecWeight
      // Ensemble bonus: boost if found by both text and vector methods
      const multiSourceBoost = entry.sources >= 2 ? getParam('memory.fusion_multi_source_boost') : 1.0  // 1.3
      return {
        memory: entry.memory,
        fusedScore: baseScore * multiSourceBoost,
      }
    })
    .sort((a, b) => b.fusedScore - a.fusedScore)
    .slice(0, topN)

  const fusedMemories = fused.map(f => f.memory)
  cachedFusedRecall = { query: msg, results: fusedMemories, ts: Date.now() }
  return fusedMemories
}

let idfInvalidateCount = 0
export function invalidateIDF() {
  // Throttle: don't invalidate if IDF was rebuilt less than 60s ago AND under 50 calls
  // This prevents O(n) rebuild on every addMemory when memories are added in bursts
  idfInvalidateCount++
  if (idfInvalidateCount < 50 && idfCache && (Date.now() - lastIdfBuildTs < 60000)) return
  idfCache = null
  idfInvalidateCount = 0
}

/**
 * Degrade confidence of a memory when it's contradicted or corrected.
 * If confidence drops to ≤0.1, mark as expired (too unreliable).
 */
export function degradeMemoryConfidence(content: string) {
  const mem = memoryState.memories.find(m => m.content === content)
  if (mem) {
    mem.confidence = Math.max(0, (mem.confidence ?? 0.7) - 0.2)
    if (mem.confidence <= 0.1) {
      mem.scope = 'expired'
    }
    syncToSQLite(mem, { confidence: mem.confidence, scope: mem.scope })
    saveMemories()
    console.log(`[cc-soul][confidence] degraded: "${content.slice(0, 50)}" → ${mem.confidence.toFixed(2)}${mem.scope === 'expired' ? ' (expired)' : ''}`)
  }
}

// consolidateFragments removed — replaced by 3-tier memory (core/working/archival)

// ═══════════════════════════════════════════════════════════════════════════════
// Memory Consolidation (压缩合并)
// ═══════════════════════════════════════════════════════════════════════════════

let lastConsolidationTs = 0
const CONSOLIDATION_COOLDOWN_MS = 24 * 3600 * 1000 // 24h cooldown
let consolidating = false

/**
 * Cluster memories by topic similarity using keyword overlap.
 * Only returns clusters of 3+ memories (worth consolidating).
 */
function clusterByTopic(mems: Memory[]): Memory[][] {
  // Cap input to most recent 100 to avoid O(n²) blowup on large batches
  const capped = mems.length > 100 ? mems.slice(-100) : mems
  const clusters: Memory[][] = []
  const used = new Set<number>()

  for (let i = 0; i < capped.length; i++) {
    if (used.has(i)) continue
    const cluster = [capped[i]]
    used.add(i)
    const words1 = new Set((capped[i].content.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase()))

    for (let j = i + 1; j < capped.length; j++) {
      if (used.has(j)) continue
      const words2 = (capped[j].content.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase())
      const overlap = words2.filter(w => words1.has(w)).length
      if (overlap >= 2) { // at least 2 shared keywords
        cluster.push(capped[j])
        used.add(j)
      }
    }
    if (cluster.length >= 3) clusters.push(cluster) // only consolidate clusters of 3+
  }
  return clusters
}

export function consolidateMemories() {
  if (consolidating) return
  // Use SQLite count if available (memoryState.memories may be empty in lazy-load mode)
  const totalCount = useSQLite ? sqliteCount() : memoryState.memories.length
  if (totalCount < 500) return
  if (Date.now() - lastConsolidationTs < CONSOLIDATION_COOLDOWN_MS) return
  consolidating = true
  lastConsolidationTs = Date.now()

  // Group memories by scope
  const groups = new Map<string, Memory[]>()
  for (const mem of memoryState.memories) {
    const key = mem.scope || 'unknown'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(mem)
  }

  let pendingCLICalls = 0
  // Collect all removals and additions across callbacks, apply once when all complete
  const allContentToRemove = new Set<string>()
  const allSummariesToAdd: { content: string; visibility: Memory['visibility'] }[] = []

  // For scopes with >50 entries, consolidate oldest batch by topic clusters
  for (const [scope, mems] of groups) {
    if (mems.length < 50) continue
    if (scope === 'consolidated') continue // don't re-consolidate

    // Take oldest 20, cluster by topic, consolidate each cluster separately
    const oldest = mems.sort((a, b) => a.ts - b.ts).slice(0, 20)
    const clusters = clusterByTopic(oldest)

    if (clusters.length === 0) continue

    for (const cluster of clusters) {
      const contents = cluster.map(m => compressMemory(m)).join('\n')
      pendingCLICalls++

      spawnCLI(
        `以下是${scope}类型的${cluster.length}条同主题记忆，请合并为1-2条摘要（保留关键信息）：\n\n${contents.slice(0, 1500)}\n\n格式：每条摘要一行`,
        (output) => {
          pendingCLICalls--
          // #7: Verify memories haven't been modified during async wait
          if (memoryState.memories.length === 0) {
            if (pendingCLICalls <= 0) consolidating = false
            return
          }
          if (!output || output.length < 10) {
            if (pendingCLICalls <= 0) consolidating = false
            return
          }
          const summaries = output.split('\n').filter(l => l.trim().length > 5).slice(0, 3)

          // Collect removals and additions — don't splice yet
          for (const o of cluster) allContentToRemove.add(o.content)
          for (const summary of summaries) {
            allSummariesToAdd.push({
              content: compressMemory({ content: summary.trim() } as Memory),
              visibility: cluster[0]?.visibility || 'global',
            })
          }
          console.log(`[cc-soul][memory] consolidated ${cluster.length} ${scope} memories -> ${summaries.length} summaries`)

          // When ALL callbacks complete, apply removals and additions in one batch
          if (pendingCLICalls <= 0) {
            // Reverse-splice all collected removals at once
            for (let i = memoryState.memories.length - 1; i >= 0; i--) {
              if (allContentToRemove.has(memoryState.memories[i].content)) {
                memoryState.memories.splice(i, 1)
              }
            }
            // Add all consolidated summaries
            for (const entry of allSummariesToAdd) {
              memoryState.memories.push({
                content: entry.content,
                scope: 'consolidated',
                ts: Date.now(),
                visibility: entry.visibility,
                confidence: 0.8,
                recallCount: 0,
                lastAccessed: Date.now(),
                tier: 'long_term',
              })
            }
            rebuildScopeIndex()
            saveMemories()
            invalidateIDF()
            consolidating = false
          }
        }
      )
    }
  }

  // If no CLI calls were made, release the lock immediately
  if (pendingCLICalls === 0) consolidating = false

  // Generate insights after consolidation (reuses 24h cooldown, no extra timer)
  generateInsights()
}

// ═══════════════════════════════════════════════════════════════════════════════
// Insight Generation — extract behavioral patterns from recent memories
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_INSIGHTS = 20

/**
 * Scan memories from the last 7 days, ask AI to extract 1-3 behavioral
 * patterns / preference insights, and store them as scope='insight' memories.
 * Called automatically at the end of consolidateMemories (shares its 24h cooldown),
 * or manually via generateInsights().
 */
export function generateInsights() {
  const sevenDaysAgo = Date.now() - 7 * 86400000
  const recentMemories = memoryState.memories.filter(
    m => m.ts >= sevenDaysAgo && m.scope !== 'expired' && m.scope !== 'insight'
  )
  if (recentMemories.length < 5) return // not enough data

  // Build a digest of recent memories (cap to avoid token explosion)
  const digest = recentMemories
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 60)
    .map(m => `[${m.scope}] ${m.content.slice(0, 120)}`)
    .join('\n')

  spawnCLI(
    `分析以下用户近期记忆，总结1-3条行为模式或偏好洞察。每条一行，格式：[洞察] 内容\n\n${digest.slice(0, 2000)}`,
    (output) => {
      if (!output || output.length < 10) return

      const insights = output
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('[洞察]'))
        .map(l => l.replace(/^\[洞察\]\s*/, '').trim())
        .filter(l => l.length >= 5)
        .slice(0, 3)

      if (insights.length === 0) return

      // Store each insight as scope='insight'
      for (const insight of insights) {
        addMemory(insight, 'insight', undefined, 'private')
      }

      // Enforce MAX_INSIGHTS cap — remove oldest insights beyond limit
      // Use content+ts keys (not array indices) to avoid stale-index bugs after addMemory eviction
      const allInsights = memoryState.memories
        .filter(m => m.scope === 'insight')
        .sort((a, b) => a.ts - b.ts)
      if (allInsights.length > MAX_INSIGHTS) {
        const toRemoveKeys = new Set(
          allInsights.slice(0, allInsights.length - MAX_INSIGHTS).map(m => `${m.content}\0${m.ts}`)
        )
        for (let i = memoryState.memories.length - 1; i >= 0; i--) {
          const m = memoryState.memories[i]
          if (toRemoveKeys.has(`${m.content}\0${m.ts}`)) {
            memoryState.memories.splice(i, 1)
          }
        }
        rebuildScopeIndex()
        saveMemories()
      }

      console.log(`[cc-soul][insight] generated ${insights.length} insights from ${recentMemories.length} recent memories`)
    }
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// Recall Feedback Loop — background improvement of missed recalls
// ═══════════════════════════════════════════════════════════════════════════════

let lastRecallFeedbackTs = 0
const RECALL_FEEDBACK_COOLDOWN = 60000 // 1 min cooldown

/**
 * After a response is sent, check if recall missed relevant memories.
 * If so, add cross-tags to missed memories so they'll be found next time.
 * Called async from handler.ts message:sent.
 */
export function recallFeedbackLoop(userMsg: string, recalledContents: string[]) {
  const now = Date.now()
  if (now - lastRecallFeedbackTs < RECALL_FEEDBACK_COOLDOWN) return
  if (memoryState.memories.length < 20) return
  if (userMsg.length < 10) return
  lastRecallFeedbackTs = now

  // Sample some un-recalled memories (random 20, excluding what was already recalled)
  const recalledSet = new Set(recalledContents)
  const candidates = shuffleArray(memoryState.memories
    .filter(m => !recalledSet.has(m.content) && m.content.length > 15))
    .slice(0, 20)

  if (candidates.length === 0) return

  const candidateList = candidates.map((m, i) => `${i + 1}. [${m.scope}] ${m.content.slice(0, 80)}`).join('\n')
  const recalledList = recalledContents.length > 0
    ? recalledContents.map(c => c.slice(0, 60)).join('; ')
    : '(无)'

  spawnCLI(
    `用户问了: "${userMsg.slice(0, 200)}"\n` +
    `系统召回了: ${recalledList}\n\n` +
    `以下是未被召回的记忆，哪些其实和用户的问题相关？\n${candidateList}\n\n` +
    `只输出相关记忆的编号（逗号分隔），如果都不相关就回答"无"`,
    (output) => {
      if (!output || output.includes('无')) return
      const nums = output.match(/\d+/g)?.map(Number) || []

      // For each missed-but-relevant memory, add tags from the query
      const queryWords = (userMsg.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || [])
        .map(w => w.toLowerCase())
        .slice(0, 8)

      let patched = 0
      for (const num of nums) {
        const idx = num - 1
        if (idx < 0 || idx >= candidates.length) continue
        const mem = candidates[idx]
        const memIdx = memoryState.memories.findIndex(m => m.content === mem.content && m.ts === mem.ts)
        if (memIdx < 0) continue

        // Bug #5 fix: modify memoryState.memories directly, not the candidates copy
        const real = memoryState.memories[memIdx]
        if (!real.tags) real.tags = []
        for (const w of queryWords) {
          if (!real.tags.includes(w)) {
            real.tags.push(w)
          }
        }
        // Cap tags at 25
        if (real.tags.length > 25) real.tags = real.tags.slice(-25)
        patched++
      }

      if (patched > 0) {
        saveMemories()
        console.log(`[cc-soul][recall-feedback] patched ${patched} memories with cross-tags from query`)
      }
    }
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// Unified Association Engine — three-layer associative recall
// ═══════════════════════════════════════════════════════════════════════════════
//
// Layer A (sync, instant):  Graph entities + Topic nodes → association keywords → 2nd-hop recall
// Layer B (async, cached):  LLM deep association → "reminds me of..." connections
//
// Layer A runs pre-response (available this turn).
// Layer B runs post-response (cached for next turn).
// Together they replace the old keyword-only + LLM-only split.

let cachedAssociation: { query: string; result: string; memories: string[]; ts: number } | null = null
const ASSOCIATION_COOLDOWN = 30000 // 30s cooldown

/**
 * Layer A: Synchronous graph+topic association.
 * Returns additional memories found through entity graph traversal and topic node matching.
 * Called from handler-augments.ts during augment building.
 */
export function associateSync(userMsg: string, recalled: Memory[], userId?: string, channelId?: string): Memory[] {
  if (userMsg.length < 5 || recalled.length < 2) return []

  const CJK_RE = /[\u4e00-\u9fff]{2,}|[a-z]{4,}/gi
  const seenContents = new Set(recalled.map(m => m.content.slice(0, 60)))
  const associationKeywords = new Set<string>()

  // Source 1: Graph entity activation — walk from mentioned entities to neighbors
  const mentioned = findMentionedEntities(userMsg)
  if (mentioned.length > 0) {
    const related = getRelatedEntities(mentioned, 2, 6)
    for (const entity of related) {
      const words = (entity.match(CJK_RE) || []).map((w: string) => w.toLowerCase())
      for (const w of words) associationKeywords.add(w)
    }
  }

  // Source 2: Topic nodes — find matching topics from distilled knowledge
  try {
    const { getRelevantTopics } = require('./distill.ts')
    const topics = getRelevantTopics(userMsg, userId, 3) as { topic: string; summary: string }[]
    for (const t of topics) {
      const words = ((t.topic + ' ' + t.summary).match(CJK_RE) || []).map((w: string) => w.toLowerCase())
      for (const w of words.slice(0, 3)) associationKeywords.add(w)
    }
  } catch { /* distill module not loaded yet */ }

  // Source 3: Keywords from top recalled memories (chain association)
  for (const m of recalled.slice(0, 3)) {
    const words = (m.content.match(CJK_RE) || []).map((w: string) => w.toLowerCase())
    for (const w of words.slice(0, 2)) associationKeywords.add(w)
  }

  // Remove words already in user message
  const userWords = new Set((userMsg.match(CJK_RE) || []).map((w: string) => w.toLowerCase()))
  for (const w of userWords) associationKeywords.delete(w)

  if (associationKeywords.size < 2) return []

  // 2nd-hop recall using combined association keywords
  const query = [...associationKeywords].slice(0, 8).join(' ')
  const associated = recall(query, 6, userId, channelId)

  // Dedup against first round
  const novel = associated.filter(m => !seenContents.has(m.content.slice(0, 60)))
  if (novel.length > 0) {
    console.log(`[cc-soul][association] sync: "${query.slice(0, 30)}" → ${novel.length} associated memories`)
  }
  return novel.slice(0, 4)
}

/**
 * Layer B: Async LLM deep association (post-response).
 * Uses top recalled + Layer A results to ask LLM for hidden connections.
 * Result cached for next turn.
 */
export function triggerAssociativeRecall(userMsg: string, topRecalled: string[]) {
  if (userMsg.length < 10) return
  if (cachedAssociation && Date.now() - cachedAssociation.ts < ASSOCIATION_COOLDOWN) return

  // Use Layer A results + random sample for LLM to analyze
  const recalledSet = new Set(topRecalled)
  const pool = shuffleArray(memoryState.memories
    .filter(m => !recalledSet.has(m.content) && m.content.length > 15 && m.scope !== 'proactive' && m.scope !== 'expired' && m.scope !== 'decayed'))
    .slice(0, 20)

  if (pool.length < 3) return

  const memList = pool.map((m, i) => `${i + 1}. ${m.content.slice(0, 80)}`).join('\n')

  spawnCLI(
    `用户说: "${userMsg.slice(0, 200)}"\n\n` +
    `已直接召回: ${topRecalled.slice(0, 3).map(r => r.slice(0, 40)).join('; ')}\n\n` +
    `以下记忆中，哪些和用户话题有隐含关联？（不是字面匹配，是深层联想——比如话题相关、因果链、同一时期的事）\n` +
    `${memList}\n\n` +
    `选1-3条最相关的，格式: "序号. 内容摘要 — 关联原因"。都不相关回答"无"`,
    (output) => {
      if (!output || output.includes('无') || output.length < 5) {
        cachedAssociation = null
        return
      }
      // Extract referenced memory contents for augment
      const nums = output.match(/(\d+)\./g)?.map(n => parseInt(n)) || []
      const referencedMems = nums.filter(n => n >= 1 && n <= pool.length).map(n => pool[n - 1].content.slice(0, 80))

      cachedAssociation = {
        query: userMsg.slice(0, 50),
        result: output.slice(0, 300),
        memories: referencedMems,
        ts: Date.now(),
      }
      console.log(`[cc-soul][association] deep: ${referencedMems.length} hidden connections found`)
    }
  )
}

/**
 * Get cached deep association result (from Layer B, previous turn).
 */
export function getAssociativeRecall(): string {
  if (!cachedAssociation) return ''
  if (Date.now() - cachedAssociation.ts > 300000) {
    cachedAssociation = null
    return ''
  }
  return `[深层联想] ${cachedAssociation.result}`
}

// ═══════════════════════════════════════════════════════════════════════════════
// Session Summary — triggered when conversation flow resolves or goes idle
// ═══════════════════════════════════════════════════════════════════════════════

let lastSessionSummaryTs = 0
const SESSION_SUMMARY_COOLDOWN = 1800000 // 30 min cooldown

// ═══════════════════════════════════════════════════════════════════════════════
// Active Memory Management — model can explicitly manage memories via markers
// ═══════════════════════════════════════════════════════════════════════════════

interface MemoryCommand {
  action: 'remember' | 'forget' | 'update' | 'search'
  content: string
  oldContent?: string  // for update
}

/**
 * Parse memory commands from model's response text.
 * Markers: （记下了：...）（忘掉：...）（更正记忆：旧→新）（想查：...）
 */
export function parseMemoryCommands(responseText: string): MemoryCommand[] {
  const commands: MemoryCommand[] = []

  // （记下了：...） or （记住：...）
  const rememberPattern = /[（(](?:记下了|记住|记下|save)[：:]\s*(.+?)[）)]/g
  let match
  while ((match = rememberPattern.exec(responseText)) !== null) {
    commands.push({ action: 'remember', content: match[1].trim() })
  }

  // （忘掉：...） or （忘记：...）
  const forgetPattern = /[（(](?:忘掉|忘记|forget|过时了)[：:]\s*(.+?)[）)]/g
  while ((match = forgetPattern.exec(responseText)) !== null) {
    commands.push({ action: 'forget', content: match[1].trim() })
  }

  // （更正记忆：旧内容→新内容）
  const updatePattern = /[（(](?:更正记忆|更新记忆|update)[：:]\s*(.+?)\s*(?:→|->)+\s*(.+?)[）)]/g
  while ((match = updatePattern.exec(responseText)) !== null) {
    commands.push({ action: 'update', content: match[2].trim(), oldContent: match[1].trim() })
  }

  // （想查：...）
  const searchPattern = /[（(](?:想查|查一下|search|回忆一下)[：:]\s*(.+?)[）)]/g
  while ((match = searchPattern.exec(responseText)) !== null) {
    commands.push({ action: 'search', content: match[1].trim() })
  }

  return commands
}

/** Cached search results from model's search requests, injected next turn */
let pendingSearchResults: string[] = []

export function getPendingSearchResults(): string[] {
  const results = [...pendingSearchResults]
  pendingSearchResults = []
  return results
}

/**
 * Execute memory commands parsed from model response.
 * Called from handler.ts message:sent.
 */
export function executeMemoryCommands(commands: MemoryCommand[], userId?: string, channelId?: string) {
  for (const cmd of commands) {
    switch (cmd.action) {
      case 'remember':
        addMemory(cmd.content, 'fact', userId, 'global', channelId)
        console.log(`[cc-soul][active-memory] REMEMBER: ${cmd.content.slice(0, 60)}`)
        break

      case 'forget': {
        // Anti-hallucination: require keyword >= 4 chars to prevent overly broad matches
        const keyword = cmd.content.toLowerCase().trim()
        if (keyword.length < 4) {
          console.log(`[cc-soul][active-memory] FORGET blocked: keyword too short "${keyword}" (min 4 chars, anti-hallucination)`)
          break
        }
        // Find and mark matching memories as expired (don't delete, just tag)
        const MAX_FORGET_PER_CMD = 3 // anti-hallucination: cap bulk deletions
        let forgotten = 0
        for (const mem of memoryState.memories) {
          if (forgotten >= MAX_FORGET_PER_CMD) {
            console.log(`[cc-soul][active-memory] FORGET capped at ${MAX_FORGET_PER_CMD} (keyword: ${keyword.slice(0, 30)}), remaining untouched`)
            break
          }
          if (mem.content.toLowerCase().includes(keyword) && mem.scope !== 'consolidated' && mem.scope !== 'expired') {
            mem.scope = 'expired'
            forgotten++
          }
        }
        if (forgotten > 0) {
          saveMemories()
          rebuildScopeIndex() // scope changed, index stale
          console.log(`[cc-soul][active-memory] FORGET: marked ${forgotten} memories as expired (keyword: ${cmd.content.slice(0, 30)})`)
        }
        break
      }

      case 'update': {
        // Find old memory, replace content
        if (!cmd.oldContent) break
        const oldKw = cmd.oldContent.toLowerCase()
        for (const mem of memoryState.memories) {
          if (mem.content.toLowerCase().includes(oldKw) && mem.scope !== 'expired') {
            console.log(`[cc-soul][active-memory] UPDATE: "${mem.content.slice(0, 40)}" → "${cmd.content.slice(0, 40)}"`)
            mem.content = cmd.content
            mem.ts = Date.now()
            mem.tags = undefined // re-tag on next cycle
            break // only update first match
          }
        }
        saveMemories()
        rebuildScopeIndex() // content changed, index may need update
        break
      }

      case 'search': {
        // Search and cache results for next turn injection
        const results = recall(cmd.content, 5, userId, channelId)
        if (results.length > 0) {
          pendingSearchResults = results.map(m => `- ${m.content}${m.emotion && m.emotion !== 'neutral' ? ` (${m.emotion})` : ''}`)
          console.log(`[cc-soul][active-memory] SEARCH "${cmd.content.slice(0, 30)}": found ${results.length} results (cached for next turn)`)
        }
        break
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Memory Contradiction Detection — periodic scan for conflicting memories
// ═══════════════════════════════════════════════════════════════════════════════

let lastContradictionScan = 0
const CONTRADICTION_SCAN_COOLDOWN = 24 * 3600000 // once per day

/**
 * Scan memories for contradictions within the same scope.
 * Group by scope, sample pairs, ask CLI to detect conflicts.
 * Conflicting older memories get marked as expired.
 */
export function scanForContradictions() {
  const now = Date.now()
  if (now - lastContradictionScan < CONTRADICTION_SCAN_COOLDOWN) return
  if (memoryState.memories.length < 20) return
  lastContradictionScan = now

  // Group by scope, only check fact/preference/correction (most likely to conflict)
  const conflictScopes = ['fact', 'preference', 'correction']
  const groups = new Map<string, Memory[]>()
  for (const mem of memoryState.memories) {
    if (!conflictScopes.includes(mem.scope)) continue
    if (mem.scope === 'expired') continue
    if (!groups.has(mem.scope)) groups.set(mem.scope, [])
    groups.get(mem.scope)!.push(mem)
  }

  for (const [scope, mems] of groups) {
    if (mems.length < 5) continue

    // Sample recent 10 vs older 10 (most likely conflict pairs)
    const sorted = [...mems].sort((a, b) => b.ts - a.ts)
    const recent = sorted.slice(0, 10)
    const older = sorted.slice(10, 20)
    if (older.length < 3) continue

    const recentList = recent.map((m, i) => `新${i + 1}. ${m.content.slice(0, 80)}`).join('\n')
    const olderList = older.map((m, i) => `旧${i + 1}. ${m.content.slice(0, 80)}`).join('\n')

    spawnCLI(
      `以下是同类型(${scope})的新旧记忆，检查是否有矛盾（同一件事说法不同、前后不一致）。\n\n` +
      `最近的记忆:\n${recentList}\n\n` +
      `较早的记忆:\n${olderList}\n\n` +
      `如果有矛盾，输出格式: "旧N 与 新M 矛盾: 原因"（可多条）\n` +
      `如果没有矛盾，回答"无"`,
      (output) => {
        if (!output || output.includes('无')) return

        // Parse contradiction pairs
        const lines = output.split('\n').filter(l => l.includes('矛盾'))
        let timeBounded = 0
        for (const line of lines) {
          const oldMatch = line.match(/旧(\d+)/)
          if (oldMatch) {
            const idx = parseInt(oldMatch[1]) - 1
            if (idx >= 0 && idx < older.length) {
              const memIdx = memoryState.memories.findIndex(m => m.content === older[idx].content && m.ts === older[idx].ts)
              if (memIdx >= 0) {
                // Temporal knowledge: mark as time-bounded rather than deleting
                // Keep scope intact — the fact was true in the past, just not anymore
                const mem = memoryState.memories[memIdx]
                mem.validUntil = Date.now()
                if (!mem.validFrom) mem.validFrom = mem.ts
                timeBounded++
              }
            }
          }
        }

        if (timeBounded > 0) {
          saveMemories()
          console.log(`[cc-soul][contradiction] time-bounded ${timeBounded} contradicted memories in scope "${scope}" (kept as historical)`)
        }
      }
    )
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Predictive Memory — pre-load context before user speaks
// ═══════════════════════════════════════════════════════════════════════════════

let lastPredictionTs = 0
let cachedPrediction: string[] = []

/**
 * Based on user's rhythm (time patterns) + recent conversation topics,
 * predict what they might ask about and pre-load relevant memories.
 * Called at the START of preprocessed, before the user's actual message is processed.
 */
export function predictiveRecall(userId?: string, channelId?: string): string[] {
  const now = Date.now()
  // Only predict if we have cached results (generated async after last message)
  const results = [...cachedPrediction]
  cachedPrediction = [] // consume
  return results
}

/**
 * Async: after a message is processed, predict what comes next.
 * Uses recent topics + time of day + conversation pattern.
 * Called from handler.ts message:sent.
 */
export function generatePrediction(recentTopics: string[], userId?: string) {
  if (recentTopics.length === 0) return
  if (Date.now() - lastPredictionTs < 60000) return // 1 min cooldown
  lastPredictionTs = Date.now()

  // Find memories related to recent topics (pre-warm for next message)
  const topicStr = recentTopics.slice(-3).join('、')
  const candidates = memoryState.memories
    .filter(m => {
      if (m.scope === 'expired' || m.scope === 'proactive') return false
      const content = m.content.toLowerCase()
      return recentTopics.some(t => content.includes(t.toLowerCase()))
    })
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 5)

  if (candidates.length > 0) {
    cachedPrediction = candidates.map(m => m.content)
    console.log(`[cc-soul][predictive] pre-loaded ${candidates.length} memories for topics: ${topicStr}`)
  }
}

export function triggerSessionSummary(recentTurns?: number) {
  const now = Date.now()
  if (now - lastSessionSummaryTs < SESSION_SUMMARY_COOLDOWN) return
  if (memoryState.chatHistory.length < 3) return
  lastSessionSummaryTs = now

  const turns = memoryState.chatHistory.slice(-(recentTurns || 10))
  const conversation = turns.map(t => `用户: ${t.user.slice(0, 200)}\n助手: ${t.assistant.slice(0, 200)}`).join('\n\n')

  spawnCLI(
    `以下是一段完整对话，请写一条高质量的会话摘要（2-3句话），包含：\n` +
    `1. 讨论了什么主题\n` +
    `2. 关键结论或决定\n` +
    `3. 是否有遗留问题\n` +
    `不要说"用户和助手讨论了..."，直接写内容。\n\n${conversation}`,
    (output) => {
      if (output && output.length > 20) {
        addMemory(`[会话摘要] ${output.slice(0, 300)}`, 'consolidated', undefined, 'global')
        console.log(`[cc-soul][session-summary] ${output.slice(0, 80)}`)
      }
    }
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// Network Knowledge Maintenance — expiry + trust decay
// ═══════════════════════════════════════════════════════════════════════════════

let lastNetworkCleanup = 0
const NETWORK_CLEANUP_COOLDOWN = 24 * 3600000 // daily

/**
 * Clean up network knowledge:
 * 1. Expire knowledge older than 90 days that hasn't been "confirmed" by local usage
 * 2. Downgrade low-trust knowledge that was never recalled
 * 3. Remove contradictions between network and local knowledge (local wins)
 */
export function cleanupNetworkKnowledge() {
  const now = Date.now()
  if (now - lastNetworkCleanup < NETWORK_CLEANUP_COOLDOWN) return
  lastNetworkCleanup = now

  let expired = 0
  let downgraded = 0

  for (const mem of memoryState.memories) {
    if (!mem.content.startsWith('[网络知识')) continue
    if (mem.scope === 'expired') continue

    const ageDays = (now - mem.ts) / 86400000

    // Rule 1: Network knowledge older than 90 days with no tags (never recalled/used) → expire
    if (ageDays > 90 && (!mem.tags || mem.tags.length === 0)) {
      mem.scope = 'expired'
      expired++
      continue
    }

    // Rule 2: Low-trust knowledge older than 30 days → expire
    if (mem.content.includes('低可信') && ageDays > 30) {
      mem.scope = 'expired'
      expired++
      continue
    }

    // Rule 3: "待验证" knowledge older than 60 days → downgrade to expired
    if (mem.content.includes('待验证') && ageDays > 60) {
      mem.scope = 'expired'
      downgraded++
      continue
    }
  }

  if (expired > 0 || downgraded > 0) {
    saveMemories()
    console.log(`[cc-soul][network-cleanup] expired ${expired}, downgraded ${downgraded} network memories`)
  }
}

/**
 * When local knowledge contradicts network knowledge, local wins.
 * Called during scanForContradictions — enhanced to handle network vs local.
 */
// ═══════════════════════════════════════════════════════════════════════════════
// EPISODIC MEMORY — complete event chains, not just facts
// ═══════════════════════════════════════════════════════════════════════════════

const EPISODES_PATH = resolve(DATA_DIR, 'episodes.json')
const MAX_EPISODES = 200

interface Episode {
  id: string
  timestamp: number
  topic: string
  turns: { role: 'user' | 'assistant'; content: string; emotion?: string }[]
  correction?: { what: string; cause: string }
  resolution: 'resolved' | 'abandoned' | 'ongoing'
  lesson?: string          // what was learned from this episode
  frustrationPeak: number  // max frustration during episode
}

let episodes: Episode[] = []

export function loadEpisodes() {
  episodes = loadJson<Episode[]>(EPISODES_PATH, [])
  console.log(`[cc-soul][episodes] loaded ${episodes.length} episodes`)
}

function saveEpisodes() {
  debouncedSave(EPISODES_PATH, episodes)
}

/**
 * Record a complete episode from conversation flow data.
 * Called when a conversation topic resolves or is abandoned.
 */
export function recordEpisode(
  topic: string,
  turns: { role: 'user' | 'assistant'; content: string }[],
  correction?: { what: string; cause: string },
  resolution: 'resolved' | 'abandoned' = 'resolved',
  frustrationPeak = 0,
  lesson?: string,
) {
  const episode: Episode = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
    timestamp: Date.now(),
    topic: topic.slice(0, 100),
    turns: turns.slice(-10).map(t => ({ ...t, content: t.content.slice(0, 200) })),
    correction,
    resolution,
    lesson,
    frustrationPeak,
  }

  episodes.push(episode)
  if (episodes.length > MAX_EPISODES) episodes = episodes.slice(-Math.floor(MAX_EPISODES * 0.8))
  saveEpisodes()
  console.log(`[cc-soul][episodes] recorded: ${topic.slice(0, 40)} [${resolution}]`)
}

/**
 * Recall relevant episodes for current context.
 * Matches by topic keywords.
 */
export function recallEpisodes(msg: string, topN = 2): Episode[] {
  if (episodes.length === 0) return []
  const words = new Set((msg.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase()))
  if (words.size === 0) return []

  const scored = episodes.map(ep => {
    const topicWords = (ep.topic.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase())
    const overlap = topicWords.filter(w => words.has(w)).length
    // Boost episodes with corrections (more educational)
    const correctionBoost = ep.correction ? 1.5 : 1.0
    return { ep, score: overlap * correctionBoost }
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score)

  return scored.slice(0, topN).map(s => s.ep)
}

/**
 * Build episode context for augment injection.
 */
export function buildEpisodeContext(msg: string): string {
  const relevant = recallEpisodes(msg)
  if (relevant.length === 0) return ''

  const lines = relevant.map(ep => {
    let desc = `[Episode] ${ep.topic}`
    if (ep.correction) desc += ` — you made a mistake: ${ep.correction.what} (cause: ${ep.correction.cause})`
    if (ep.lesson) desc += ` — lesson: ${ep.lesson}`
    if (ep.frustrationPeak > 0.5) desc += ` — user was frustrated`
    return desc
  })
  return lines.join('\n')
}

export { episodes }

// ═══════════════════════════════════════════════════════════════════════════════
// TIME-DECAY TIERED MEMORY — short_term → mid_term → long_term lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

const HOUR_MS = 3600000
const DAY_MS = 86400000
const SHORT_TERM_THRESHOLD = 24 * HOUR_MS       // 24 hours
const MID_TERM_THRESHOLD = 30 * DAY_MS           // 30 days
const RECALL_UPGRADE_COUNT = 1                    // recalls needed to upgrade short→mid

let lastDecayTs = 0
const DECAY_COOLDOWN = 6 * HOUR_MS               // run at most every 6 hours

/**
 * Process time-based memory decay and tier transitions.
 * Called from heartbeat. Scans all memories and applies tier lifecycle:
 *
 * - short_term > 24h + recallCount >= 2 → upgrade to mid_term
 * - short_term > 24h + recallCount < 2  → mark decayed (scope = 'decayed', keep content)
 * - mid_term > 30 days + no recall in last 30 days → downgrade to long_term, compress content
 *
 * Compatible with old data: missing tier defaults to 'short_term', missing recallCount defaults to 0.
 */
export function processMemoryDecay() {
  const now = Date.now()
  if (now - lastDecayTs < DECAY_COOLDOWN) return
  lastDecayTs = now

  // Fix ts=0 memories: use lastAccessed if available, otherwise distribute over last 30 days
  let tsRepaired = 0
  for (const mem of memoryState.memories) {
    if (!mem.ts || mem.ts === 0) {
      mem.ts = mem.lastAccessed || (now - Math.random() * 30 * DAY_MS)
      tsRepaired++
    }
  }
  if (tsRepaired > 0) {
    console.log(`[cc-soul][memory-decay] repaired ${tsRepaired} memories with ts=0`)
  }

  let upgraded = 0
  let decayed = 0
  let compressed = 0

  const useArchive = isEnabled('dag_archive')
  let archived = 0

  for (const mem of memoryState.memories) {
    // Skip already expired/consolidated/decayed/pinned/archived
    if (mem.scope === 'expired' || mem.scope === 'decayed' || mem.scope === 'pinned' || mem.scope === 'archived') continue

    const tier = mem.tier || 'short_term'
    const age = now - (mem.ts || mem.lastAccessed || now)
    const recallCount = mem.recallCount ?? 0
    const lastRecalled = mem.lastRecalled ?? 0

    if (tier === 'short_term' && age > SHORT_TERM_THRESHOLD) {
      if (recallCount >= RECALL_UPGRADE_COUNT) {
        // Promoted: actively used memory → mid_term
        mem.tier = 'mid_term'
        upgraded++
      } else if (useArchive) {
        // DAG Archive: compress but preserve original in raw_line
        archiveMemory(mem)
        archived++
      } else {
        // Legacy: hard decay
        mem.scope = 'decayed'
        mem.tier = 'short_term'
        decayed++
      }
    } else if (tier === 'mid_term' && age > MID_TERM_THRESHOLD) {
      // Check if recalled in the last 30 days
      const recentlyRecalled = lastRecalled > 0 && (now - lastRecalled) < MID_TERM_THRESHOLD
      if (!recentlyRecalled) {
        // Downgrade to long_term with content compression
        mem.tier = 'long_term'
        // Compress: keep first 100 chars as core fact summary
        if (mem.content.length > 120) {
          mem.content = mem.content.slice(0, 100).trimEnd() + '…'
        }
        compressed++
      }
    }
    // long_term memories stay as-is (already compressed, permanent storage)
  }

  if (upgraded > 0 || decayed > 0 || compressed > 0 || archived > 0) {
    rebuildScopeIndex()
    saveMemories()
    console.log(`[cc-soul][memory-decay] upgraded=${upgraded} decayed=${decayed} compressed=${compressed} archived=${archived}`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Expired Memory Physical Cleanup — remove truly dead memories from storage
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Physically delete expired memories older than 30 days.
 * Also cleans up decayed memories older than 90 days that were never recalled.
 * Called from heartbeat (daily cadence).
 */
let lastPhysicalCleanup = 0
const PHYSICAL_CLEANUP_COOLDOWN = 24 * 3600000 // once per day

export function pruneExpiredMemories() {
  const now = Date.now()
  if (now - lastPhysicalCleanup < PHYSICAL_CLEANUP_COOLDOWN) return
  lastPhysicalCleanup = now

  // SQLite cleanup (handles both expired deletion + vector cleanup)
  if (useSQLite) {
    sqliteCleanupExpired()
  }

  // In-memory array cleanup
  const before = memoryState.memories.length
  const EXPIRED_CUTOFF = 30 * 86400000   // 30 days
  const DECAYED_CUTOFF = 90 * 86400000   // 90 days

  memoryState.memories = memoryState.memories.filter(m => {
    if (m.scope === 'expired' && now - m.ts > EXPIRED_CUTOFF) return false
    if (m.scope === 'decayed' && now - m.ts > DECAYED_CUTOFF && (m.recallCount ?? 0) === 0) return false
    return true
  })

  const removed = before - memoryState.memories.length
  if (removed > 0) {
    rebuildScopeIndex()
    saveMemories()
    console.log(`[cc-soul][prune] physically removed ${removed} dead memories (${before} → ${memoryState.memories.length})`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Decayed Memory Revival — rescue valuable memories from the graveyard
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Scan decayed memories for those still worth keeping:
 * - Has tags (was processed by CLI)
 * - confidence > 0.5
 * - scope was fact/preference/correction before decay
 * - Was recalled at least once
 * Revive up to 20 per cycle.
 */
let lastRevival = 0
const REVIVAL_COOLDOWN = 12 * 3600000 // twice per day

export function reviveDecayedMemories() {
  const now = Date.now()
  if (now - lastRevival < REVIVAL_COOLDOWN) return
  lastRevival = now

  const candidates = memoryState.memories.filter(m =>
    m.scope === 'decayed' &&
    m.tags && m.tags.length > 0 &&
    (m.confidence ?? 0) > 0.5 &&
    ((m.recallCount ?? 0) > 0 || m.emotion === 'important' || m.emotion === 'warm')
  )

  if (candidates.length === 0) return

  // Sort by value: recallCount + confidence + emotion importance
  candidates.sort((a, b) => {
    const scoreA = (a.recallCount ?? 0) * 2 + (a.confidence ?? 0) + (a.emotion === 'important' ? 1 : 0)
    const scoreB = (b.recallCount ?? 0) * 2 + (b.confidence ?? 0) + (b.emotion === 'important' ? 1 : 0)
    return scoreB - scoreA
  })

  let revived = 0
  for (const mem of candidates.slice(0, 20)) {
    mem.scope = 'fact' // restore to active scope
    mem.tier = 'mid_term' // put in mid-term (not short, to avoid immediate re-decay)
    mem.lastAccessed = now
    revived++
  }

  if (revived > 0) {
    rebuildScopeIndex()
    saveMemories()
    console.log(`[cc-soul][revival] revived ${revived} valuable decayed memories (from ${candidates.length} candidates)`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DAG Archive — lossless memory compression (raw_line preserves original)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Archive a memory: generate summary, store original in raw_line, set scope='archived'.
 * Preserves ts, tags, emotion and all metadata.
 */
function archiveMemory(mem: any) {
  // Store original full content in raw_line (used by official DB column)
  mem.raw_line = mem.content
  // Generate summary: first 50 chars + ellipsis
  const summary = mem.content.length > 50
    ? mem.content.slice(0, 50).trimEnd() + '...'
    : mem.content
  mem.content = summary
  mem.scope = 'archived'
  // Keep original tier for potential restoration
  if (!mem._originalTier) mem._originalTier = mem.tier || 'short_term'

  // Sync to SQLite if available
  if (useSQLite) {
    const row = sqliteFindByContent(mem.raw_line)
    if (row) {
      sqliteUpdateMemory(row.id, { scope: 'archived', content: summary })
      // Update raw_line directly via prepared statement
      sqliteUpdateRawLine(row.id, mem.raw_line)
    }
  }
}

/**
 * Restore archived memories matching a keyword.
 * Moves raw_line back to content, sets scope to 'mid_term'.
 * Returns count of restored memories.
 */
export function restoreArchivedMemories(keyword: string): number {
  // Use DB directly — memoryState may not have archived memories
  const _db = getDb()
  if (!_db) return 0
  const kw = `%${keyword}%`
  const rows = _db.prepare("SELECT id, content, raw_line FROM memories WHERE scope = 'archived' AND (raw_line LIKE ? OR content LIKE ?) LIMIT 10").all(kw, kw) as any[]
  let restored = 0
  for (const row of rows) {
    const newContent = row.raw_line || row.content
    _db.prepare("UPDATE memories SET content = ?, scope = 'mid_term', tier = 'mid_term', lastAccessed = ?, raw_line = '' WHERE id = ?").run(newContent, Date.now(), row.id)
    restored++
  }
  if (restored > 0) console.log(`[cc-soul][dag-archive] restored ${restored} memories matching "${keyword}"`)
  return restored
}

export function resolveNetworkConflicts() {
  const now = Date.now()
  const localFacts = memoryState.memories.filter(m =>
    !m.content.startsWith('[网络知识') &&
    (m.scope === 'fact' || m.scope === 'consolidated') &&
    m.scope !== 'expired'
  )
  const networkFacts = memoryState.memories.filter(m =>
    m.content.startsWith('[网络知识') && m.scope !== 'expired'
  )

  if (localFacts.length === 0 || networkFacts.length === 0) return

  let resolved = 0
  for (const net of networkFacts) {
    // Check if any local fact covers the same topic with different content
    const netWords = new Set(
      (net.content.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase())
    )

    for (const local of localFacts) {
      const localWords = (local.content.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || [])
        .map(w => w.toLowerCase())
      const overlap = localWords.filter(w => netWords.has(w)).length

      // High topic overlap but different content → potential conflict
      // Local knowledge is more trusted (user verified), expire network version
      if (overlap >= 3 && local.content !== net.content.replace(/^\[网络知识[|｜][^\]]*\]\s*/, '')) {
        // Only expire if local is newer
        if (local.ts > net.ts) {
          net.scope = 'expired'
          resolved++
          break
        }
      }
    }
  }

  if (resolved > 0) {
    saveMemories()
    console.log(`[cc-soul][network-conflicts] resolved ${resolved} network vs local conflicts (local wins)`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SQLite Maintenance — called from heartbeat
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Periodic SQLite maintenance: cleanup expired, backfill embeddings.
 * Safe to call frequently — internally rate-limited.
 */
export async function sqliteMaintenance() {
  if (!useSQLite) return
  sqliteCleanupExpired()
  if (hasVectorSearch()) {
    await backfillEmbeddings(20)
  }
}

/** Expose storage backend status for diagnostics */
export function getStorageStatus(): { backend: 'sqlite' | 'json'; vectorSearch: boolean } {
  return {
    backend: useSQLite ? 'sqlite' : 'json',
    vectorSearch: hasVectorSearch(),
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// #10 记忆卫生审计 — heartbeat 每天运行一次
// ═══════════════════════════════════════════════════════════════════════════════

const AUDIT_PATH = resolve(DATA_DIR, 'memory_audit.json')
let lastAuditTs = 0

export function auditMemoryHealth() {
  const now = Date.now()
  if (now - lastAuditTs < 86400000) return // 每天最多一次
  lastAuditTs = now

  const active = memoryState.memories.filter(m => m.scope !== 'expired' && m.scope !== 'decayed')

  // 1. 重复记忆（trigram similarity > 0.9）— 采样前 500 条避免 O(n^2) 爆炸
  const sample = active.slice(0, 500)
  const duplicates: { a: string; b: string; sim: number }[] = []
  for (let i = 0; i < sample.length && duplicates.length < 20; i++) {
    const tA = trigrams(sample[i].content)
    for (let j = i + 1; j < sample.length && duplicates.length < 20; j++) {
      const sim = trigramSimilarity(tA, trigrams(sample[j].content))
      if (sim > 0.9) duplicates.push({ a: sample[i].content.slice(0, 60), b: sample[j].content.slice(0, 60), sim: +sim.toFixed(2) })
    }
  }

  // 2. 极短记忆
  const tooShort = active.filter(m => m.content.length < 10).map(m => m.content)

  // 3. 无标签的活跃记忆
  const untagged = active.filter(m => !m.tags || m.tags.length === 0).length

  // 4. 低置信度记忆
  const lowConfidence = active.filter(m => (m.confidence ?? 0.7) < 0.3).length

  // 5. 僵尸记忆（从未被命中且存活超过30天）
  const thirtyDaysAgo = now - 30 * 86400000
  const zombie = active.filter(m => (m.recallCount ?? 0) === 0 && m.ts < thirtyDaysAgo).length

  // 6. 过期未清理（validUntil 已过但 scope 未标记 expired）
  const staleExpiry = active.filter(m => m.validUntil && m.validUntil < now).length

  // 7. 生成建议
  const parts: string[] = []
  if (duplicates.length > 0) parts.push(`建议合并 ${duplicates.length} 组重复记忆`)
  if (tooShort.length > 0) parts.push(`建议清理 ${tooShort.length} 条过短记忆`)
  if (untagged > active.length * 0.3) parts.push(`${untagged} 条记忆缺少标签，建议批量打标`)
  if (lowConfidence > 0) parts.push(`${lowConfidence} 条低置信度记忆（<0.3），建议清理`)
  if (zombie > 0) parts.push(`${zombie} 条僵尸记忆（30天零命中），建议淘汰`)
  if (staleExpiry > 0) parts.push(`${staleExpiry} 条记忆已过 validUntil 但未过期，建议清理`)

  const audit = { ts: now, duplicates, tooShort: tooShort.slice(0, 20), untagged, lowConfidence, zombie, staleExpiry, suggestions: parts.join('；') || '记忆状态良好' }
  debouncedSave(AUDIT_PATH, audit)
  console.log(`[cc-soul][memory-audit] duplicates=${duplicates.length} short=${tooShort.length} untagged=${untagged} lowConf=${lowConfidence} zombie=${zombie} staleExpiry=${staleExpiry}`)
}
