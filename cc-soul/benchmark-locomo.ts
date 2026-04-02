/**
 * benchmark-locomo.ts — LOCOMO-MC10 基准测试
 *
 * 两层测试：
 *   Layer 1: 召回质量（Hit@K, MRR）— 测 NAM 引擎本身
 *   Layer 2: 端到端准确率（10 选 1）— 测 NAM + 答案选择
 *
 * 用法: npx tsx cc-soul/benchmark-locomo.ts [--conv N] [--type TYPE] [--top-k K] [--verbose] [--limit N]
 */

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import type { Memory } from './types.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const require = createRequire(import.meta.url)

// Suppress noisy logs during benchmark
const _origLog = console.log
const _origWarn = console.warn
let suppressLogs = false
console.log = (...args: any[]) => { if (!suppressLogs) _origLog(...args) }
console.warn = (...args: any[]) => { if (!suppressLogs) _origWarn(...args) }
const print = _origLog  // always prints

// Lazy-load modules
const { activationRecall } = require('./activation-field.ts')
const { learnAssociation } = require('./aam.ts')
const { trigrams, trigramSimilarity } = require('./memory-utils.ts')

// ═══════════════════════════════════════════════════════════════
// DATA TYPES
// ═══════════════════════════════════════════════════════════════

interface LocomoQuestion {
  question_id: string
  question: string
  question_type: string
  answer: string
  correct_choice_index: number
  num_choices: number
  num_sessions: number
  choices: string[]
  haystack_session_ids: string[]
  haystack_session_summaries: string[]
  haystack_session_datetimes: string[]
  haystack_sessions: Array<Array<{ role: string; content: string }>>
}

// ═══════════════════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════════════════

function loadDataset(): LocomoQuestion[] {
  const dataPath = resolve(__dirname, '../data/locomo_mc10.json')
  const raw = readFileSync(dataPath, 'utf-8')
  const questions: LocomoQuestion[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) questions.push(JSON.parse(trimmed))
  }
  return questions
}

// ═══════════════════════════════════════════════════════════════
// MEMORY CONSTRUCTION
// ═══════════════════════════════════════════════════════════════

function buildMemories(q: LocomoQuestion): Memory[] {
  const memories: Memory[] = []

  // ── 时间归一化：保持 session 间的相对间隔，平移到最近 ──
  // LOCOMO 对话来自 2023 年，ACT-R 对 3 年前的记忆给出 ≈0 的基础激活。
  // 真实场景下记忆是持续更新的。我们保持对话间的相对时间间隔，
  // 但把最后一个 session 的时间设为"1天前"，其余按比例回推。
  const originalTimestamps = q.haystack_session_datetimes.map(d => new Date(d).getTime())
  const minTs = Math.min(...originalTimestamps)
  const maxTs = Math.max(...originalTimestamps)
  const timeSpan = Math.max(maxTs - minTs, 1)
  const now = Date.now()
  // 映射：最早的 session → N 天前，最晚的 → 1 小时前
  // 压缩到最近 14 天内（ACT-R 对超过 30 天的记忆激活值趋零）
  const TARGET_SPAN = 14 * 86400000  // 14 天
  const TARGET_END = now - 3600000   // 1 小时前

  function normalizeTs(originalTs: number): number {
    const ratio = (originalTs - minTs) / timeSpan  // 0 = earliest, 1 = latest
    return TARGET_END - TARGET_SPAN * (1 - ratio)
  }

  for (let si = 0; si < q.haystack_sessions.length; si++) {
    const session = q.haystack_sessions[si]
    const baseTs = normalizeTs(originalTimestamps[si])

    // Session summary → high-level distilled memory
    // Summary 代表蒸馏知识，在真实系统中会被持续访问（每次 recall 都可能触及）
    const summary = q.haystack_session_summaries[si]
    if (summary) {
      memories.push({
        content: summary,
        scope: 'fact',
        ts: baseTs,
        confidence: 0.95,
        recallCount: 10,  // 蒸馏知识被频繁访问
        lastAccessed: now - 3600000,  // 最近 1 小时内被访问（模拟 heartbeat 巩固）
        importance: 8,
        tags: ['summary'],
      } as Memory)
    }

    // Each turn → episode memory
    for (let ti = 0; ti < session.length; ti++) {
      const content = session[ti]?.content
      if (!content || content.length < 10) continue

      const memTs = baseTs + ti * 60000
      memories.push({
        content,
        scope: 'episode',
        ts: memTs,
        confidence: 0.8,
        recallCount: 3,
        // lastAccessed 不能超过 now，模拟"最近一轮对话中被间接触及"
        lastAccessed: Math.min(now - 7200000, memTs + 86400000),  // min(2h ago, created+1day)
        importance: 5,
      } as Memory)
    }
  }

  return memories
}

// ═══════════════════════════════════════════════════════════════
// LAYER 1: RECALL QUALITY (Hit@K, MRR)
// ═══════════════════════════════════════════════════════════════

/**
 * Check if any recalled memory contains the answer.
 * Dynamic matching: tries exact substring, then token overlap, then fuzzy.
 */
function answerInRecalled(recalled: Memory[], answer: string): { hit: boolean; rank: number } {
  const ansLower = answer.toLowerCase().trim()

  // Skip "Not answerable" — recall test doesn't apply
  if (/not answerable|cannot be answered|unanswerable/i.test(answer)) {
    return { hit: false, rank: -1 }
  }

  // Tokenize answer for flexible matching
  const ansTokens = ansLower.split(/\s+/).filter(t => t.length >= 2)
  const ansTri = trigrams(ansLower)

  for (let i = 0; i < recalled.length; i++) {
    const memLower = recalled[i].content.toLowerCase()

    // Strategy 1: exact substring
    if (memLower.includes(ansLower)) return { hit: true, rank: i + 1 }

    // Strategy 2: all significant answer tokens present in memory
    if (ansTokens.length > 0) {
      const tokenHits = ansTokens.filter(t => memLower.includes(t)).length
      const coverage = tokenHits / ansTokens.length
      if (coverage >= 0.8) return { hit: true, rank: i + 1 }
    }

    // Strategy 3: trigram similarity (fuzzy match for names, dates, etc.)
    const memTri = trigrams(memLower)
    const triSim = trigramSimilarity(ansTri, memTri)
    if (triSim > 0.4 && ansLower.length >= 4) return { hit: true, rank: i + 1 }
  }

  return { hit: false, rank: -1 }
}

// ═══════════════════════════════════════════════════════════════
// LAYER 2: ANSWER SELECTION (10-choice)
// ═══════════════════════════════════════════════════════════════

function selectAnswer(recalled: Memory[], choices: string[]): { choiceIndex: number; confidence: number } {
  if (recalled.length === 0) {
    const naIdx = choices.findIndex(c => /not answerable|cannot be answered|unanswerable/i.test(c))
    return { choiceIndex: naIdx >= 0 ? naIdx : 0, confidence: 0 }
  }

  const context = recalled.map(m => m.content).join(' ').toLowerCase()

  // S0: Extract entities from recalled memories for precise matching
  const entitySet = new Set<string>()
  const allRecalledText = recalled.map(m => m.content).join(' ')
  // Dates like "7 January 2023"
  const dateMatches = allRecalledText.match(/\d{1,2}\s+\w+\s+\d{4}/g) || []
  for (const d of dateMatches) entitySet.add(d.toLowerCase())
  // Numbers (standalone, 2+ digits to avoid noise)
  const numMatches = allRecalledText.match(/\b\d{2,}\b/g) || []
  for (const n of numMatches) entitySet.add(n)
  // Capitalized names (sequences of capitalized words)
  const nameMatches = allRecalledText.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || []
  for (const name of nameMatches) {
    entitySet.add(name.toLowerCase())
    // Also add individual parts for multi-word names
    for (const part of name.split(/\s+/)) {
      if (part.length >= 2) entitySet.add(part.toLowerCase())
    }
  }

  const scores = choices.map((choice, idx) => {
    const choiceLower = choice.toLowerCase().trim()

    // Dynamic scoring: try multiple strategies, take the best
    let score = 0

    // S0: entity exact matching (highest priority for factual questions)
    if (entitySet.size > 0) {
      let entityHits = 0
      for (const entity of entitySet) {
        if (choiceLower.includes(entity)) entityHits++
      }
      // Normalize by entity count, weight higher than token coverage
      if (entityHits > 0) {
        score = Math.max(score, Math.min(1.0, entityHits / Math.max(3, entitySet.size) * 1.5))
      }
    }

    // S1: exact substring (strongest)
    if (context.includes(choiceLower)) {
      score = Math.max(score, 1.0)
    }

    // S2: token coverage (flexible)
    const tokens = choiceLower.split(/\s+/).filter(t => t.length >= 2)
    if (tokens.length > 0) {
      const hits = tokens.filter(t => context.includes(t)).length
      score = Math.max(score, hits / tokens.length * 0.8)
    }

    // S3: per-memory trigram (fuzzy)
    const choiceTri = trigrams(choiceLower)
    for (const mem of recalled) {
      const sim = trigramSimilarity(choiceTri, trigrams(mem.content.toLowerCase()))
      score = Math.max(score, sim * 0.6)
    }

    return { idx, score }
  })

  scores.sort((a, b) => b.score - a.score)

  // Low confidence + "Not answerable" available → dynamic fallback
  if (scores[0].score < 0.15) {
    const naIdx = choices.findIndex(c => /not answerable|cannot be answered|unanswerable/i.test(c))
    if (naIdx >= 0) return { choiceIndex: naIdx, confidence: scores[0].score }
  }

  return { choiceIndex: scores[0].idx, confidence: scores[0].score }
}

// ═══════════════════════════════════════════════════════════════
// RUNNER
// ═══════════════════════════════════════════════════════════════

function parseArgs() {
  const args = process.argv.slice(2)
  let conv: number | undefined, type: string | undefined, topK = 10, verbose = false, limit = 0
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--conv' && args[i + 1]) conv = parseInt(args[++i])
    if (args[i] === '--type' && args[i + 1]) type = args[++i]
    if (args[i] === '--top-k' && args[i + 1]) topK = parseInt(args[++i])
    if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[++i])
    if (args[i] === '--verbose') verbose = true
  }
  return { conv, type, topK, verbose, limit }
}

function run() {
  const opts = parseArgs()
  print('═══════════════════════════════════════════════════════════')
  print('  cc-soul NAM × LOCOMO-MC10 Benchmark')
  print('═══════════════════════════════════════════════════════════')
  print(`  top-K: ${opts.topK}  conv: ${opts.conv ?? 'all'}  type: ${opts.type ?? 'all'}  limit: ${opts.limit || 'none'}`)
  print()

  const allQuestions = loadDataset()
  print(`  Loaded ${allQuestions.length} questions`)

  // Group by conversation
  const convMap = new Map<string, LocomoQuestion[]>()
  for (const q of allQuestions) {
    const convId = q.question_id.split('_')[0]
    if (!convMap.has(convId)) convMap.set(convId, [])
    convMap.get(convId)!.push(q)
  }
  const convIds = [...convMap.keys()].sort()
  print(`  ${convIds.length} conversations`)
  print()

  // Filter
  let questions = allQuestions
  if (opts.conv !== undefined) {
    const targetConv = convIds[opts.conv]
    if (!targetConv) { print(`  Invalid conv index: ${opts.conv}`); return }
    questions = convMap.get(targetConv) || []
    print(`  Filtered to conv ${targetConv}: ${questions.length} questions`)
  }
  if (opts.type) {
    questions = questions.filter(q => q.question_type === opts.type)
    print(`  Filtered to type ${opts.type}: ${questions.length} questions`)
  }
  if (opts.limit > 0) {
    questions = questions.slice(0, opts.limit)
    print(`  Limited to first ${questions.length} questions`)
  }

  if (questions.length === 0) { print('  No questions.'); return }

  // Memory cache per conversation
  const memoryCache = new Map<string, Memory[]>()
  const learnedConvs = new Set<string>()

  // Trackers
  const typeStats: Record<string, {
    recallHits: number, recallTotal: number,  // Layer 1
    mrrSum: number,
    mcCorrect: number, mcTotal: number,       // Layer 2
  }> = {}
  function getStat(type: string) {
    if (!typeStats[type]) typeStats[type] = { recallHits: 0, recallTotal: 0, mrrSum: 0, mcCorrect: 0, mcTotal: 0 }
    return typeStats[type]
  }

  const startTime = Date.now()

  // Suppress module logs during benchmark
  suppressLogs = true

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi]
    const convId = q.question_id.split('_')[0]

    // Build memories (cached)
    if (!memoryCache.has(convId)) {
      const memories = buildMemories(q)
      memoryCache.set(convId, memories)
      if (!learnedConvs.has(convId)) {
        for (const mem of memories) learnAssociation(mem.content, 0.2)
        learnedConvs.add(convId)
        suppressLogs = false
        print(`  [${convId}] ${memories.length} memories loaded`)
        suppressLogs = true
      }
    }
    const memories = memoryCache.get(convId)!

    // Recall
    const recalled: Memory[] = activationRecall(memories, q.question, opts.topK, 0, 0.5)

    const stat = getStat(q.question_type)

    // Layer 1: Recall quality
    const isAdversarial = /not answerable|cannot be answered|unanswerable/i.test(q.answer)
    if (!isAdversarial) {
      stat.recallTotal++
      const { hit, rank } = answerInRecalled(recalled, q.answer)
      if (hit) {
        stat.recallHits++
        stat.mrrSum += 1 / rank
      }
    }

    // Layer 2: MC accuracy
    stat.mcTotal++
    const { choiceIndex, confidence } = selectAnswer(recalled, q.choices)
    if (choiceIndex === q.correct_choice_index) stat.mcCorrect++

    // Verbose
    if (opts.verbose) {
      const mcOk = choiceIndex === q.correct_choice_index
      suppressLogs = false
      print(`  ${mcOk ? '✅' : '❌'} [${q.question_type.padEnd(20)}] ${q.question.slice(0, 55)}`)
      if (!mcOk) {
        print(`     want: ${q.answer.slice(0, 50)}`)
        print(`     got:  ${q.choices[choiceIndex]?.slice(0, 50)} (conf=${confidence.toFixed(2)})`)
      }
      suppressLogs = true
    }

    // Progress
    if ((qi + 1) % 50 === 0) {
      suppressLogs = false
      const elapsed = (Date.now() - startTime) / 1000
      print(`  ... ${qi + 1}/${questions.length} (${(elapsed).toFixed(0)}s)`)
      suppressLogs = true
    }
  }

  suppressLogs = false
  const elapsed = (Date.now() - startTime) / 1000

  // ═══════════════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════════════

  print()
  print('═══════════════════════════════════════════════════════════')
  print('  Layer 1: Recall Quality (答案是否在 top-K 中)')
  print('═══════════════════════════════════════════════════════════')
  print()
  print('  Type                    Hit@K    MRR     N')
  print('  ──────────────────────  ──────  ──────  ────')
  const typeOrder = ['single_hop', 'multi_hop', 'temporal_reasoning', 'open_domain', 'adversarial']
  let totalRecallHits = 0, totalRecallN = 0, totalMRR = 0
  for (const type of typeOrder) {
    const s = typeStats[type]
    if (!s || s.recallTotal === 0) continue
    const hitRate = (s.recallHits / s.recallTotal * 100).toFixed(1)
    const mrr = (s.mrrSum / s.recallTotal).toFixed(3)
    print(`  ${type.padEnd(24)} ${hitRate.padStart(5)}%  ${mrr.padStart(6)}  ${String(s.recallTotal).padStart(4)}`)
    totalRecallHits += s.recallHits
    totalRecallN += s.recallTotal
    totalMRR += s.mrrSum
  }
  if (totalRecallN > 0) {
    print('  ──────────────────────  ──────  ──────  ────')
    print(`  ${'TOTAL'.padEnd(24)} ${(totalRecallHits / totalRecallN * 100).toFixed(1).padStart(5)}%  ${(totalMRR / totalRecallN).toFixed(3).padStart(6)}  ${String(totalRecallN).padStart(4)}`)
  }

  print()
  print('═══════════════════════════════════════════════════════════')
  print('  Layer 2: MC Accuracy (10 选 1)')
  print('═══════════════════════════════════════════════════════════')
  print()
  print('  Type                    Acc      N')
  print('  ──────────────────────  ──────  ────')
  let totalMC = 0, totalMCCorrect = 0
  for (const type of typeOrder) {
    const s = typeStats[type]
    if (!s || s.mcTotal === 0) continue
    const acc = (s.mcCorrect / s.mcTotal * 100).toFixed(1)
    print(`  ${type.padEnd(24)} ${acc.padStart(5)}%  ${String(s.mcTotal).padStart(4)}`)
    totalMC += s.mcTotal
    totalMCCorrect += s.mcCorrect
  }
  if (totalMC > 0) {
    print('  ──────────────────────  ──────  ────')
    print(`  ${'TOTAL'.padEnd(24)} ${(totalMCCorrect / totalMC * 100).toFixed(1).padStart(5)}%  ${String(totalMC).padStart(4)}`)
  }

  print()
  print(`  Random baseline: 10.0%`)
  print(`  Time: ${elapsed.toFixed(1)}s (${(questions.length / elapsed).toFixed(0)} q/s)`)
  print()
}

run()
