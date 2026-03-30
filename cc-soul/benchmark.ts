/**
 * benchmark.ts — 记忆系统质量评测基准
 *
 * 四维度量化评测：精确率(40%) + 召回率(30%) + 事实提取(15%) + 行为预测(15%)
 * 纯本地评测，不依赖外部 LLM。
 *
 * Usage: npx tsx cc-soul/benchmark.ts
 */

import type { Memory, StructuredFact } from './types.ts'
import {
  memoryState, scopeIndex, addMemory, rebuildScopeIndex,
} from './memory.ts'
import { recallWithScores, rebuildRecallIndex, invalidateIDF } from './memory-recall.ts'
import { extractFacts, addFacts, queryFacts, getAllFacts } from './fact-store.ts'
import { getBehaviorPrediction } from './behavior-prediction.ts'

// ══════════════════════════════════════════════════════════════════════════════
// BENCHMARK RUNNER
// ══════════════════════════════════════════════════════════════════════════════

interface DimensionResult {
  name: string
  score: number      // 0-100
  weight: number     // 0-1
  details: string[]  // per-case results
}

// ══════════════════════════════════════════════════════════════════════════════
// SANDBOX — isolate benchmark from production data
// ══════════════════════════════════════════════════════════════════════════════

let _savedMemories: Memory[] = []
let _savedScopeIndex: Map<string, Memory[]> = new Map()
let _savedFacts: StructuredFact[] = []

function enterSandbox() {
  // Snapshot production state
  _savedMemories = [...memoryState.memories]
  _savedScopeIndex = new Map(scopeIndex)
  _savedFacts = [...getAllFacts()]

  // Clear for benchmark
  memoryState.memories.length = 0
  scopeIndex.clear()
  rebuildRecallIndex([])
  invalidateIDF()
}

function exitSandbox() {
  // Restore production state
  memoryState.memories.length = 0
  memoryState.memories.push(..._savedMemories)
  scopeIndex.clear()
  for (const [k, v] of _savedScopeIndex) scopeIndex.set(k, v)
  rebuildRecallIndex(memoryState.memories)
  invalidateIDF()
}

/** Direct-inject memory bypassing addMemory's lazy-module & dedup logic */
function injectMemory(content: string, scope: string, opts?: Partial<Memory>) {
  const mem: Memory = {
    content, scope, ts: Date.now() - Math.random() * 86400_000,
    confidence: 0.7, tier: 'short_term', recallCount: 0,
    lastAccessed: Date.now(), source: 'user_said',
    ...opts,
  }
  memoryState.memories.push(mem)
  const arr = scopeIndex.get(scope) || []
  arr.push(mem)
  scopeIndex.set(scope, arr)
}

/** Rebuild indices after injecting all memories */
function finishInjection() {
  rebuildRecallIndex(memoryState.memories)
  invalidateIDF()
}

// ══════════════════════════════════════════════════════════════════════════════
// DIMENSION 1: Precision (40%)
// ══════════════════════════════════════════════════════════════════════════════

function benchPrecision(): DimensionResult {
  const details: string[] = []

  // 10 known memories with clear topics
  const memories = [
    { content: '用户喜欢用Python写自动化脚本', scope: 'preference', tags: ['python', '自动化', '脚本'] },
    { content: '用户在北京朝阳区工作', scope: 'fact', tags: ['北京', '朝阳', '工作'] },
    { content: '用户习惯深夜coding，效率最高', scope: 'preference', tags: ['深夜', 'coding', '效率'] },
    { content: '用户不喜欢Java的冗长语法', scope: 'preference', tags: ['java', '语法', '不喜欢'] },
    { content: '用户养了一只橘猫叫小橘', scope: 'fact', tags: ['橘猫', '小橘', '宠物'] },
    { content: '用户的主力开发机是MacBook Pro M3', scope: 'fact', tags: ['macbook', 'pro', 'm3', '开发机'] },
    { content: '用户喜欢喝美式咖啡，不加糖', scope: 'preference', tags: ['咖啡', '美式', '不加糖'] },
    { content: '用户正在研究iOS逆向工程', scope: 'fact', tags: ['ios', '逆向', '研究'] },
    { content: '用户觉得Vim比VSCode效率高', scope: 'preference', tags: ['vim', 'vscode', '效率'] },
    { content: '用户上周末去了颐和园散步', scope: 'event', tags: ['颐和园', '散步', '周末'] },
  ]

  for (const m of memories) {
    injectMemory(m.content, m.scope, { tags: m.tags })
  }
  finishInjection()

  // Relevant queries — should match
  const relevantQueries = [
    { query: 'Python自动化', expectedContent: '用户喜欢用Python写自动化脚本' },
    { query: '在哪里工作', expectedContent: '用户在北京朝阳区工作' },
    { query: '深夜写代码', expectedContent: '用户习惯深夜coding，效率最高' },
    { query: 'iOS逆向', expectedContent: '用户正在研究iOS逆向工程' },
    { query: '猫宠物', expectedContent: '用户养了一只橘猫叫小橘' },
  ]

  // Irrelevant queries — should NOT match well
  const irrelevantQueries = [
    '量子力学和弦理论的关系',
    '今天股票行情怎么样',
    '烤鸡翅的做法',
    '火星探测器着陆',
    '莎士比亚戏剧作品赏析',
  ]

  let truePositives = 0
  let falsePositives = 0
  let totalReturned = 0

  // Test relevant queries
  for (const { query, expectedContent } of relevantQueries) {
    const results = recallWithScores(query, 3)
    totalReturned += results.length
    const hit = results.some(r => r.content === expectedContent)
    if (hit) {
      truePositives++
      details.push(`  [OK] "${query}" → 正确召回`)
    } else {
      details.push(`  [MISS] "${query}" → 未找到预期记忆 (返回${results.length}条)`)
    }
  }

  // Test irrelevant queries
  for (const query of irrelevantQueries) {
    const results = recallWithScores(query, 3)
    if (results.length > 0) {
      falsePositives += results.length
      details.push(`  [FP] "${query}" → 误匹配${results.length}条`)
    } else {
      details.push(`  [OK] "${query}" → 无误匹配`)
    }
    totalReturned += results.length
  }

  // Precision = TP / (TP + FP)
  const precision = totalReturned > 0
    ? truePositives / (truePositives + falsePositives) * 100
    : 0

  details.unshift(`TP=${truePositives}, FP=${falsePositives}, Total=${totalReturned}`)

  return { name: '记忆精确率 (Precision)', score: Math.round(precision), weight: 0.4, details }
}

// ══════════════════════════════════════════════════════════════════════════════
// DIMENSION 2: Recall (30%)
// ══════════════════════════════════════════════════════════════════════════════

function benchRecall(): DimensionResult {
  const details: string[] = []

  // Clear and inject fresh set
  memoryState.memories.length = 0
  scopeIndex.clear()

  // 10 memories across different domains
  const memories = [
    { content: '用户精通ARM64汇编语言', scope: 'fact', tags: ['arm64', '汇编', '精通'] },
    { content: '用户每天跑步5公里锻炼身体', scope: 'fact', tags: ['跑步', '锻炼', '5公里'] },
    { content: '用户最近在看《三体》小说', scope: 'event', tags: ['三体', '小说', '阅读'] },
    { content: '用户习惯用飞书沟通工作', scope: 'preference', tags: ['飞书', '沟通', '工作'] },
    { content: '用户的服务器部署在阿里云ECS', scope: 'fact', tags: ['阿里云', 'ecs', '服务器'] },
    { content: '用户对TypeScript的类型系统很熟悉', scope: 'fact', tags: ['typescript', '类型', '熟悉'] },
    { content: '用户周末喜欢打羽毛球', scope: 'preference', tags: ['羽毛球', '周末', '运动'] },
    { content: '用户在维护一个48K行的Python项目', scope: 'fact', tags: ['python', '项目', '48k', '维护'] },
    { content: '用户不喜欢早起，属于夜猫子', scope: 'preference', tags: ['夜猫子', '早起', '不喜欢'] },
    { content: '用户使用Frida做iOS应用的hook调试', scope: 'fact', tags: ['frida', 'ios', 'hook', '调试'] },
  ]

  for (const m of memories) {
    injectMemory(m.content, m.scope, { tags: m.tags })
  }
  finishInjection()

  // Each query targets one specific memory
  const queries = [
    { query: 'ARM64汇编', target: '用户精通ARM64汇编语言' },
    { query: '跑步锻炼', target: '用户每天跑步5公里锻炼身体' },
    { query: '三体小说', target: '用户最近在看《三体》小说' },
    { query: '飞书工作沟通', target: '用户习惯用飞书沟通工作' },
    { query: '阿里云服务器', target: '用户的服务器部署在阿里云ECS' },
    { query: 'TypeScript类型', target: '用户对TypeScript的类型系统很熟悉' },
    { query: '羽毛球运动', target: '用户周末喜欢打羽毛球' },
    { query: 'Python大项目', target: '用户在维护一个48K行的Python项目' },
    { query: '夜猫子晚睡', target: '用户不喜欢早起，属于夜猫子' },
    { query: 'Frida hook', target: '用户使用Frida做iOS应用的hook调试' },
  ]

  let found = 0
  for (const { query, target } of queries) {
    const results = recallWithScores(query, 5)
    const hit = results.some(r => r.content === target)
    if (hit) {
      found++
      details.push(`  [OK] "${query}" → 召回成功`)
    } else {
      const returned = results.map(r => r.content.slice(0, 30)).join(' | ')
      details.push(`  [MISS] "${query}" → 未召回 (实际返回: ${returned || '空'})`)
    }
  }

  const recallScore = found / queries.length * 100

  details.unshift(`召回: ${found}/${queries.length}`)

  return { name: '记忆召回率 (Recall)', score: Math.round(recallScore), weight: 0.3, details }
}

// ══════════════════════════════════════════════════════════════════════════════
// DIMENSION 3: Fact Extraction (15%)
// ══════════════════════════════════════════════════════════════════════════════

function benchFactExtraction(): DimensionResult {
  const details: string[] = []

  const testCases: { input: string; expected: { subject: string; predicate: string; objectContains: string } }[] = [
    { input: '我喜欢Python', expected: { subject: 'user', predicate: 'likes', objectContains: 'Python' } },
    { input: '我在北京工作', expected: { subject: 'user', predicate: 'works_at', objectContains: '北京' } },
    { input: '我讨厌写文档', expected: { subject: 'user', predicate: 'dislikes', objectContains: '写文档' } },
    { input: '我住在上海浦东', expected: { subject: 'user', predicate: 'lives_in', objectContains: '上海' } },
    { input: '我用Vim写代码', expected: { subject: 'user', predicate: 'uses', objectContains: 'Vim' } },
    { input: '我喜欢喝咖啡', expected: { subject: 'user', predicate: 'likes', objectContains: '咖啡' } },
    { input: '我不喜欢加班', expected: { subject: 'user', predicate: 'dislikes', objectContains: '加班' } },
    { input: '我在用Docker部署', expected: { subject: 'user', predicate: 'uses', objectContains: 'Docker' } },
    { input: '我是做后端开发的', expected: { subject: 'user', predicate: 'occupation', objectContains: '后端' } },
    { input: 'Rust比C++好', expected: { subject: 'user', predicate: 'prefers', objectContains: 'Rust' } },
  ]

  let correct = 0
  for (const { input, expected } of testCases) {
    const facts = extractFacts(input, 'user_said')
    const match = facts.some(f =>
      f.subject === expected.subject &&
      f.predicate === expected.predicate &&
      f.object.includes(expected.objectContains)
    )
    if (match) {
      correct++
      details.push(`  [OK] "${input}" → ${expected.predicate}(${expected.objectContains})`)
    } else {
      const got = facts.length > 0
        ? facts.map(f => `${f.predicate}(${f.object})`).join(', ')
        : '无提取结果'
      details.push(`  [MISS] "${input}" → 期望 ${expected.predicate}(${expected.objectContains}), 实际: ${got}`)
    }
  }

  const score = correct / testCases.length * 100
  details.unshift(`正确提取: ${correct}/${testCases.length}`)

  return { name: '事实提取准确率 (Fact Extraction)', score: Math.round(score), weight: 0.15, details }
}

// ══════════════════════════════════════════════════════════════════════════════
// DIMENSION 4: Behavior Prediction (15%)
// ══════════════════════════════════════════════════════════════════════════════

function benchBehavior(): DimensionResult {
  const details: string[] = []

  const now = Date.now()
  const recentTs = () => now - Math.random() * 2 * 86400_000 // within 2 days

  // Scenario configs: each sets up a pattern of memories + a test message
  const scenarios: {
    name: string
    memories: Memory[]
    userMsg: string
    expectPattern: RegExp // expected substring in the returned hint
  }[] = [
    {
      name: '深夜+技术话题聚焦',
      memories: [
        { content: '用户在研究ARM64指令集', scope: 'fact', ts: recentTs(), confidence: 0.7, source: 'user_said' },
        { content: '用户分析了Mach-O的load commands', scope: 'fact', ts: recentTs(), confidence: 0.7, source: 'user_said' },
        { content: '用户用IDA分析了一个二进制', scope: 'fact', ts: recentTs(), confidence: 0.7, source: 'user_said' },
        { content: '用户在调试dyld加载流程', scope: 'fact', ts: recentTs(), confidence: 0.7, source: 'user_said' },
        { content: '用户研究了ObjC runtime消息分发', scope: 'fact', ts: recentTs(), confidence: 0.7, source: 'user_said' },
      ],
      userMsg: '这个函数的反汇编结果怎么看',
      expectPattern: /fact|话题|记忆|领域/,
    },
    {
      name: '情绪低落模式',
      memories: [
        { content: '今天被甲方骂了', scope: 'event', ts: recentTs(), confidence: 0.7, emotion: 'painful', source: 'user_said' },
        { content: '项目延期了，压力好大', scope: 'event', ts: recentTs(), confidence: 0.7, emotion: 'painful', source: 'user_said' },
        { content: '同事离职了很难过', scope: 'event', ts: recentTs(), confidence: 0.7, emotion: 'painful', source: 'user_said' },
        { content: '加班到半夜好累', scope: 'event', ts: recentTs(), confidence: 0.7, emotion: 'painful', source: 'user_said' },
        { content: '又要改需求了', scope: 'event', ts: recentTs(), confidence: 0.7, emotion: 'neutral', source: 'user_said' },
      ],
      userMsg: '好烦啊',
      expectPattern: /情绪|负面|支持|温和/,
    },
    {
      name: '编程领域深化',
      memories: [
        { content: '用户在学Swift并发编程', scope: 'fact', ts: recentTs(), confidence: 0.7, source: 'user_said' },
        { content: '用户研究了Swift的actor模型', scope: 'fact', ts: recentTs(), confidence: 0.7, source: 'user_said' },
        { content: '用户试了Swift的async/await', scope: 'fact', ts: recentTs(), confidence: 0.7, source: 'user_said' },
        { content: '用户在写SwiftUI界面', scope: 'fact', ts: recentTs(), confidence: 0.7, source: 'user_said' },
        { content: '用户用Xcode调试了一个崩溃', scope: 'fact', ts: recentTs(), confidence: 0.7, source: 'user_said' },
      ],
      userMsg: 'Swift的Sendable协议怎么用',
      expectPattern: /swift|领域|积累|深入/i,
    },
    {
      name: 'preference话题聚焦',
      memories: [
        { content: '用户偏好暗色主题', scope: 'preference', ts: recentTs(), confidence: 0.7, source: 'user_said' },
        { content: '用户喜欢简洁的UI设计', scope: 'preference', ts: recentTs(), confidence: 0.7, source: 'user_said' },
        { content: '用户不喜欢过多动画', scope: 'preference', ts: recentTs(), confidence: 0.7, source: 'user_said' },
        { content: '用户倾向用原生组件', scope: 'preference', ts: recentTs(), confidence: 0.7, source: 'user_said' },
        { content: '用户讨厌弹窗广告', scope: 'preference', ts: recentTs(), confidence: 0.7, source: 'user_said' },
      ],
      userMsg: '有没有好看的主题推荐',
      expectPattern: /preference|话题|记忆|偏好/,
    },
    {
      name: '数据不足时应返回null',
      memories: [
        { content: '用户说了一句话', scope: 'event', ts: now - 10 * 86400_000, confidence: 0.7, source: 'user_said' },
        { content: '另一句话', scope: 'event', ts: now - 10 * 86400_000, confidence: 0.7, source: 'user_said' },
      ],
      userMsg: '你好',
      expectPattern: /^$/,  // expect null → empty match
    },
  ]

  let correct = 0
  for (const s of scenarios) {
    const result = getBehaviorPrediction(s.userMsg, s.memories)

    if (s.expectPattern.source === '^$') {
      // Expect null
      if (result === null) {
        correct++
        details.push(`  [OK] "${s.name}" → 正确返回 null`)
      } else {
        details.push(`  [MISS] "${s.name}" → 期望 null, 实际: "${result?.slice(0, 60)}"`)
      }
    } else {
      if (result && s.expectPattern.test(result)) {
        correct++
        details.push(`  [OK] "${s.name}" → "${result.slice(0, 60)}"`)
      } else {
        details.push(`  [MISS] "${s.name}" → 期望匹配 ${s.expectPattern}, 实际: ${result ? `"${result.slice(0, 60)}"` : 'null'}`)
      }
    }
  }

  const score = correct / scenarios.length * 100
  details.unshift(`正确匹配: ${correct}/${scenarios.length}`)

  return { name: '行为模式匹配率 (Behavior)', score: Math.round(score), weight: 0.15, details }
}

// ══════════════════════════════════════════════════════════════════════════════
// REPORT
// ══════════════════════════════════════════════════════════════════════════════

function formatReport(dimensions: DimensionResult[]): string {
  const lines: string[] = []
  lines.push('╔══════════════════════════════════════════════════════════════╗')
  lines.push('║          cc-soul Memory System Benchmark                   ║')
  lines.push('╠══════════════════════════════════════════════════════════════╣')

  let weightedTotal = 0
  for (const d of dimensions) {
    weightedTotal += d.score * d.weight
    const bar = '█'.repeat(Math.round(d.score / 5)) + '░'.repeat(20 - Math.round(d.score / 5))
    lines.push(`║ ${d.name.padEnd(32)} ${bar} ${String(d.score).padStart(3)}/100 (×${d.weight})`)
    for (const detail of d.details) {
      lines.push(`║   ${detail}`)
    }
    lines.push('╠══════════════════════════════════════════════════════════════╣')
  }

  const finalScore = Math.round(weightedTotal)
  const grade = finalScore >= 90 ? 'A+' : finalScore >= 80 ? 'A' : finalScore >= 70 ? 'B'
    : finalScore >= 60 ? 'C' : finalScore >= 50 ? 'D' : 'F'

  lines.push(`║  TOTAL SCORE: ${finalScore}/100  Grade: ${grade}`)
  lines.push(`║  Weights: Precision(40%) + Recall(30%) + Facts(15%) + Behavior(15%)`)
  lines.push('╚══════════════════════════════════════════════════════════════╝')

  return lines.join('\n')
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

export function runBenchmark(): { score: number; report: string; dimensions: DimensionResult[] } {
  enterSandbox()

  try {
    const dimensions: DimensionResult[] = []

    // Dimension 1: Precision
    dimensions.push(benchPrecision())

    // Dimension 2: Recall (clears & re-injects internally)
    dimensions.push(benchRecall())

    // Dimension 3: Fact Extraction (stateless, uses extractFacts directly)
    dimensions.push(benchFactExtraction())

    // Dimension 4: Behavior Prediction (stateless, passes memories directly)
    dimensions.push(benchBehavior())

    const report = formatReport(dimensions)
    const score = Math.round(dimensions.reduce((sum, d) => sum + d.score * d.weight, 0))

    return { score, report, dimensions }
  } finally {
    exitSandbox()
  }
}

// Run directly
if (process.argv[1]?.endsWith('benchmark.ts')) {
  const { score, report } = runBenchmark()
  console.log(report)
  process.exit(score < 50 ? 1 : 0)
}
