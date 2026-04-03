/**
 * benchmark-locomo.ts — LOCOMO-MC10 基准测试
 *
 * 两层测试：
 *   Layer 1: 召回质量（Hit@K, MRR）— 测 NAM 引擎本身
 *   Layer 2: 端到端准确率（10 选 1）— 测 NAM + 答案选择
 *
 * 用法: npx tsx cc-soul/benchmark-locomo.ts [--conv N] [--type TYPE] [--top-k K] [--verbose] [--limit N]
 *       npx tsx cc-soul/benchmark-locomo.ts --recall-only [--conv N] [--type TYPE] [--top-k K]
 *       npx tsx cc-soul/benchmark-locomo.ts --llm [--conv N] [--limit 200]
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import type { Memory } from './types.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const require = createRequire(import.meta.url)
;(globalThis as any).require = require

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
  let recallOnly = false, llm = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--conv' && args[i + 1]) conv = parseInt(args[++i])
    if (args[i] === '--type' && args[i + 1]) type = args[++i]
    if (args[i] === '--top-k' && args[i + 1]) topK = parseInt(args[++i])
    if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[++i])
    if (args[i] === '--verbose') verbose = true
    if (args[i] === '--recall-only') recallOnly = true
    if (args[i] === '--llm') llm = true
  }
  return { conv, type, topK, verbose, limit, recallOnly, llm }
}

// ═══════════════════════════════════════════════════════════════
// LLM ANSWER SELECTION (Kimi k2.5)
// ═══════════════════════════════════════════════════════════════

function loadMoonshotKey(): string {
  // 支持目录或文件两种 credentials 格式
  let credPath = join(process.env.HOME || '~', '.openclaw', 'credentials')
  if (!existsSync(credPath) || require('fs').statSync(credPath).isDirectory()) {
    credPath = join(process.env.HOME || '~', '.openclaw', 'credentials.txt')
  }
  if (!existsSync(credPath)) throw new Error(`Credentials not found`)
  const lines = readFileSync(credPath, 'utf-8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('moonshot:')) {
      return trimmed.slice('moonshot:'.length).trim()
    }
  }
  throw new Error('moonshot: key not found in credentials')
}

async function selectAnswerWithLLM(
  recalled: Memory[],
  question: string,
  choices: string[],
  apiKey: string,
): Promise<{ choiceIndex: number; raw: string }> {
  const context = recalled.map(m => m.content).join('\n')
  const letters = 'ABCDEFGHIJ'
  const choiceBlock = choices.map((c, i) => `${letters[i]}. ${c}`).join('\n')

  const prompt = `Based on the following memory context, answer the question by selecting the best choice.
If the context doesn't contain enough information, select "Not answerable" if available.

Context:
${context}

Question: ${question}

Choices:
${choiceBlock}

Reply with ONLY the letter (A-J). Nothing else.`

  const resp = await fetch('https://api.moonshot.cn/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'kimi-k2.5',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 4,
    }),
  })

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Kimi API ${resp.status}: ${body.slice(0, 200)}`)
  }

  const json = await resp.json() as any
  const raw = (json.choices?.[0]?.message?.content || '').trim()
  const letter = raw.charAt(0).toUpperCase()
  const idx = letters.indexOf(letter)
  return { choiceIndex: idx >= 0 ? idx : -1, raw }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function run() {
  const opts = parseArgs()
  const mode = opts.recallOnly ? 'recall-only' : opts.llm ? 'llm' : 'default'

  print('═══════════════════════════════════════════════════════════')
  print('  cc-soul NAM × LOCOMO-MC10 Benchmark')
  print('═══════════════════════════════════════════════════════════')
  print(`  mode: ${mode}  top-K: ${opts.topK}  conv: ${opts.conv ?? 'all'}  type: ${opts.type ?? 'all'}  limit: ${opts.limit || 'none'}`)
  print()

  // Pre-load LLM key if needed
  let apiKey = ''
  if (opts.llm) {
    try {
      apiKey = loadMoonshotKey()
      print('  Kimi k2.5 API key loaded')
    } catch (e: any) {
      print(`  ERROR: ${e.message}`)
      return
    }
  }

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

  // Trackers — extended for recall-only Hit@1/3/5/10
  const typeStats: Record<string, {
    recallTotal: number,
    hitAt1: number, hitAt3: number, hitAt5: number, hitAt10: number,
    mrrSum: number,
    mcCorrect: number, mcTotal: number,       // Layer 2 (string-match)
    llmCorrect: number, llmTotal: number,     // Layer 2 (LLM)
    llmFail: number,                          // LLM parse failures
  }> = {}
  function getStat(type: string) {
    if (!typeStats[type]) typeStats[type] = {
      recallTotal: 0, hitAt1: 0, hitAt3: 0, hitAt5: 0, hitAt10: 0, mrrSum: 0,
      mcCorrect: 0, mcTotal: 0, llmCorrect: 0, llmTotal: 0, llmFail: 0,
    }
    return typeStats[type]
  }

  const startTime = Date.now()
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

    // Layer 1: Recall quality (always computed for non-adversarial)
    const isAdversarial = /not answerable|cannot be answered|unanswerable/i.test(q.answer)
    if (!isAdversarial) {
      stat.recallTotal++
      const { hit, rank } = answerInRecalled(recalled, q.answer)
      if (hit) {
        if (rank <= 1) stat.hitAt1++
        if (rank <= 3) stat.hitAt3++
        if (rank <= 5) stat.hitAt5++
        if (rank <= 10) stat.hitAt10++
        stat.mrrSum += 1 / rank
      }
    }

    // Layer 2: skip for recall-only
    if (!opts.recallOnly) {
      // String-match answer selection (always run)
      stat.mcTotal++
      const { choiceIndex, confidence } = selectAnswer(recalled, q.choices)
      if (choiceIndex === q.correct_choice_index) stat.mcCorrect++

      // LLM answer selection
      if (opts.llm) {
        stat.llmTotal++
        try {
          const { choiceIndex: llmIdx, raw } = await selectAnswerWithLLM(recalled, q.question, q.choices, apiKey)
          if (llmIdx >= 0 && llmIdx === q.correct_choice_index) stat.llmCorrect++
          if (llmIdx < 0) stat.llmFail++

          if (opts.verbose) {
            const smOk = choiceIndex === q.correct_choice_index
            const llmOk = llmIdx === q.correct_choice_index
            suppressLogs = false
            print(`  SM:${smOk ? 'O' : 'X'} LLM:${llmOk ? 'O' : 'X'} [${q.question_type.padEnd(20)}] ${q.question.slice(0, 50)}`)
            if (!llmOk) {
              print(`     want: ${q.choices[q.correct_choice_index]?.slice(0, 50)}`)
              print(`     llm:  ${llmIdx >= 0 ? q.choices[llmIdx]?.slice(0, 50) : `parse fail: ${raw}`}`)
            }
            suppressLogs = true
          }

          await sleep(500)  // rate limit
        } catch (e: any) {
          stat.llmFail++
          suppressLogs = false
          print(`  LLM error: ${e.message.slice(0, 100)}`)
          suppressLogs = true
          await sleep(1000)  // back off on error
        }
      } else if (opts.verbose) {
        // Default verbose (no LLM)
        const mcOk = choiceIndex === q.correct_choice_index
        suppressLogs = false
        print(`  ${mcOk ? 'OK' : 'XX'} [${q.question_type.padEnd(20)}] ${q.question.slice(0, 55)}`)
        if (!mcOk) {
          print(`     want: ${q.answer.slice(0, 50)}`)
          print(`     got:  ${q.choices[choiceIndex]?.slice(0, 50)} (conf=${confidence.toFixed(2)})`)
        }
        suppressLogs = true
      }
    } else if (opts.verbose && !isAdversarial) {
      // recall-only verbose
      const { hit, rank } = answerInRecalled(recalled, q.answer)
      suppressLogs = false
      print(`  ${hit ? 'HIT' : 'MISS'}@${rank > 0 ? rank : '-'} [${q.question_type.padEnd(20)}] ${q.question.slice(0, 55)}`)
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
  const typeOrder = ['single_hop', 'multi_hop', 'temporal_reasoning', 'open_domain', 'adversarial']

  // ═══════════════════════════════════════════════════════════════
  // RESULTS: RECALL
  // ═══════════════════════════════════════════════════════════════

  print()
  print('═══════════════════════════════════════════════════════════')
  print(`  Layer 1: Recall Quality${opts.recallOnly ? ' (recall-only mode)' : ''}`)
  print('═══════════════════════════════════════════════════════════')
  print()

  if (opts.recallOnly) {
    // Detailed Hit@K breakdown
    print('  Type                    Hit@1   Hit@3   Hit@5  Hit@10    MRR     N')
    print('  ──────────────────────  ──────  ──────  ──────  ──────  ──────  ────')
    let tN = 0, t1 = 0, t3 = 0, t5 = 0, t10 = 0, tMRR = 0
    for (const type of typeOrder) {
      const s = typeStats[type]
      if (!s || s.recallTotal === 0) continue
      const n = s.recallTotal
      const h1 = (s.hitAt1 / n * 100).toFixed(1)
      const h3 = (s.hitAt3 / n * 100).toFixed(1)
      const h5 = (s.hitAt5 / n * 100).toFixed(1)
      const h10 = (s.hitAt10 / n * 100).toFixed(1)
      const mrr = (s.mrrSum / n).toFixed(3)
      print(`  ${type.padEnd(24)} ${h1.padStart(5)}%  ${h3.padStart(5)}%  ${h5.padStart(5)}%  ${h10.padStart(5)}%  ${mrr.padStart(6)}  ${String(n).padStart(4)}`)
      tN += n; t1 += s.hitAt1; t3 += s.hitAt3; t5 += s.hitAt5; t10 += s.hitAt10; tMRR += s.mrrSum
    }
    if (tN > 0) {
      print('  ──────────────────────  ──────  ──────  ──────  ──────  ──────  ────')
      print(`  ${'TOTAL'.padEnd(24)} ${(t1/tN*100).toFixed(1).padStart(5)}%  ${(t3/tN*100).toFixed(1).padStart(5)}%  ${(t5/tN*100).toFixed(1).padStart(5)}%  ${(t10/tN*100).toFixed(1).padStart(5)}%  ${(tMRR/tN).toFixed(3).padStart(6)}  ${String(tN).padStart(4)}`)
    }
  } else {
    // Compact Hit@K (original style, but now with Hit@10 = hitAt10)
    print('  Type                    Hit@K    MRR     N')
    print('  ──────────────────────  ──────  ──────  ────')
    let totalRecallHits = 0, totalRecallN = 0, totalMRR = 0
    for (const type of typeOrder) {
      const s = typeStats[type]
      if (!s || s.recallTotal === 0) continue
      const hitRate = (s.hitAt10 / s.recallTotal * 100).toFixed(1)
      const mrr = (s.mrrSum / s.recallTotal).toFixed(3)
      print(`  ${type.padEnd(24)} ${hitRate.padStart(5)}%  ${mrr.padStart(6)}  ${String(s.recallTotal).padStart(4)}`)
      totalRecallHits += s.hitAt10
      totalRecallN += s.recallTotal
      totalMRR += s.mrrSum
    }
    if (totalRecallN > 0) {
      print('  ──────────────────────  ──────  ──────  ────')
      print(`  ${'TOTAL'.padEnd(24)} ${(totalRecallHits / totalRecallN * 100).toFixed(1).padStart(5)}%  ${(totalMRR / totalRecallN).toFixed(3).padStart(6)}  ${String(totalRecallN).padStart(4)}`)
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // RESULTS: MC ACCURACY (skip for recall-only)
  // ═══════════════════════════════════════════════════════════════

  if (!opts.recallOnly) {
    print()
    print('═══════════════════════════════════════════════════════════')
    print('  Layer 2: MC Accuracy (10 选 1)')
    print('═══════════════════════════════════════════════════════════')
    print()

    if (opts.llm) {
      // Side-by-side: string-match vs LLM
      print('  Type                    SM Acc   LLM Acc    N   (fail)')
      print('  ──────────────────────  ──────  ────────  ────  ──────')
      let tMC = 0, tSM = 0, tLLM = 0, tFail = 0
      for (const type of typeOrder) {
        const s = typeStats[type]
        if (!s || s.mcTotal === 0) continue
        const smAcc = (s.mcCorrect / s.mcTotal * 100).toFixed(1)
        const llmAcc = s.llmTotal > 0 ? (s.llmCorrect / s.llmTotal * 100).toFixed(1) : ' N/A'
        print(`  ${type.padEnd(24)} ${smAcc.padStart(5)}%  ${llmAcc.padStart(6)}%  ${String(s.mcTotal).padStart(4)}  ${String(s.llmFail).padStart(5)}`)
        tMC += s.mcTotal; tSM += s.mcCorrect; tLLM += s.llmCorrect; tFail += s.llmFail
      }
      if (tMC > 0) {
        print('  ──────────────────────  ──────  ────────  ────  ──────')
        print(`  ${'TOTAL'.padEnd(24)} ${(tSM/tMC*100).toFixed(1).padStart(5)}%  ${(tLLM/tMC*100).toFixed(1).padStart(6)}%  ${String(tMC).padStart(4)}  ${String(tFail).padStart(5)}`)
      }
    } else {
      // Original string-match only
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
    }
  }

  print()
  print(`  Random baseline: 10.0%`)
  print(`  Time: ${elapsed.toFixed(1)}s (${(questions.length / elapsed).toFixed(0)} q/s)`)
  print()
}

run()
