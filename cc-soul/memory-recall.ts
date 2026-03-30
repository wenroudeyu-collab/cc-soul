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
  bayesBoost, bayesPenalize, bayesCorrect,
} from './memory.ts'
import {
  trigrams, trigramSimilarity, expandQueryWithSynonyms, shuffleArray, timeDecay,
  SYNONYM_MAP,
} from './memory-utils.ts'

// ── Persistent recall indices (avoid O(n) rebuild each recall) ──
const _contentMap = new Map<string, Memory>()      // content → Memory
export const _memLookup = new Map<string, Memory>()       // "content\0ts" → Memory

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

// ── Lazy-loaded smart-forget for adaptive decay feedback ──
let _smartForgetMod: any = null
setTimeout(() => { import('./smart-forget.ts').then(m => { _smartForgetMod = m }).catch(() => {}) }, 2000)

export function trackRecallImpact(recalledContents: string[], qualityScore: number) {
  // Adaptive decay feedback: track whether recalled memories were useful
  if (_smartForgetMod) {
    const n = recalledContents.length
    if (qualityScore >= 5) {
      for (let i = 0; i < n; i++) _smartForgetMod.recordRecallHit()
    } else {
      for (let i = 0; i < n; i++) _smartForgetMod.recordRecallMiss()
    }
  }

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
      // O(1) lookup via _contentMap — try exact key first (covers most cases)
      const keyPrefix = key.slice(0, 40)
      let mem = _contentMap.get(key)
      if (!mem || mem.scope === 'expired') {
        // Fallback: prefix search on _contentMap (still faster than full memories scan)
        mem = undefined
        for (const [content, m] of _contentMap) {
          if (content.startsWith(keyPrefix) && m.scope !== 'expired') { mem = m; break }
        }
      }
      if (mem) {
        if (qualityScore >= 7) {
          bayesBoost(mem, 1)  // strong positive evidence: α += 1
        } else if (qualityScore <= 3) {
          bayesPenalize(mem, 1)  // negative evidence: β += 1
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

// ── BM25 CJK n-gram tokenizer (2-gram + 3-gram) with stop-word filtering ──
const BM25_STOP_WORDS = new Set('的了是在我你他不有这那就也和但'.split(''))

/** Tokenize for BM25: CJK → 2-gram + 3-gram, Latin → words 3+ chars. Filters stop words. */
function bm25Tokenize(text: string): string[] {
  const tokens: string[] = []
  // Split into CJK runs and Latin runs
  const segments = text.match(/[\u4e00-\u9fff]+|[a-zA-Z]{3,}/g) || []
  for (const seg of segments) {
    if (/[\u4e00-\u9fff]/.test(seg)) {
      // CJK segment: generate 2-gram and 3-gram
      for (let i = 0; i < seg.length - 1; i++) {
        const bigram = seg.slice(i, i + 2)
        // Filter: skip if both chars are stop words
        if (!BM25_STOP_WORDS.has(bigram[0]) || !BM25_STOP_WORDS.has(bigram[1])) {
          tokens.push(bigram)
        }
        if (i < seg.length - 2) {
          tokens.push(seg.slice(i, i + 3))
        }
      }
    } else {
      tokens.push(seg.toLowerCase())
    }
  }
  return tokens
}

function buildIDF(): Map<string, number> {
  if (idfCache && idfCache.size > 0) return idfCache
  const df = new Map<string, number>()
  const N = memoryState.memories.length || 1
  let totalDocLen = 0
  for (const mem of memoryState.memories) {
    const words = bm25Tokenize(mem.content)
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

// ── BM25 tokenization cache: avoid re-tokenizing the same doc content ──
const _bm25TokenCache = new Map<string, { words: string[]; tf: Map<string, number> }>()

function _getDocTokens(doc: string): { words: string[]; tf: Map<string, number> } {
  const cached = _bm25TokenCache.get(doc)
  if (cached) return cached
  const words = bm25Tokenize(doc)
  const tf = new Map<string, number>()
  for (const w of words) tf.set(w, (tf.get(w) || 0) + 1)
  const entry = { words, tf }
  _bm25TokenCache.set(doc, entry)
  // Evict when too large (batch 20%)
  if (_bm25TokenCache.size > 2000) {
    const keys = _bm25TokenCache.keys()
    const evict = Math.floor(_bm25TokenCache.size * 0.2)
    for (let i = 0; i < evict; i++) {
      const k = keys.next().value
      if (k !== undefined) _bm25TokenCache.delete(k)
    }
  }
  return entry
}

/** Invalidate BM25 token cache (call when memories change significantly) */
export function invalidateBM25TokenCache() { _bm25TokenCache.clear() }

function bm25Score(queryWords: Set<string>, doc: string, avgDocLen: number): number {
  const { words: docWords, tf } = _getDocTokens(doc)
  const docLen = docWords.length
  if (docLen === 0) return 0

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

/** MMR (Maximal Marginal Relevance) — 去除召回结果中的语义重复 */
function mmrRerank(candidates: (Memory & { score: number })[], topN: number, lambda = 0.7): (Memory & { score: number })[] {
  if (candidates.length <= topN) return candidates
  const selected: (Memory & { score: number })[] = []
  const remaining = [...candidates]
  while (selected.length < topN && remaining.length > 0) {
    let bestIdx = 0, bestMMR = -Infinity
    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].score
      const maxSim = selected.length > 0
        ? Math.max(...selected.map(s => trigramSimilarity(trigrams(s.content), trigrams(remaining[i].content))))
        : 0
      const mmr = lambda * relevance - (1 - lambda) * maxSim
      if (mmr > bestMMR) { bestMMR = mmr; bestIdx = i }
    }
    selected.push(remaining.splice(bestIdx, 1)[0])
  }
  return selected
}

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

  // Lazy-build BM25 n-gram query tokens (matches bm25Tokenize output)
  let bm25QueryTokens: Set<string> | null = null

  // Use scopeIndex to skip expired/decayed scopes in bulk instead of per-item check
  const SKIP_SCOPES = new Set(['expired', 'decayed'])
  const activeMemories: Memory[] = []
  for (const [scope, mems] of scopeIndex) {
    if (SKIP_SCOPES.has(scope)) continue
    for (const m of mems) activeMemories.push(m)
  }

  // Cache getParam results outside loop to avoid per-memory calls
  const _scopeBoostPref = getParam('recall.scope_boost_preference')
  const _scopeBoostCorr = getParam('recall.scope_boost_correction')
  const _emotionBoostImportant = getParam('recall.emotion_boost_important')
  const _emotionBoostPainful = getParam('recall.emotion_boost_painful')
  const _emotionBoostWarm = getParam('recall.emotion_boost_warm')
  const _userBoostSame = getParam('recall.user_boost_same')
  const _userBoostOther = getParam('recall.user_boost_other')
  const _tierWeightHot = getParam('recall.tier_weight_hot')
  const _tierWeightWarm = getParam('recall.tier_weight_warm')
  const _tierWeightCool = getParam('recall.tier_weight_cool')
  const _tierWeightCold = getParam('recall.tier_weight_cold')
  const _consolidatedBoost = getParam('recall.consolidated_boost')
  const _reflexionBoost = getParam('recall.reflexion_boost')
  const _flashbulbHigh = getParam('recall.flashbulb_high')
  const _flashbulbMedium = getParam('recall.flashbulb_medium')

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
        if (!bm25QueryTokens) bm25QueryTokens = new Set(bm25Tokenize(msg))
        sim = bm25Score(bm25QueryTokens, mem.content, avgDocLen)
      }
    }

    // ── Reasoning field matching: context + conclusion also participate in scoring ──
    if (mem.reasoning) {
      const rText = `${mem.reasoning.context || ''} ${mem.reasoning.conclusion || ''}`.toLowerCase()
      if (rText.length > 5) {
        let rHits = 0
        for (const qw of queryWords) { if (rText.includes(qw)) rHits++ }
        const rSim = rHits / Math.max(1, queryWords.size) * 0.6
        if (rSim > 0) sim = Math.max(sim, sim + rSim * 0.5)
      }
    }

    // ── Causal Chain Enhancement: 当 query 含"为什么/原因/怎么回事"时，利用 reasoning 字段 ──
    if (mem.reasoning && mem.reasoning.conclusion && /为什么|因为|原因|怎么回事|why|because|导致|所以/.test(msg)) {
      const reasonWords = (mem.reasoning.context + ' ' + mem.reasoning.conclusion)
        .match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []
      let reasonHits = 0
      for (const rw of reasonWords) {
        if (queryWords.has(rw.toLowerCase())) reasonHits++
      }
      if (reasonHits > 0) {
        sim = Math.max(sim, sim + reasonHits * 0.12) // 因果内容命中加分
      }
    }
    // ── 如果记忆有 because 字段，也纳入相似度计算 ──
    if (mem.because && queryWords.size > 0) {
      const becauseWords = (mem.because.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map((w: string) => w.toLowerCase())
      const becauseHits = becauseWords.filter((w: string) => queryWords.has(w)).length
      if (becauseHits > 0) {
        sim += becauseHits * 0.08
      }
    }

    if (sim < 0.03) continue

    // ── Causal query boost: "为什么/因为/原因" queries boost memories with because/reasoning ──
    const _isCausalQuery = /为什么|因为|原因|怎么回事|why|because|caused|reason/i.test(msg)
    const causalBoost = _isCausalQuery && (mem.because || mem.reasoning) ? 1.5 : 1.0

    // Weighted scoring: recency (Weibull) + scope boost + emotion boost + userId boost + confidence
    // Unified Weibull decay model from smart-forget.ts (replaces exp(-age * rate))
    const recency = timeDecay(mem)
    // Bonus for recently recalled memories (tags indicate they've been useful)
    const usageBoost = (mem.tags && mem.tags.length > 5) ? 1.2 : 1.0
    const scopeBoost = (mem.scope === 'preference' || mem.scope === 'fact') ? _scopeBoostPref :
                       (mem.scope === 'correction') ? _scopeBoostCorr : 1.0
    let emotionBoost = 1.0
    // Legacy labels
    if (mem.emotion === 'important') emotionBoost = _emotionBoostImportant
    else if (mem.emotion === 'painful') emotionBoost = _emotionBoostPainful
    else if (mem.emotion === 'warm') emotionBoost = _emotionBoostWarm
    // New fine-grained labels (stored in emotionLabel)
    const eLabel = (mem as any).emotionLabel
    if (eLabel === 'anger' || eLabel === 'anxiety') emotionBoost = Math.max(emotionBoost, 1.4)
    else if (eLabel === 'pride' || eLabel === 'relief') emotionBoost = Math.max(emotionBoost, 1.3)
    else if (eLabel === 'frustration' || eLabel === 'sadness') emotionBoost = Math.max(emotionBoost, 1.3)
    // #5 Multi-user memory isolation: same user ×2.0, global ×1.0, other user's private → already filtered above
    const userBoost = (userId && mem.userId && mem.userId === userId) ? _userBoostSame
                    : (userId && mem.userId && mem.userId !== userId) ? _userBoostOther : 1.0
    // #3 HOT/WARM/COLD tier weighting
    const lastAcc = mem.lastAccessed || mem.ts || 0
    const accAgeDays = (Date.now() - lastAcc) / 86400000
    const tierWeight = ((accAgeDays <= 1 || (mem.recallCount ?? 0) >= 5) ? _tierWeightHot   // HOT
                      : (accAgeDays <= 7) ? _tierWeightWarm                                  // WARM
                      : (accAgeDays <= 30) ? _tierWeightCool : _tierWeightCold)              // COLD
    const consolidatedBoost = mem.scope === 'consolidated' ? _consolidatedBoost : mem.scope === 'pinned' ? 2.0 : 1.0
    const reflexionBoost = mem.scope === 'reflexion' ? _reflexionBoost : 1.0
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
    if (ei >= 0.8) moodMatchBoost *= _flashbulbHigh  // "我永远记得那天..." 效应
    else if (ei >= 0.5) moodMatchBoost *= _flashbulbMedium

    // Weighted log-sum scoring (replaces multiplicative — avoids zero-product collapse)
    const _l = Math.log
    const _e = 0.01
    const logScore =
      getParam('recall.w_sim') * _l(sim + _e) + getParam('recall.w_recency') * _l(recency + _e) + getParam('recall.w_scope') * _l(scopeBoost)
      + getParam('recall.w_emotion') * _l(emotionBoost) + getParam('recall.w_user') * _l(userBoost) + getParam('recall.w_mood') * _l(consolidatedBoost)
      + 0.3 * _l(usageBoost) + 0.3 * _l(reflexionBoost) + getParam('recall.w_confidence') * _l(confidenceWeight + _e)
      + 0.5 * _l(temporalWeight + _e) + 0.7 * _l(graphBoost) + 0.3 * _l(tierWeight)
      + 0.3 * _l(impactBoost) + 0.2 * _l(archiveWeight) + getParam('recall.w_mood') * _l(moodMatchBoost)
      + 0.4 * _l(causalBoost)

    // ── State-Dependent Memory Gating (Godden & Baddeley 1975) ──
    // 在不同情绪/能量状态下，某些记忆更难被访问
    let stateGate = 1.0
    if (mem.situationCtx && moodCtx) {
      const moodDist = Math.abs((moodCtx.mood || 0) - (mem.situationCtx.mood || 0))
      const alertDist = Math.abs((moodCtx.alertness || 0) - (mem.situationCtx.alertness || 0))
      const stateDist = Math.sqrt(moodDist * moodDist + alertDist * alertDist)
      // sigmoid gate: 状态差异大 → gate 关闭
      stateGate = 1 / (1 + Math.exp(stateDist * 3 - 1.5))
      // 最低不低于 0.1（完全封锁太极端）
      stateGate = Math.max(0.1, stateGate)
    }

    scored.push({ ...mem, score: logScore * stateGate })
  }

  // ── Spreading Activation with IDF weighting: memories activate related memories ──
  // High-scoring memories "wake up" other memories that share keywords,
  // weighted by IDF so rare/distinctive words propagate more activation.
  if (scored.length >= 3) {
    // Pre-sort to pick top activators and limit spread candidates
    scored.sort((a, b) => b.score - a.score)
    const spreadLimit = Math.min(scored.length, topN * 3)
    const topActivators = scored.slice(0, 3).filter(s => s.score > 0.1)
    if (topActivators.length > 0) {
      // Build IDF-weighted activation map: word → IDF weight
      const idfMap = buildIDF()
      const activatedWordWeights = new Map<string, number>()
      for (const act of topActivators) {
        const words = (act.content.match(/[\u4e00-\u9fff]{2,4}|[a-zA-Z]{3,}/gi) || [])
        for (const w of words) {
          const wl = w.toLowerCase()
          const idfW = idfMap.get(wl) ?? 1.0
          activatedWordWeights.set(wl, Math.max(activatedWordWeights.get(wl) ?? 0, idfW))
        }
      }
      // Boost only top candidates with IDF-weighted activation score
      for (let si = 3; si < spreadLimit; si++) {
        const s = scored[si]
        const sWords = (s.content.match(/[\u4e00-\u9fff]{2,4}|[a-zA-Z]{3,}/gi) || []).map(w => w.toLowerCase())
        let activation = 0
        for (const w of sWords) {
          const wt = activatedWordWeights.get(w)
          if (wt !== undefined) activation += wt
        }
        if (activation > 0) {
          s.score *= (1 + Math.min(activation * 0.1, 0.5)) // IDF-weighted activation boost, capped +50%
        }
      }
    }
  }

  scored.sort((a, b) => b.score - a.score)

  // ═══════════════════════════════════════════════════════════════════════════════
  // RRF (Reciprocal Rank Fusion) — multi-channel re-ranking
  // Each channel sorts independently, then fused via 1/(k+rank) to reduce
  // sensitivity to any single scoring dimension's scale.
  // ═══════════════════════════════════════════════════════════════════════════════
  if (scored.length >= 4) {
    // Build per-channel rank arrays using different sort keys
    // Channel 1: BM25/trigram sim (already primary factor in logScore, re-sort by sim component)
    const ch1 = scored.map((s, i) => ({ idx: i, key: s.score }))  // overall score as proxy for textual match
    // Channel 2: recency — newer memories ranked higher
    const ch2 = scored.map((s, i) => ({ idx: i, key: s.lastAccessed || s.ts || 0 }))
    ch2.sort((a, b) => b.key - a.key)
    // Channel 3: scope+emotion boost
    const ch3 = scored.map((s, i) => {
      const scopeW = (s.scope === 'correction') ? 3 : (s.scope === 'preference' || s.scope === 'fact') ? 2
        : (s.scope === 'consolidated') ? 2.5 : (s.scope === 'pinned') ? 4 : 1
      const emotionW = (s.emotion === 'important') ? 1.4 : (s.emotion === 'painful') ? 1.3 : 1.0
      const eiW = (s.emotionIntensity ?? 0) >= 0.8 ? 1.6 : (s.emotionIntensity ?? 0) >= 0.5 ? 1.2 : 1.0
      return { idx: i, key: scopeW * emotionW * eiW }
    })
    ch3.sort((a, b) => b.key - a.key)
    // Channel 4: graph/entity relevance (use graphBoost proxy — memories with expansion word hits)
    const ch4 = scored.map((s, i) => {
      let graphHits = 0
      if (expansionWords.size > 0) {
        const ml = s.content.toLowerCase()
        for (const w of expansionWords) { if (ml.includes(w)) graphHits++ }
      }
      return { idx: i, key: graphHits + (s.recallCount ?? 0) * 0.1 }
    })
    ch4.sort((a, b) => b.key - a.key)

    // Build rank maps: idx → rank (0-based)
    const rankMaps: Map<number, number>[] = []
    for (const channel of [ch1, ch2, ch3, ch4]) {
      const rm = new Map<number, number>()
      for (let r = 0; r < channel.length; r++) rm.set(channel[r].idx, r)
      rankMaps.push(rm)
    }

    // RRF fusion: score = Σ 1/(k + rank_i)
    const RRF_K = 60
    for (let i = 0; i < scored.length; i++) {
      let rrfScore = 0
      for (const rm of rankMaps) {
        const rank = rm.get(i) ?? scored.length
        rrfScore += 1 / (RRF_K + rank)
      }
      // Blend: 60% original logScore ranking + 40% RRF (avoid completely overriding tuned weights)
      const originalRank = i  // already sorted by logScore
      const originalRRF = 1 / (RRF_K + originalRank)
      scored[i].score = 0.6 * scored[i].score + 0.4 * (rrfScore * 1000) // scale RRF to comparable range
    }
    scored.sort((a, b) => b.score - a.score)
  }

  const topResults = mmrRerank(scored.slice(0, topN * 3), topN)

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
      bayesBoost(mem, 0.5)  // Bayesian posterior update: α += 0.5
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

// ═══════════════════════════════════════════════════════════════════════════════
// Meta-memory: Tip-of-Tongue recall
// ═══════════════════════════════════════════════════════════════════════════════

/** 元记忆分级：recalled (确定记得) / tip_of_tongue (有印象但不确定) / not_found */
export interface MetamemoryResult {
  memory: Memory
  score: number
  state: 'recalled' | 'tip_of_tongue'
  hint?: string  // tip_of_tongue 时给出模糊提示
}

export function recallWithMetamemory(msg: string, topN: number = 3, userId?: string, channelId?: string, moodCtx?: { mood: number; alertness: number }): MetamemoryResult[] {
  // 多检索一些候选
  const scored = recallWithScores(msg, topN * 3, userId, channelId, moodCtx)
  const results: MetamemoryResult[] = []

  for (const mem of scored) {
    if (mem.score > 0.3) {
      results.push({ memory: mem, score: mem.score, state: 'recalled' })
    } else if (mem.score > 0.08 && results.length < topN * 2) {
      // Tip of tongue: 有信号但不确定
      const topic = (mem.content.match(/[\u4e00-\u9fff]{2,4}|[a-zA-Z]{4,}/)?.[0]) || '某个话题'
      results.push({
        memory: mem,
        score: mem.score,
        state: 'tip_of_tongue',
        hint: `好像聊过${topic}相关的内容`,
      })
    }
  }

  // 确定记得的优先，tip_of_tongue 补充
  const recalled = results.filter(r => r.state === 'recalled').slice(0, topN)
  const tipOfTongue = results.filter(r => r.state === 'tip_of_tongue').slice(0, 2)
  return [...recalled, ...tipOfTongue]
}

/** Detect if user is explicitly asking about past memories */
const MEMORY_RECALL_TRIGGERS = /你还记得|你记不记得|之前说过|上次提到|我们聊过|你忘了吗|还记得吗/

/** Public recall — strips internal score field from results. Merges OpenClaw native memory if available. */
export function recall(msg: string, topN = 3, userId?: string, channelId?: string, moodCtx?: { mood: number; alertness: number }, opts?: { awaitVector?: boolean }): Memory[] {
  // Auto-detect memory recall triggers → force awaitVector
  const awaitVector = opts?.awaitVector ?? MEMORY_RECALL_TRIGGERS.test(msg)

  // ── Fast path: SQLite direct query (no need for loadMemories) ──
  // If memories haven't been loaded into memoryState yet, use SQLite directly.
  // This avoids the 4-5 second loadMemories() cost on first call.
  let ccResults: Memory[]

  if (!_memoriesLoaded && ensureSQLiteReady()) {
    // Use synchronous tagRecall — queries SQLite directly
    ccResults = sqliteTagRecall(msg, topN, userId, channelId)
  } else if (_memoriesLoaded) {
    // Memories already in-memory, use the full scoring pipeline
    ccResults = recallWithScores(msg, topN, userId, channelId, moodCtx) as Memory[]
  } else {
    // No SQLite, no in-memory — lightweight JSON file search (no full load)
    ccResults = recallFromJsonFile(msg, topN)
  }

  // ── Vector recall: await or fire-and-forget based on awaitVector flag ──
  if (ensureSQLiteReady() && hasVectorSearch()) {
    const cacheKey = `${userId || ''}:${channelId || ''}`
    if (awaitVector) {
      // Synchronous-ish: race with 100ms timeout, merge results into current turn
      // We use a blocking approach via shared state since recall() is sync
      let resolved = false
      const vecPromise = sqliteRecallAsync(msg, topN, userId, channelId)
      const timeoutPromise = new Promise<Memory[]>(res => setTimeout(() => res([]), 100))
      Promise.race([vecPromise, timeoutPromise]).then(vecResults => {
        if (vecResults.length > 0 && !resolved) {
          resolved = true
          _lastVectorResults = vecResults.slice(0, 5)
          _lastVectorResultsKey = cacheKey
          // Merge into ccResults if still in scope (synchronous merge for this turn)
          const seen = new Set(ccResults.map(m => m.content.slice(0, 60)))
          for (const m of vecResults) {
            if (!seen.has(m.content.slice(0, 60))) {
              ccResults.push(m)
              seen.add(m.content.slice(0, 60))
            }
          }
        }
      }).catch(() => {})
      // Also cache for next turn regardless
    } else {
      sqliteRecallAsync(msg, topN, userId, channelId).then(vecResults => {
        if (vecResults.length > 0) {
          console.log(`[cc-soul][recall] vector search found ${vecResults.length} semantic matches`)
          _lastVectorResults = vecResults.slice(0, 5)
          _lastVectorResultsKey = cacheKey
        }
      }).catch(() => {})
    }
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
    const expanded = recallWithScores(msg, topN * 3, userId, channelId, moodCtx) as Memory[]
    const seen = new Set(ccResults.map(m => m.content.slice(0, 60)))
    for (const m of expanded) {
      if (!seen.has(m.content.slice(0, 60)) && ccResults.length < topN) {
        ccResults.push(m)
        seen.add(m.content.slice(0, 60))
      }
    }
  }

  // Fusion rerank: sort merged results by relevance
  // Reuse scores from recallWithScores when available; only compute trigram for non-scored results
  if (ccResults.length > topN) {
    const queryTri = trigrams(msg)
    ccResults.sort((a, b) => {
      // If result already has a score from recallWithScores, use it directly
      const scoreA = (a as any).score ?? trigramSimilarity(queryTri, trigrams(a.content))
      const scoreB = (b as any).score ?? trigramSimilarity(queryTri, trigrams(b.content))
      const scopeA = (a.scope === 'preference' || a.scope === 'fact') ? 1.3 : a.scope === 'correction' ? 1.5 : 1.0
      const scopeB = (b.scope === 'preference' || b.scope === 'fact') ? 1.3 : b.scope === 'correction' ? 1.5 : 1.0
      return (scoreB * scopeB) - (scoreA * scopeA)
    })
    ccResults = ccResults.slice(0, topN)
  }

  // Strip internal score field before returning
  return ccResults.slice(0, topN).map(m => { const { score: _, ...rest } = m as any; return rest as Memory })
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
  _bm25TokenCache.clear()
}

/**
 * Degrade confidence of a memory when it's contradicted or corrected.
 * If confidence drops to ≤0.1, mark as expired (too unreliable).
 */
export function degradeMemoryConfidence(content: string) {
  const mem = memoryState.memories.find(m => m.content === content)
  if (mem) {
    bayesCorrect(mem, 2)  // strong negative: β += 2 (user correction)
    if (mem.confidence <= 0.1) {
      mem.scope = 'expired'
    }
    syncToSQLite(mem, { confidence: mem.confidence, scope: mem.scope })
    saveMemories()
    console.log(`[cc-soul][confidence] degraded: "${content.slice(0, 50)}" → ${mem.confidence.toFixed(2)}${mem.scope === 'expired' ? ' (expired)' : ''}`)
  }
}
