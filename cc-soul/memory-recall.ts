/**
 * memory-recall.ts — Recall engine extracted from memory.ts
 * BM25 scoring, hybrid recall (tag + trigram + BM25 + vector + OpenClaw FTS),
 * recall stats/impact tracking, fused multi-modal recall.
 */

import { resolve } from 'path'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import type { Memory } from './types.ts'
import { DATA_DIR, debouncedSave, MEMORIES_PATH } from './persistence.ts'
import { getParam } from './auto-tune.ts'
import {
  sqliteRecall as sqliteRecallAsync, tagRecall as sqliteTagRecall,
  sqliteFindByContent, sqliteUpdateMemory,
  sqliteRecallByTime as _sqliteRecallByTime,
  isSQLiteReady, hasVectorSearch,
} from './sqlite-store.ts'
import { findMentionedEntities, getRelatedEntities, graphWalkRecall } from './graph.ts'
import {
  memoryState, scopeIndex, useSQLite, _memoriesLoaded, ensureSQLiteReady,
  saveMemories, syncToSQLite, getLazyModule,
} from './memory.ts'
import {
  trigrams, trigramSimilarity, expandQueryWithSynonyms, shuffleArray, timeDecay,
  SYNONYM_MAP,
} from './memory-utils.ts'

// ── Persistent recall indices (avoid O(n) rebuild each recall) ──
const _contentMap = new Map<string, Memory>()      // content → Memory
const _memLookup = new Map<string, Memory>()       // "content\0ts" → Memory

/** Call when a new memory is added to keep recall indices in sync */
export function updateRecallIndex(mem: Memory) {
  _contentMap.set(mem.content, mem)
  _memLookup.set(`${mem.content}\0${mem.ts}`, mem)
}

/** Full rebuild (call after eviction or bulk load) */
export function rebuildRecallIndex(memories: Memory[]) {
  _contentMap.clear()
  _memLookup.clear()
  for (const m of memories) {
    _contentMap.set(m.content, m)
    _memLookup.set(`${m.content}\0${m.ts}`, m)
  }
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
export function recallWithScores(msg: string, topN = 3, userId?: string, channelId?: string, moodCtx?: { mood: number; alertness: number }): (Memory & { score: number })[] {
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
    // Cognitive science: mood-congruent recall — your emotional state biases what you remember
    let moodMatchBoost = 1.0
    if (moodCtx) {
      // Strong mood congruence: emotional memories surface when mood matches
      if (moodCtx.mood > 0.3 && mem.emotion === 'warm') moodMatchBoost = 1.5
      else if (moodCtx.mood < -0.3 && mem.emotion === 'painful') moodMatchBoost = 1.5
      else if (moodCtx.mood < -0.3 && mem.emotion === 'warm') moodMatchBoost = 0.6  // happy memories suppressed when sad
      else if (moodCtx.mood > 0.3 && mem.emotion === 'painful') moodMatchBoost = 0.7  // painful suppressed when happy
      // High alertness: boost corrections and important memories (hyper-vigilant state)
      if (moodCtx.alertness > 0.7 && (mem.emotion === 'important' || mem.scope === 'correction')) moodMatchBoost *= 1.3

      // Fine-grained emotion congruence: same emotion type → boost
      if (eLabel && moodCtx) {
        try {
          const bodyM = getLazyModule('body'); const lastDetectedEmotion = bodyM?.lastDetectedEmotion
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
    // Flashbulb memory effect: high emotional intensity → always easier to recall
    const ei = mem.emotionIntensity ?? 0
    if (ei >= 0.8) moodMatchBoost *= 1.6  // "我永远记得那天..." 效应
    else if (ei >= 0.5) moodMatchBoost *= 1.2

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
    const topContents = new Set(topResults.map(r => r.content))
    for (const entity of mentionedEntities) {
      const walked = graphWalkRecall(entity, memoryState.memories, 2, 6)
      for (const wContent of walked) {
        if (topContents.has(wContent) || topResults.length >= topN) break
        const mem = _contentMap.get(wContent)
        if (mem) {
          topResults.push({ ...mem, score: 0 })
          topContents.add(wContent)
        }
      }
    }
  }

  // Boost confidence + update lastAccessed + recallCount on recalled memories
  for (const result of topResults) {
    const mem = _memLookup.get(`${result.content}\0${result.ts}`)
    if (mem) {
      mem.lastAccessed = Date.now()
      mem.confidence = Math.min(1.0, (mem.confidence ?? 0.7) + 0.02)
      mem.recallCount = (mem.recallCount ?? 0) + 1
      mem.lastRecalled = Date.now()
      syncToSQLite(mem, { confidence: mem.confidence, recallCount: mem.recallCount, lastAccessed: mem.lastAccessed, lastRecalled: mem.lastRecalled })
      // Memory reconsolidation: recalled memories absorb current context
      // Like human memory — each recall slightly modifies the memory
      if (!mem.recallContexts) mem.recallContexts = []
      const ctxSnippet = msg.slice(0, 40)
      if (!mem.recallContexts.includes(ctxSnippet)) {
        mem.recallContexts.push(ctxSnippet)
        if (mem.recallContexts.length > 5) mem.recallContexts.shift()
      }

      // Deep reconsolidation: after 5+ recalls in different contexts,
      // append a "[多次被提及]" marker to help LLM understand importance
      if ((mem.recallCount ?? 0) >= 5 && !mem.content.includes('[多次被提及]')) {
        const uniqueContexts = new Set(mem.recallContexts).size
        if (uniqueContexts >= 3) {
          // Save original to history before modifying
          if (!mem.history) mem.history = []
          mem.history.push({ content: mem.content, ts: Date.now() })
          mem.content = `[多次被提及] ${mem.content}`
          mem.tier = 'long_term'  // promote to long-term
          syncToSQLite(mem, { content: mem.content, tier: mem.tier })
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

/**
 * Time-based memory query: recall memories from a specific time range.
 * Supports natural language shortcuts: 'today', 'yesterday', 'last_week', 'last_month'
 * or explicit {from, to} timestamps.
 */
export function recallByTime(
  opts: { range?: 'today' | 'yesterday' | 'last_week' | 'last_month' | 'last_3_days'; from?: number; to?: number; scope?: string; userId?: string; topN?: number }
): Memory[] {
  const now = Date.now()
  const DAY = 86400000
  let from = opts.from ?? 0
  let to = opts.to ?? now

  if (opts.range) {
    switch (opts.range) {
      case 'today': from = now - DAY; break
      case 'yesterday': from = now - 2 * DAY; to = now - DAY; break
      case 'last_3_days': from = now - 3 * DAY; break
      case 'last_week': from = now - 7 * DAY; break
      case 'last_month': from = now - 30 * DAY; break
    }
  }

  const topN = opts.topN ?? 20

  // Prefer SQLite path: uses idx_mem_scope_ts composite index → O(log n)
  if (isSQLiteReady()) {
    try {
      const sqlResults = _sqliteRecallByTime({ from, to, scope: opts.scope, userId: opts.userId, topN })
      if (sqlResults.length > 0) return sqlResults
    } catch { /* fallback to in-memory scan */ }
  }

  // Fallback: in-memory scan (for compatibility when SQLite unavailable)
  const results = memoryState.memories.filter(m => {
    if (m.scope === 'expired' || m.scope === 'decayed') return false
    if (m.ts < from || m.ts > to) return false
    if (opts.scope && m.scope !== opts.scope) return false
    if (opts.userId && m.userId !== opts.userId) return false
    return true
  })

  // Sort by timestamp descending (newest first)
  results.sort((a, b) => b.ts - a.ts)
  return results.slice(0, topN)
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
/** Incremental IDF update for a single new document — avoids full O(n) rebuild */
export function incrementalIDFUpdate(content: string) {
  if (!idfCache) return // no cache built yet, buildIDF() will do full build on next recall
  const words = (content.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase())
  if (words.length === 0) return
  const N = memoryState.memories.length || 1
  const unique = new Set(words)
  for (const w of unique) {
    // Approximate: increment df, recompute idf for this word only
    const oldIdf = idfCache.get(w)
    const oldDf = oldIdf !== undefined ? Math.round(N / Math.exp(oldIdf)) - 1 : 0
    const newDf = oldDf + 1
    idfCache.set(w, Math.log(N / (1 + newDf)))
  }
  // Update avgDocLen incrementally
  if (avgDocLenCache !== null) {
    const prevTotal = avgDocLenCache * (N - 1)
    avgDocLenCache = (prevTotal + words.length) / N
  }
}
export function invalidateIDF() {
  // Throttle: don't invalidate if IDF was rebuilt less than 60s ago AND under 50 calls
  // This prevents O(n) rebuild on every addMemory when memories are added in bursts
  idfInvalidateCount++
  if (idfInvalidateCount < 50 && idfCache && (Date.now() - lastIdfBuildTs < 60000)) return
  idfCache = null
  avgDocLenCache = null
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
