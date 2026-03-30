/**
 * memory-lifecycle.ts — Periodic maintenance, consolidation, decay, and lifecycle operations
 * Extracted from memory.ts to reduce file size.
 */

import { resolve } from 'path'
import type { Memory } from './types.ts'
import { DATA_DIR, loadJson, debouncedSave } from './persistence.ts'
import { spawnCLI } from './cli.ts'
import {
  sqliteCleanupExpired, backfillEmbeddings, hasVectorSearch,
  sqliteFindByContent, sqliteUpdateMemory, sqliteUpdateRawLine, getDb, sqliteCount,
} from './sqlite-store.ts'
import { findMentionedEntities, getRelatedEntities } from './graph.ts'
import { isEnabled } from './features.ts'
import {
  memoryState, scopeIndex, useSQLite,
  addMemory, addMemoryWithEmotion, saveMemories, syncToSQLite,
  rebuildScopeIndex, getLazyModule, compressMemory,
} from './memory.ts'
import { trigrams, trigramSimilarity, shuffleArray } from './memory-utils.ts'
import { recall, recallWithScores, invalidateIDF, _memLookup } from './memory-recall.ts'

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
/**
 * TF-IDF vectorize a document and return term→weight map.
 * IDF is computed from the provided corpus.
 */
function tfidfVector(doc: string, idfMap: Map<string, number>): Map<string, number> {
  const words = (doc.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase())
  const tf = new Map<string, number>()
  for (const w of words) tf.set(w, (tf.get(w) || 0) + 1)
  const vec = new Map<string, number>()
  for (const [term, count] of tf) {
    vec.set(term, count * (idfMap.get(term) ?? 1.0))
  }
  return vec
}

/** Cosine similarity between two TF-IDF vectors. */
function cosineSim(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, normA = 0, normB = 0
  for (const [k, v] of a) { normA += v * v; if (b.has(k)) dot += v * b.get(k)! }
  for (const [, v] of b) normB += v * v
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

function clusterByTopic(mems: Memory[]): Memory[][] {
  // Cap input to most recent 100 to avoid O(n²) blowup on large batches
  const capped = mems.length > 100 ? mems.slice(-100) : mems
  if (capped.length < 3) return []

  // Build IDF from this batch
  const df = new Map<string, number>()
  const N = capped.length
  for (const m of capped) {
    const words = new Set((m.content.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase()))
    for (const w of words) df.set(w, (df.get(w) || 0) + 1)
  }
  const idfMap = new Map<string, number>()
  for (const [word, count] of df) idfMap.set(word, Math.log(N / (1 + count)))

  // Pre-compute TF-IDF vectors
  const vecs = capped.map(m => tfidfVector(m.content, idfMap))

  // Greedy merge: union-find style clustering with cosine sim >= 0.25
  const parent = Array.from({ length: capped.length }, (_, i) => i)
  function find(x: number): number { return parent[x] === x ? x : (parent[x] = find(parent[x])) }
  function unite(a: number, b: number) { parent[find(a)] = find(b) }

  for (let i = 0; i < capped.length; i++) {
    for (let j = i + 1; j < capped.length; j++) {
      if (find(i) === find(j)) continue
      if (cosineSim(vecs[i], vecs[j]) >= 0.25) unite(i, j)
    }
  }

  // Collect clusters
  const clusterMap = new Map<number, Memory[]>()
  for (let i = 0; i < capped.length; i++) {
    const root = find(i)
    if (!clusterMap.has(root)) clusterMap.set(root, [])
    clusterMap.get(root)!.push(capped[i])
  }

  return [...clusterMap.values()].filter(c => c.length >= 3) // only consolidate clusters of 3+
}

export function consolidateMemories() {
  // Safety: force-release consolidating lock if stuck for >5 minutes
  if (consolidating && Date.now() - lastConsolidationTs > 5 * 60 * 1000) {
    console.error('[cc-soul][consolidation] force-releasing stuck lock (>5min)')
    consolidating = false
  }
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
          try {
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
            for (const o of cluster) allContentToRemove.add(`${o.content}\0${o.ts}`)
            for (const summary of summaries) {
              allSummariesToAdd.push({
                content: compressMemory({ content: summary.trim() } as Memory),
                visibility: cluster[0]?.visibility || 'global',
              })
            }
            console.log(`[cc-soul][memory] consolidated ${cluster.length} ${scope} memories -> ${summaries.length} summaries`)

            // When ALL callbacks complete, apply removals and additions in one batch
            if (pendingCLICalls <= 0) {
              // Reverse-splice all collected removals at once (keyed by content+ts to avoid same-content collisions)
              for (let i = memoryState.memories.length - 1; i >= 0; i--) {
                if (allContentToRemove.has(`${memoryState.memories[i].content}\0${memoryState.memories[i].ts}`)) {
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
          } catch (e: any) {
            console.error(`[cc-soul][consolidation] callback error: ${e.message}`)
            pendingCLICalls = Math.max(0, pendingCLICalls)
            if (pendingCLICalls <= 0) consolidating = false
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
 *
 * v2.3: Uses local trigram similarity instead of LLM — zero cost, instant.
 */
export function recallFeedbackLoop(userMsg: string, recalledContents: string[]) {
  const now = Date.now()
  if (now - lastRecallFeedbackTs < RECALL_FEEDBACK_COOLDOWN) return
  if (memoryState.memories.length < 20) return
  if (userMsg.length < 10) return
  lastRecallFeedbackTs = now

  // Sample some un-recalled memories (random 30, excluding what was already recalled)
  const recalledSet = new Set(recalledContents)
  const candidates = shuffleArray(memoryState.memories
    .filter(m => !recalledSet.has(m.content) && m.content.length > 15))
    .slice(0, 30)

  if (candidates.length === 0) return

  // Local relevance scoring via trigram similarity
  const queryTri = trigrams(userMsg)
  const RELEVANCE_THRESHOLD = 0.08 // low bar — cross-tagging is cheap, false positives are OK

  const queryWords = (userMsg.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || [])
    .map(w => w.toLowerCase())
    .slice(0, 8)

  if (queryWords.length === 0) return

  let patched = 0
  for (const mem of candidates) {
    const memTri = trigrams(mem.content)
    const sim = trigramSimilarity(queryTri, memTri)
    if (sim < RELEVANCE_THRESHOLD) continue

    // Also check keyword overlap for higher confidence
    const memLower = mem.content.toLowerCase()
    const keywordHits = queryWords.filter(w => memLower.includes(w)).length
    if (sim < 0.12 && keywordHits === 0) continue // need either decent trigram or keyword hit

    // O(1) lookup via _memLookup instead of O(n) findIndex
    const real = _memLookup.get(`${mem.content}\0${mem.ts}`)
    if (!real) continue
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
    console.log(`[cc-soul][recall-feedback] patched ${patched} memories with cross-tags (local trigram)`)
  }
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
    const distMod = getLazyModule('distill'); const getRelevantTopics = distMod?.getRelevantTopics
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
// Old Memory Compression — compress verbose old memories to save storage + tokens
// ═══════════════════════════════════════════════════════════════════════════════

let lastCompression = 0
const COMPRESSION_COOLDOWN = 24 * 3600000 // once per day

/**
 * Compress old memories in-place:
 * - Memories > 7 days old with content > 100 chars → summarize to ~50%
 * - Memories > 30 days old with content > 60 chars → compress to key facts
 * - Preserves history[] for audit trail
 * - Skips: correction, core, consolidated (already condensed)
 */
export function compressOldMemories() {
  const now = Date.now()
  if (now - lastCompression < COMPRESSION_COOLDOWN) return
  lastCompression = now

  const SKIP_SCOPES = new Set(['correction', 'consolidated', 'expired', 'decayed', 'dream', 'curiosity'])
  const SEVEN_DAYS = 7 * 86400000
  const THIRTY_DAYS = 30 * 86400000
  let compressed = 0

  for (const mem of memoryState.memories) {
    if (SKIP_SCOPES.has(mem.scope)) continue
    const age = now - mem.ts

    // Level 1: >7 days, >100 chars → summarize
    if (age > SEVEN_DAYS && mem.content.length > 100 && mem.tier !== 'long_term') {
      const original = mem.content
      // Simple summarization: keep first sentence + key nouns
      const firstSentence = mem.content.split(/[。！？\n]/)[0]
      if (firstSentence && firstSentence.length < mem.content.length * 0.6) {
        if (!mem.history) mem.history = []
        mem.history.push({ content: original, ts: now })
        mem.content = firstSentence.slice(0, 80)
        mem.tier = 'mid_term'
        compressed++
      }
    }

    // Level 2: >30 days, still >60 chars → extract key facts only
    if (age > THIRTY_DAYS && mem.content.length > 60 && mem.tier !== 'long_term') {
      const original = mem.content
      // Keep only first 40 chars as compressed fact
      if (!mem.history) mem.history = []
      if (!mem.history.some(h => h.content === original)) {
        mem.history.push({ content: original, ts: now })
      }
      mem.content = mem.content.slice(0, 40) + '…'
      mem.tier = 'long_term'
      compressed++
    }
  }

  if (compressed > 0) {
    saveMemories()
    console.log(`[cc-soul][compress] compressed ${compressed} old memories`)
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
