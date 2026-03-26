import type { SoulModule } from './brain.ts'

/**
 * quality.ts — Quality System + Eval Metrics
 *
 * Ported from handler.ts lines 572-665 (scoring/self-check) + 1823-1881 (eval).
 */

import type { EvalMetrics } from './types.ts'
import { DATA_DIR, EVAL_PATH, loadJson, debouncedSave } from './persistence.ts'
import { spawnCLI } from './cli.ts'
import { body } from './body.ts'
import { extractJSON } from './utils.ts'
import { resolve } from 'path'

// ── Quality Features & Logistic Regression Weights ──

const WEIGHTS_PATH = resolve(DATA_DIR, 'quality_weights.json')

interface QualityFeatures {
  mediumLength: number     // 1 if answer > 50 chars
  longLength: number       // 1 if answer > 200 chars
  tooLong: number          // 1 if answer > 1000 && question < 30
  tooShort: number         // 1 if answer < 10 && question > 50
  hasReasoning: number     // 1 if reasoning markers present
  hasCode: number          // 1 if ``` present
  hasList: number          // 1 if bullet/numbered list
  hasUncertainty: number   // 1 if honest uncertainty markers
  hasRefusal: number       // 1 if refusal patterns
  relevance: number        // 0-1 word overlap ratio
  aiExposure: number       // 1 if AI identity leaked
  lengthRatio: number      // answer/question length ratio, capped
}

const FEATURE_KEYS: (keyof QualityFeatures)[] = [
  'mediumLength', 'longLength', 'tooLong', 'tooShort',
  'hasReasoning', 'hasCode', 'hasList', 'hasUncertainty',
  'hasRefusal', 'relevance', 'aiExposure', 'lengthRatio'
]

function extractFeatures(question: string, answer: string): QualityFeatures {
  const qLen = question.length, aLen = answer.length
  const qWords = new Set((question.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase()))
  const aWords = (answer.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase())
  const overlap = qWords.size > 0 ? aWords.filter(w => qWords.has(w)).length / Math.max(1, qWords.size) : 0

  return {
    mediumLength: aLen > 50 ? 1 : 0,
    longLength: aLen > 200 ? 1 : 0,
    tooLong: (aLen > 1000 && qLen < 30) ? 1 : 0,
    tooShort: (aLen < 10 && qLen > 50) ? 1 : 0,
    hasReasoning: ['因为', '所以', '首先', '其次', '原因', '本质上', 'because', 'therefore'].some(m => answer.includes(m)) ? 1 : 0,
    hasCode: answer.includes('```') ? 1 : 0,
    hasList: /^[-*•]\s/m.test(answer) || /^\d+\.\s/m.test(answer) ? 1 : 0,
    hasUncertainty: ['不确定', '不太确定', '可能', "I'm not sure"].some(m => answer.includes(m)) ? 1 : 0,
    hasRefusal: ['我不知道', '无法回答', '超出了我的'].some(m => answer.includes(m)) ? 1 : 0,
    relevance: Math.min(1, overlap),
    aiExposure: /作为一个?AI|作为人工智能|作为语言模型|I am an AI/i.test(answer) ? 1 : 0,
    lengthRatio: Math.min(100, aLen / Math.max(1, qLen)),
  }
}

interface QualityWeights {
  bias: number
  weights: Record<string, number>
  learningRate: number
  trainingExamples: number
  gradientSquaredSum: Record<string, number>  // AdaGrad per-weight gradient accumulator
  hardExamples: Array<{ question: string; answer: string; target: number; loss: number }>
}

// Initial weights mirror the previous hardcoded heuristic values
let qw: QualityWeights = {
  bias: -0.225,  // sigmoid(-0.225)≈0.444 → score≈5.0 baseline (no features active)
  weights: {
    mediumLength: 0.5, longLength: 0.5, tooLong: -1.0, tooShort: -1.5,
    hasReasoning: 1.0, hasCode: 0.5, hasList: 0.3, hasUncertainty: 0.3,
    hasRefusal: -1.5, relevance: 1.5, aiExposure: -2.0, lengthRatio: 0,
  },
  learningRate: 0.1,
  trainingExamples: 0,
  gradientSquaredSum: {},
  hardExamples: [],
}

export function loadQualityWeights() {
  qw = loadJson<QualityWeights>(WEIGHTS_PATH, qw)
  if (!qw.gradientSquaredSum) qw.gradientSquaredSum = {}
  if (!qw.hardExamples) qw.hardExamples = []
  console.log(`[cc-soul][quality] loaded weights: ${qw.trainingExamples} training examples`)
}

// ── Eval state (lazy-loaded: DATA_DIR may not exist at module load time) ──

export let evalMetrics: EvalMetrics = {
  totalResponses: 0, avgQuality: 5.0, correctionRate: 0,
  brainHitRate: 0, memoryRecallRate: 0, lastEval: 0,
}
let evalLoaded = false

function ensureEvalLoaded() {
  if (evalLoaded) return
  evalLoaded = true
  evalMetrics = loadJson<EvalMetrics>(EVAL_PATH, evalMetrics)
}

let qualitySum = 0
let qualityCount = 0
let memRecalls = 0
let memMisses = 0

// ── Tracking ──

export function trackQuality(score: number) {
  qualitySum += score
  qualityCount++
}

export function trackMemoryRecall(found: boolean) {
  if (found) memRecalls++; else memMisses++
}

// ── Scoring ──

export function scoreResponse(question: string, answer: string): number {
  const features = extractFeatures(question, answer)

  let logit = qw.bias
  for (const key of FEATURE_KEYS) {
    logit += (qw.weights[key] || 0) * features[key]
  }

  // Map to 1-10 scale via sigmoid
  const sigmoid = 1 / (1 + Math.exp(-logit))
  const score = sigmoid * 9 + 1

  return Math.round(score * 10) / 10
}

/**
 * Update quality weights from user feedback via online SGD.
 * correction → target low score, positive → target high score.
 */
export function updateQualityWeights(question: string, answer: string, feedback: 'positive' | 'correction') {
  const features = extractFeatures(question, answer)
  const target = feedback === 'positive' ? 0.9 : 0.2

  let logit = qw.bias
  for (const key of FEATURE_KEYS) {
    logit += (qw.weights[key] || 0) * features[key]
  }
  const predicted = 1 / (1 + Math.exp(-logit))
  const error = predicted - target
  const loss = Math.abs(error)

  // Record hard examples (high loss) for periodic resampling
  if (loss > 0.3) {
    if (!qw.hardExamples) qw.hardExamples = []
    qw.hardExamples.push({ question: question.slice(0, 200), answer: answer.slice(0, 500), target, loss })
    if (qw.hardExamples.length > 30) {
      // Keep highest loss examples
      qw.hardExamples.sort((a, b) => b.loss - a.loss)
      qw.hardExamples = qw.hardExamples.slice(0, 30)
    }
  }

  // AdaGrad update
  if (!qw.gradientSquaredSum) qw.gradientSquaredSum = {}
  const baseLr = qw.learningRate / Math.sqrt(Math.min(qw.trainingExamples, 1000) + 1)

  // Bias update
  qw.bias = Math.max(-5, Math.min(5, qw.bias - baseLr * error))

  // Per-weight adaptive update
  for (const key of FEATURE_KEYS) {
    const grad = error * features[key]
    qw.gradientSquaredSum[key] = (qw.gradientSquaredSum[key] || 0) + grad * grad
    const adaptiveLr = baseLr / (1 + Math.sqrt(qw.gradientSquaredSum[key]))
    const newW = (qw.weights[key] || 0) - adaptiveLr * grad
    qw.weights[key] = Math.max(-5, Math.min(5, newW))
  }

  // L2 regularization: decay weights toward zero to prevent overfitting
  const l2Lambda = 0.0001  // reduced to avoid double-decay with AdaGrad
  for (const key of FEATURE_KEYS) {
    qw.weights[key] = qw.weights[key] * (1 - l2Lambda)
  }

  qw.trainingExamples++
  debouncedSave(WEIGHTS_PATH, qw)
  console.log(`[cc-soul][quality] weights updated (${feedback}): ${qw.trainingExamples} examples, bias=${qw.bias.toFixed(3)}`)
}

/**
 * Periodically replay hard examples to reinforce learning on difficult cases.
 * Called from heartbeat.
 */
export function resampleHardExamples() {
  if (!qw.hardExamples || qw.hardExamples.length < 3) return

  const samples = qw.hardExamples.slice(0, 3)
  for (const { question, answer, target } of samples) {
    const features = extractFeatures(question, answer)
    let logit = qw.bias
    for (const key of FEATURE_KEYS) {
      logit += (qw.weights[key] || 0) * features[key]
    }
    const predicted = 1 / (1 + Math.exp(-logit))
    const error = predicted - target

    if (!qw.gradientSquaredSum) qw.gradientSquaredSum = {}
    const lr = 0.01 // small fixed LR for replay

    qw.bias = Math.max(-5, Math.min(5, qw.bias - lr * error))
    for (const key of FEATURE_KEYS) {
      const grad = error * features[key]
      qw.gradientSquaredSum[key] = (qw.gradientSquaredSum[key] || 0) + grad * grad
      const adaptiveLr = lr / (1 + Math.sqrt(qw.gradientSquaredSum[key]))
      const newW = (qw.weights[key] || 0) - adaptiveLr * grad
      qw.weights[key] = Math.max(-5, Math.min(5, newW))
    }
  }

  // L2 regularization: decay weights toward zero to prevent overfitting
  const l2Lambda = 0.0001  // reduced to avoid double-decay with AdaGrad
  for (const key of FEATURE_KEYS) {
    qw.weights[key] = qw.weights[key] * (1 - l2Lambda)
  }

  debouncedSave(WEIGHTS_PATH, qw)
  console.log(`[cc-soul][quality] replayed ${samples.length} hard examples`)
}

// ── Self-check (sync fallback) ──

export function selfCheckSync(question: string, answer: string): string | null {
  if (answer.length < 5) return '回答太短，可能没有实质内容'
  if (answer.length > 5000 && question.length < 30) return '回答过长，短问题不需要长篇大论'
  if (answer.includes('作为一个AI') || answer.includes('作为语言模型')) return '暴露了AI身份，违反人设'
  return null
}

// ── Self-check (CLI-powered async) ──

function logIssue(issue: string, context: string) {
  console.log(`[cc-soul][quality] ${issue} | ctx: ${context.slice(0, 80)}`)
}

export function selfCheckWithCLI(question: string, answer: string) {
  if (answer.length < 20 || question.length < 5) return

  const prompt = `问题: "${question.slice(0, 200)}"\n回答: "${answer.slice(0, 500)}"\n\n评价这个回答: 1.是否回答了问题 2.有没有编造 3.是否啰嗦 4.打分1-10。JSON格式: {"score":N,"issues":["问题"]}`

  spawnCLI(prompt, (output) => {
    try {
      const result = extractJSON(output)
      if (result) {
        const score = result.score || 5
        trackQuality(score)
        if (result.issues?.length) {
          for (const issue of result.issues) {
            logIssue(issue, question)
          }
          body.anomaly = Math.min(1.0, body.anomaly + 0.1)
        }
        // Low CLI score = trigger alertness
        if (score <= 4) {
          body.alertness = Math.min(1.0, body.alertness + 0.15)
          console.log(`[cc-soul][quality] CLI self-check low score: ${score}/10`)
        }
      }
    } catch (e: any) { console.error(`[cc-soul][quality] parse error: ${e.message}`) }
  })
}

// ── Eval ──

export function computeEval(totalMessages: number, corrections: number, resetWindow = false): EvalMetrics {
  ensureEvalLoaded()
  evalMetrics = {
    totalResponses: totalMessages,
    avgQuality: qualityCount > 0 ? Math.round(qualitySum / qualityCount * 10) / 10 : 5.0,
    correctionRate: totalMessages > 0 ? Math.round(corrections / totalMessages * 1000) / 10 : 0,
    brainHitRate: 0,
    memoryRecallRate: (memRecalls + memMisses) > 0
      ? Math.round(memRecalls / (memRecalls + memMisses) * 100) : 0,
    lastEval: Date.now(),
  }
  debouncedSave(EVAL_PATH, evalMetrics)

  // Only reset window counters when explicitly requested (e.g. heartbeat/session end)
  if (resetWindow) {
    qualitySum = 0
    qualityCount = 0
    memRecalls = 0
    memMisses = 0
  }

  return evalMetrics
}

export function getEvalSummary(totalMessages: number, corrections: number): string {
  ensureEvalLoaded()
  const e = computeEval(totalMessages, corrections)
  return `评分:${e.avgQuality}/10 纠正率:${e.correctionRate}% 记忆召回:${e.memoryRecallRate}%`
}

export const qualityModule: SoulModule = {
  id: 'quality',
  name: '质量评估',
  dependencies: ['body'],
  priority: 60,
  init() { loadQualityWeights() },
}
