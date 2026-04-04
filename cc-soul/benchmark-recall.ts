/**
 * benchmark-recall.ts — 无向量召回基准测试
 * 用法: npx tsx cc-soul/benchmark-recall.ts
 */

import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import type { Memory } from './types.ts'

const require = createRequire(import.meta.url)
;(globalThis as any).require = require
process.env.CC_SOUL_BENCHMARK = "1"  // activation-field.ts 内部 12 处 require 需要

// Lazy-load modules to avoid side effects
const { activationRecall } = require('./activation-field.ts')
const { expandQuery, learnAssociation } = require('./aam.ts')

// ═══════════════════════════════════════════════════════════════
// TEST DATA: 20 memories
// ═══════════════════════════════════════════════════════════════

const TEST_MEMORIES: Memory[] = [
  { content: '我在字节跳动做后端开发，主要写 Go 语言', scope: 'fact', ts: Date.now() - 86400000 * 30, confidence: 0.9, recallCount: 5, lastAccessed: Date.now() - 86400000 * 2 },
  { content: '我女朋友叫小雨，我们在一起三年了', scope: 'fact', ts: Date.now() - 86400000 * 60, confidence: 0.95, recallCount: 8, lastAccessed: Date.now() - 86400000 * 5 },
  { content: '最近血压有点高，医生让我少吃盐', scope: 'fact', ts: Date.now() - 86400000 * 10, confidence: 0.85, recallCount: 3, lastAccessed: Date.now() - 86400000 * 3 },
  { content: '我养了一只橘猫叫橘子，特别能吃', scope: 'fact', ts: Date.now() - 86400000 * 90, confidence: 0.9, recallCount: 6, lastAccessed: Date.now() - 86400000 * 1 },
  { content: '我大学在武汉读的计算机专业', scope: 'fact', ts: Date.now() - 86400000 * 120, confidence: 0.9, recallCount: 4, lastAccessed: Date.now() - 86400000 * 15 },
  { content: '去年十一去了成都旅游，吃了很多火锅', scope: 'episode', ts: Date.now() - 86400000 * 180, confidence: 0.8, recallCount: 2, lastAccessed: Date.now() - 86400000 * 30 },
  { content: '我每天早上跑步 5 公里，坚持了三个月', scope: 'fact', ts: Date.now() - 86400000 * 45, confidence: 0.85, recallCount: 4, lastAccessed: Date.now() - 86400000 * 7 },
  { content: '最近在学 Rust，感觉所有权系统很难理解', scope: 'fact', ts: Date.now() - 86400000 * 5, confidence: 0.8, recallCount: 2, lastAccessed: Date.now() - 86400000 * 1 },
  { content: '我妈做的红烧肉特别好吃，每次回家都要吃', scope: 'fact', ts: Date.now() - 86400000 * 200, confidence: 0.9, recallCount: 3, lastAccessed: Date.now() - 86400000 * 20 },
  { content: '上周面试了阿里巴巴，二面被刷了', scope: 'episode', ts: Date.now() - 86400000 * 7, confidence: 0.85, recallCount: 2, lastAccessed: Date.now() - 86400000 * 2 },
  { content: '我有轻度失眠，一般凌晨一点才能睡着', scope: 'fact', ts: Date.now() - 86400000 * 20, confidence: 0.8, recallCount: 3, lastAccessed: Date.now() - 86400000 * 5 },
  { content: '正在还房贷，每个月还 8000', scope: 'fact', ts: Date.now() - 86400000 * 60, confidence: 0.9, recallCount: 2, lastAccessed: Date.now() - 86400000 * 10 },
  { content: '小雨怀孕了，预产期是明年三月', scope: 'fact', ts: Date.now() - 86400000 * 3, confidence: 0.95, recallCount: 5, lastAccessed: Date.now() - 86400000 * 1 },
  { content: '我喜欢看科幻电影，最喜欢星际穿越', scope: 'preference', ts: Date.now() - 86400000 * 150, confidence: 0.85, recallCount: 2, lastAccessed: Date.now() - 86400000 * 30 },
  { content: '周末经常和朋友打篮球，在公司附近的球场', scope: 'fact', ts: Date.now() - 86400000 * 25, confidence: 0.8, recallCount: 3, lastAccessed: Date.now() - 86400000 * 3 },
  { content: '我对花粉过敏，春天出门要戴口罩', scope: 'fact', ts: Date.now() - 86400000 * 300, confidence: 0.9, recallCount: 4, lastAccessed: Date.now() - 86400000 * 60 },
  { content: '最近在考虑买特斯拉 Model 3', scope: 'fact', ts: Date.now() - 86400000 * 2, confidence: 0.75, recallCount: 1, lastAccessed: Date.now() - 86400000 * 1 },
  { content: '我老家在湖南长沙，特别能吃辣', scope: 'fact', ts: Date.now() - 86400000 * 365, confidence: 0.95, recallCount: 5, lastAccessed: Date.now() - 86400000 * 40 },
  { content: '下个月要参加朋友的婚礼，需要准备份子钱', scope: 'episode', ts: Date.now() - 86400000 * 1, confidence: 0.8, recallCount: 1, lastAccessed: Date.now() },
  { content: '最近经常加班到十一点，感觉很累', scope: 'episode', ts: Date.now() - 86400000 * 3, confidence: 0.85, recallCount: 3, lastAccessed: Date.now() - 86400000 * 1 },
  // Memory 20-39: new batch
  { content: '我每天早上 7 点起床跑步', scope: 'fact', ts: Date.now() - 86400000 * 15, confidence: 0.9, recallCount: 5, lastAccessed: Date.now() - 86400000 * 1 },
  { content: '我对花粉过敏，春天不能出门', scope: 'fact', ts: Date.now() - 86400000 * 180, confidence: 0.9, recallCount: 4, lastAccessed: Date.now() - 86400000 * 30 },
  { content: '我的车是特斯拉 Model 3', scope: 'fact', ts: Date.now() - 86400000 * 50, confidence: 0.92, recallCount: 3, lastAccessed: Date.now() - 86400000 * 5 },
  { content: '上个月工资涨了 2000', scope: 'fact', ts: Date.now() - 86400000 * 35, confidence: 0.85, recallCount: 2, lastAccessed: Date.now() - 86400000 * 10 },
  { content: '我女儿在学钢琴，每周三上课', scope: 'fact', ts: Date.now() - 86400000 * 60, confidence: 0.9, recallCount: 4, lastAccessed: Date.now() - 86400000 * 7 },
  { content: '我戒烟第 47 天了', scope: 'fact', ts: Date.now() - 86400000 * 8, confidence: 0.85, recallCount: 3, lastAccessed: Date.now() - 86400000 * 2 },
  { content: '我最怕蛇', scope: 'fact', ts: Date.now() - 86400000 * 120, confidence: 0.88, recallCount: 2, lastAccessed: Date.now() - 86400000 * 20 },
  { content: '下个月要去日本旅游', scope: 'episode', ts: Date.now() - 86400000 * 5, confidence: 0.82, recallCount: 2, lastAccessed: Date.now() - 86400000 * 1 },
  { content: '我大学室友叫张磊，现在在腾讯', scope: 'fact', ts: Date.now() - 86400000 * 150, confidence: 0.88, recallCount: 3, lastAccessed: Date.now() - 86400000 * 25 },
  { content: '我血型是 O 型', scope: 'fact', ts: Date.now() - 86400000 * 200, confidence: 0.95, recallCount: 1, lastAccessed: Date.now() - 86400000 * 60 },
  { content: '周末一般陪孩子去公园', scope: 'fact', ts: Date.now() - 86400000 * 40, confidence: 0.85, recallCount: 4, lastAccessed: Date.now() - 86400000 * 3 },
  { content: '我在考虑换工作，目标是阿里', scope: 'fact', ts: Date.now() - 86400000 * 3, confidence: 0.82, recallCount: 2, lastAccessed: Date.now() - 86400000 * 1 },
  { content: '我炒股亏了 3 万', scope: 'fact', ts: Date.now() - 86400000 * 25, confidence: 0.8, recallCount: 2, lastAccessed: Date.now() - 86400000 * 8 },
  { content: '我正在学日语，N3 水平', scope: 'fact', ts: Date.now() - 86400000 * 20, confidence: 0.85, recallCount: 3, lastAccessed: Date.now() - 86400000 * 4 },
  { content: '我和老婆是大学同学', scope: 'fact', ts: Date.now() - 86400000 * 170, confidence: 0.93, recallCount: 5, lastAccessed: Date.now() - 86400000 * 15 },
  { content: '我的 MacBook 是 M2 Pro 32G', scope: 'fact', ts: Date.now() - 86400000 * 45, confidence: 0.88, recallCount: 2, lastAccessed: Date.now() - 86400000 * 6 },
  { content: '我每周五和朋友打羽毛球', scope: 'fact', ts: Date.now() - 86400000 * 30, confidence: 0.83, recallCount: 4, lastAccessed: Date.now() - 86400000 * 3 },
  { content: '我最近在看《三体》', scope: 'fact', ts: Date.now() - 86400000 * 10, confidence: 0.82, recallCount: 2, lastAccessed: Date.now() - 86400000 * 2 },
  { content: '去年做了近视手术', scope: 'fact', ts: Date.now() - 86400000 * 100, confidence: 0.9, recallCount: 1, lastAccessed: Date.now() - 86400000 * 40 },
  { content: '我在字节做安全工程师', scope: 'fact', ts: Date.now() - 86400000 * 12, confidence: 0.92, recallCount: 6, lastAccessed: Date.now() - 86400000 * 1 },
] as Memory[]

// ═══════════════════════════════════════════════════════════════
// TEST QUERIES: 40 queries (2 per memory)
// ═══════════════════════════════════════════════════════════════

interface TestCase {
  query: string
  expectedIndex: number | number[]  // single index or array (multi-match: pass if ANY hit)
  type: 'direct' | 'semantic'
  description: string
}

const TEST_CASES: TestCase[] = [
  // Memory 0: 字节跳动 Go
  { query: '你在哪里上班', expectedIndex: 0, type: 'direct', description: '工作→字节' },
  { query: '你会什么编程语言', expectedIndex: 0, type: 'semantic', description: '编程语言→Go' },
  // Memory 1: 女朋友小雨
  { query: '你女朋友叫什么', expectedIndex: 1, type: 'direct', description: '女朋友→小雨' },
  { query: '你对象是谁', expectedIndex: 1, type: 'semantic', description: '对象→女朋友' },
  // Memory 2: 血压高
  { query: '你血压怎么样', expectedIndex: 2, type: 'direct', description: '血压→高' },
  { query: '你有什么健康问题', expectedIndex: 2, type: 'semantic', description: '健康→血压' },
  // Memory 3: 橘猫
  { query: '你养了什么宠物', expectedIndex: 3, type: 'direct', description: '宠物→橘猫' },
  { query: '橘子最近怎么样', expectedIndex: 3, type: 'semantic', description: '橘子→猫名' },
  // Memory 4: 武汉大学
  { query: '你在哪里上的大学', expectedIndex: 4, type: 'direct', description: '大学→武汉' },
  { query: '你母校在哪', expectedIndex: 4, type: 'semantic', description: '母校→大学' },
  // Memory 5: 成都火锅
  { query: '你去过成都吗', expectedIndex: 5, type: 'direct', description: '成都→旅游' },
  { query: '你喜欢吃什么美食', expectedIndex: 5, type: 'semantic', description: '美食→火锅' },
  // Memory 6: 跑步
  { query: '你每天跑多少公里', expectedIndex: 6, type: 'direct', description: '跑步→5公里' },
  { query: '你有什么锻炼习惯', expectedIndex: 6, type: 'semantic', description: '锻炼→跑步' },
  // Memory 7: Rust
  { query: '你在学什么新技术', expectedIndex: 7, type: 'direct', description: '技术→Rust' },
  { query: '所有权系统你搞懂了吗', expectedIndex: 7, type: 'semantic', description: '所有权→Rust' },
  // Memory 8: 红烧肉
  { query: '你妈做什么菜好吃', expectedIndex: 8, type: 'direct', description: '妈→红烧肉' },
  { query: '你回家最想吃什么', expectedIndex: 8, type: 'semantic', description: '回家吃→红烧肉' },
  // Memory 9: 面试阿里
  { query: '你面试阿里怎么样了', expectedIndex: 9, type: 'direct', description: '面试→阿里' },
  { query: '你最近有没有找工作', expectedIndex: 9, type: 'semantic', description: '找工作→面试' },
  // Memory 10: 失眠
  { query: '你睡眠怎么样', expectedIndex: 10, type: 'direct', description: '睡眠→失眠' },
  { query: '你几点睡觉', expectedIndex: 10, type: 'semantic', description: '几点睡→凌晨一点' },
  // Memory 11: 房贷
  { query: '你每个月还多少房贷', expectedIndex: 11, type: 'direct', description: '房贷→8000' },
  { query: '你有什么经济压力', expectedIndex: 11, type: 'semantic', description: '经济压力→房贷' },
  // Memory 12: 小雨怀孕
  { query: '小雨预产期是什么时候', expectedIndex: 12, type: 'direct', description: '预产期→三月' },
  { query: '你要当爸爸了吗', expectedIndex: 12, type: 'semantic', description: '当爸爸→怀孕' },
  // Memory 13: 科幻电影
  { query: '你喜欢看什么电影', expectedIndex: 13, type: 'direct', description: '电影→科幻' },
  { query: '星际穿越你看过吗', expectedIndex: 13, type: 'semantic', description: '星际穿越→最喜欢' },
  // Memory 14: 篮球
  { query: '你周末打篮球吗', expectedIndex: 14, type: 'direct', description: '篮球→周末' },
  { query: '你有什么运动爱好', expectedIndex: 14, type: 'semantic', description: '运动爱好→篮球' },
  // Memory 15: 花粉过敏
  { query: '你对什么过敏', expectedIndex: 15, type: 'direct', description: '过敏→花粉' },
  { query: '春天出门你要注意什么', expectedIndex: 15, type: 'semantic', description: '春天注意→口罩' },
  // Memory 16: 特斯拉
  { query: '你想买什么车', expectedIndex: 16, type: 'direct', description: '买车→特斯拉' },
  { query: '你考虑入手电动车吗', expectedIndex: 16, type: 'semantic', description: '电动车→特斯拉' },
  // Memory 17: 湖南长沙
  { query: '你老家在哪里', expectedIndex: 17, type: 'direct', description: '老家→长沙' },
  { query: '你能吃辣吗', expectedIndex: 17, type: 'semantic', description: '吃辣→湖南' },
  // Memory 18: 婚礼
  { query: '你下个月有什么安排', expectedIndex: 18, type: 'direct', description: '安排→婚礼' },
  { query: '份子钱准备了多少', expectedIndex: 18, type: 'semantic', description: '份子钱→婚礼' },
  // Memory 19: 加班
  { query: '你最近加班多吗', expectedIndex: 19, type: 'direct', description: '加班→十一点' },
  { query: '你工作累不累', expectedIndex: 19, type: 'semantic', description: '工作累→加班' },

  // ── New direct queries (Memory 20-39) ──
  { query: '我几点起床', expectedIndex: 20, type: 'direct', description: '起床→7点跑步' },
  { query: '我对什么过敏', expectedIndex: 21, type: 'direct', description: '过敏→花粉' },
  { query: '我开什么车', expectedIndex: 22, type: 'direct', description: '开车→特斯拉' },
  { query: '我工资涨了多少', expectedIndex: 23, type: 'direct', description: '涨薪→2000' },
  { query: '我女儿学什么乐器', expectedIndex: 24, type: 'direct', description: '乐器→钢琴' },
  { query: '我戒烟多久了', expectedIndex: 25, type: 'direct', description: '戒烟→47天' },
  { query: '我怕什么', expectedIndex: 26, type: 'direct', description: '怕→蛇' },
  { query: '我下个月去哪旅游', expectedIndex: 27, type: 'direct', description: '旅游→日本' },
  { query: '我室友叫什么', expectedIndex: 28, type: 'direct', description: '室友→张磊' },
  { query: '我什么血型', expectedIndex: 29, type: 'direct', description: '血型→O型' },
  { query: '周末一般干嘛', expectedIndex: 30, type: 'direct', description: '周末→陪孩子公园' },
  { query: '我想去哪个公司', expectedIndex: 31, type: 'direct', description: '公司→阿里' },
  { query: '我炒股亏了多少', expectedIndex: 32, type: 'direct', description: '炒股→3万' },
  { query: '我在学什么语言', expectedIndex: 33, type: 'direct', description: '学语言→日语' },
  { query: '我老婆怎么认识的', expectedIndex: 34, type: 'direct', description: '老婆→大学同学' },
  { query: '我电脑什么配置', expectedIndex: 35, type: 'direct', description: '电脑→M2 Pro' },
  { query: '我周五做什么运动', expectedIndex: 36, type: 'direct', description: '周五运动→羽毛球' },
  { query: '我最近在看什么书', expectedIndex: 37, type: 'direct', description: '看书→三体' },
  { query: '我做过什么手术', expectedIndex: 38, type: 'direct', description: '手术→近视' },
  { query: '我在哪工作', expectedIndex: 39, type: 'direct', description: '工作→字节安全' },

  // ── New semantic queries (Memory 20-39) ──
  { query: '我的晨练习惯', expectedIndex: 20, type: 'semantic', description: '晨练→跑步' },
  { query: '我有什么健康隐患', expectedIndex: [21, 38], type: 'semantic', description: '健康隐患→过敏/近视' },
  { query: '我的交通工具', expectedIndex: 22, type: 'semantic', description: '交通工具→特斯拉' },
  { query: '我的收入变化', expectedIndex: 23, type: 'semantic', description: '收入变化→涨薪' },
  { query: '孩子的课外活动', expectedIndex: 24, type: 'semantic', description: '课外活动→钢琴' },
  { query: '我在克服什么坏习惯', expectedIndex: 25, type: 'semantic', description: '坏习惯→戒烟' },
  { query: '我的恐惧', expectedIndex: 26, type: 'semantic', description: '恐惧→蛇' },
  { query: '最近的旅行计划', expectedIndex: 27, type: 'semantic', description: '旅行计划→日本' },
  { query: '我的老同学现在干嘛', expectedIndex: 28, type: 'semantic', description: '老同学→张磊腾讯' },
  { query: '我的职业规划', expectedIndex: 31, type: 'semantic', description: '职业规划→换工作阿里' },
  { query: '我的投资情况', expectedIndex: 32, type: 'semantic', description: '投资→炒股亏3万' },
  { query: '我在自我提升什么', expectedIndex: 33, type: 'semantic', description: '自我提升→学日语' },
  { query: '我和老婆的故事', expectedIndex: 34, type: 'semantic', description: '老婆故事→大学同学' },
  { query: '我的数码装备', expectedIndex: 35, type: 'semantic', description: '数码装备→MacBook' },
  { query: '我的运动习惯', expectedIndex: [20, 36], type: 'semantic', description: '运动→跑步/羽毛球' },
  { query: '我的阅读偏好', expectedIndex: 37, type: 'semantic', description: '阅读→三体' },
  { query: '我的视力情况', expectedIndex: 38, type: 'semantic', description: '视力→近视手术' },
  { query: '我家里几口人', expectedIndex: [24, 34], type: 'semantic', description: '家人→老婆+女儿' },
  { query: '我周末的安排', expectedIndex: 30, type: 'semantic', description: '周末安排→陪孩子公园' },
  { query: '我最近有什么烦心事', expectedIndex: [32, 31], type: 'semantic', description: '烦心事→亏钱/换工作' },
]

// ═══════════════════════════════════════════════════════════════
// BENCHMARK
// ═══════════════════════════════════════════════════════════════

function runBenchmark() {
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  cc-soul 无向量召回基准测试')
  console.log('═══════════════════════════════════════════════════════════')
  console.log()

  // 先让 AAM 学习测试记忆（模拟实际使用）
  for (const mem of TEST_MEMORIES) {
    learnAssociation(mem.content, 0.3)
  }

  // Populate fact-store from test memories
  try {
    const factStore = require('./fact-store.ts')
    for (const mem of TEST_MEMORIES) {
      factStore.extractAndStoreFacts?.(mem.content, 'user')
    }
  } catch {}

  let directHits = 0, directTotal = 0
  let semanticHits = 0, semanticTotal = 0
  let top1Hits = 0
  const failures: { query: string; type: string; desc: string; got: string[] }[] = []

  for (const tc of TEST_CASES) {
    const results = activationRecall(TEST_MEMORIES, tc.query, 3, 0, 0.5) as Memory[]
    const resultContents = results.map(r => r.content)
    const indices = Array.isArray(tc.expectedIndex) ? tc.expectedIndex : [tc.expectedIndex]
    const expectedContents = indices.map(i => TEST_MEMORIES[i].content)
    const hit = expectedContents.some(ec => resultContents.includes(ec))
    const isTop1 = expectedContents.some(ec => resultContents[0] === ec)

    if (tc.type === 'direct') {
      directTotal++
      if (hit) directHits++
    } else {
      semanticTotal++
      if (hit) semanticHits++
    }
    if (isTop1) top1Hits++

    if (!hit) {
      failures.push({
        query: tc.query,
        type: tc.type,
        desc: tc.description,
        got: resultContents.map(c => c.slice(0, 30)),
      })
    }

    const mark = hit ? (isTop1 ? '✅' : '🟡') : '❌'
    console.log(`${mark} [${tc.type.padEnd(8)}] ${tc.description.padEnd(20)} | ${tc.query}`)
  }

  console.log()
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  结果汇总')
  console.log('═══════════════════════════════════════════════════════════')
  console.log()
  const directRate = (directHits / directTotal * 100).toFixed(0)
  const semanticRate = (semanticHits / semanticTotal * 100).toFixed(0)
  const totalRate = ((directHits + semanticHits) / (directTotal + semanticTotal) * 100).toFixed(0)
  const top1Rate = (top1Hits / (directTotal + semanticTotal) * 100).toFixed(0)

  console.log(`  直接召回 (top-3):  ${directHits}/${directTotal} = ${directRate}%`)
  console.log(`  语义召回 (top-3):  ${semanticHits}/${semanticTotal} = ${semanticRate}%`)
  console.log(`  总体 (top-3):      ${(directHits + semanticHits)}/${(directTotal + semanticTotal)} = ${totalRate}%`)
  console.log(`  Top-1 准确率:      ${top1Hits}/${(directTotal + semanticTotal)} = ${top1Rate}%`)
  console.log()

  if (failures.length > 0) {
    console.log('  ── 失败用例 ──')
    for (const f of failures) {
      console.log(`  ❌ [${f.type}] ${f.desc}: "${f.query}"`)
      console.log(`     实际返回: ${f.got.join(' | ')}`)
    }
  }
}

runBenchmark()
