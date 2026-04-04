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
// TEST DATA: 80 memories (index 0-79)
// ═══════════════════════════════════════════════════════════════

const TEST_MEMORIES: Memory[] = [
  // ── 0-19: Original batch ──
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

  // ── 20-39: Second batch ──
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

  // ── 40-79: New batch — social media, music, cooking, weather, childhood, goals, routines, shopping, transport, news ──
  // Social media / online habits (40-43)
  { content: '我每天刷抖音至少两小时', scope: 'fact', ts: Date.now() - 86400000 * 20, confidence: 0.85, recallCount: 3, lastAccessed: Date.now() - 86400000 * 1 },
  { content: '我有一个技术博客，写了 50 多篇文章', scope: 'fact', ts: Date.now() - 86400000 * 90, confidence: 0.88, recallCount: 2, lastAccessed: Date.now() - 86400000 * 10 },
  { content: '我微信好友有 2000 多人', scope: 'fact', ts: Date.now() - 86400000 * 60, confidence: 0.8, recallCount: 1, lastAccessed: Date.now() - 86400000 * 15 },
  { content: '我在小红书上关注了很多美食博主', scope: 'fact', ts: Date.now() - 86400000 * 30, confidence: 0.82, recallCount: 2, lastAccessed: Date.now() - 86400000 * 5 },

  // Music preferences (44-47)
  { content: '我最喜欢周杰伦的歌，听了二十年了', scope: 'preference', ts: Date.now() - 86400000 * 200, confidence: 0.92, recallCount: 5, lastAccessed: Date.now() - 86400000 * 3 },
  { content: '写代码的时候习惯听 lo-fi 电子乐', scope: 'fact', ts: Date.now() - 86400000 * 40, confidence: 0.85, recallCount: 3, lastAccessed: Date.now() - 86400000 * 2 },
  { content: '上个月去看了五月天的演唱会', scope: 'episode', ts: Date.now() - 86400000 * 28, confidence: 0.88, recallCount: 2, lastAccessed: Date.now() - 86400000 * 7 },
  { content: '我小时候学过两年小提琴，后来没坚持', scope: 'fact', ts: Date.now() - 86400000 * 250, confidence: 0.83, recallCount: 1, lastAccessed: Date.now() - 86400000 * 30 },

  // Cooking skills (48-51)
  { content: '我会做糖醋排骨，是我的拿手菜', scope: 'fact', ts: Date.now() - 86400000 * 50, confidence: 0.9, recallCount: 4, lastAccessed: Date.now() - 86400000 * 8 },
  { content: '我做饭基本靠下厨房 App 看菜谱', scope: 'fact', ts: Date.now() - 86400000 * 35, confidence: 0.82, recallCount: 2, lastAccessed: Date.now() - 86400000 * 5 },
  { content: '上周学会了做提拉米苏', scope: 'episode', ts: Date.now() - 86400000 * 6, confidence: 0.8, recallCount: 1, lastAccessed: Date.now() - 86400000 * 2 },
  { content: '我不吃香菜，闻到就恶心', scope: 'preference', ts: Date.now() - 86400000 * 300, confidence: 0.95, recallCount: 4, lastAccessed: Date.now() - 86400000 * 10 },

  // Weather / seasonal preferences (52-55)
  { content: '我怕冷，冬天不愿意出门', scope: 'fact', ts: Date.now() - 86400000 * 120, confidence: 0.88, recallCount: 3, lastAccessed: Date.now() - 86400000 * 15 },
  { content: '最喜欢秋天，不冷不热刚刚好', scope: 'preference', ts: Date.now() - 86400000 * 150, confidence: 0.85, recallCount: 2, lastAccessed: Date.now() - 86400000 * 20 },
  { content: '下雨天就想在家打游戏', scope: 'fact', ts: Date.now() - 86400000 * 25, confidence: 0.8, recallCount: 3, lastAccessed: Date.now() - 86400000 * 4 },
  { content: '去年夏天中暑过一次，在公司晕倒了', scope: 'episode', ts: Date.now() - 86400000 * 80, confidence: 0.87, recallCount: 2, lastAccessed: Date.now() - 86400000 * 25 },

  // Childhood memories (56-59)
  { content: '小时候在农村长大，经常下河摸鱼', scope: 'fact', ts: Date.now() - 86400000 * 365, confidence: 0.9, recallCount: 3, lastAccessed: Date.now() - 86400000 * 40 },
  { content: '我小学的时候数学竞赛拿过市一等奖', scope: 'fact', ts: Date.now() - 86400000 * 350, confidence: 0.88, recallCount: 2, lastAccessed: Date.now() - 86400000 * 50 },
  { content: '我从小就怕打针，到现在还是', scope: 'fact', ts: Date.now() - 86400000 * 280, confidence: 0.85, recallCount: 2, lastAccessed: Date.now() - 86400000 * 35 },
  { content: '小时候养过一条狗叫旺财，被车撞死了', scope: 'episode', ts: Date.now() - 86400000 * 400, confidence: 0.82, recallCount: 1, lastAccessed: Date.now() - 86400000 * 60 },

  // Future goals / dreams (60-63)
  { content: '我的梦想是开一家咖啡店', scope: 'fact', ts: Date.now() - 86400000 * 70, confidence: 0.8, recallCount: 2, lastAccessed: Date.now() - 86400000 * 12 },
  { content: '计划明年考 PMP 项目管理证书', scope: 'fact', ts: Date.now() - 86400000 * 15, confidence: 0.82, recallCount: 2, lastAccessed: Date.now() - 86400000 * 3 },
  { content: '想在 35 岁之前攒够 200 万', scope: 'fact', ts: Date.now() - 86400000 * 45, confidence: 0.78, recallCount: 1, lastAccessed: Date.now() - 86400000 * 10 },
  { content: '打算三年内在老家给父母盖一栋新房子', scope: 'fact', ts: Date.now() - 86400000 * 55, confidence: 0.85, recallCount: 3, lastAccessed: Date.now() - 86400000 * 8 },

  // Daily routines (64-67)
  { content: '我早上先喝咖啡再吃早饭', scope: 'fact', ts: Date.now() - 86400000 * 30, confidence: 0.88, recallCount: 4, lastAccessed: Date.now() - 86400000 * 1 },
  { content: '中午一般在公司食堂吃饭', scope: 'fact', ts: Date.now() - 86400000 * 40, confidence: 0.85, recallCount: 3, lastAccessed: Date.now() - 86400000 * 2 },
  { content: '晚上洗完澡会看半小时 B 站', scope: 'fact', ts: Date.now() - 86400000 * 22, confidence: 0.82, recallCount: 3, lastAccessed: Date.now() - 86400000 * 1 },
  { content: '睡前必须刷十分钟微博才能入睡', scope: 'fact', ts: Date.now() - 86400000 * 18, confidence: 0.8, recallCount: 2, lastAccessed: Date.now() - 86400000 * 1 },

  // Shopping habits (68-71)
  { content: '每个月花在网购上大概 3000', scope: 'fact', ts: Date.now() - 86400000 * 35, confidence: 0.83, recallCount: 2, lastAccessed: Date.now() - 86400000 * 5 },
  { content: '双十一囤了一堆零食和日用品', scope: 'episode', ts: Date.now() - 86400000 * 140, confidence: 0.8, recallCount: 1, lastAccessed: Date.now() - 86400000 * 20 },
  { content: '买衣服只在优衣库和 Zara 买', scope: 'preference', ts: Date.now() - 86400000 * 80, confidence: 0.85, recallCount: 3, lastAccessed: Date.now() - 86400000 * 10 },
  { content: '最近迷上了买盲盒，已经花了一千多', scope: 'fact', ts: Date.now() - 86400000 * 10, confidence: 0.78, recallCount: 2, lastAccessed: Date.now() - 86400000 * 3 },

  // Transportation (72-75)
  { content: '我坐地铁上班，2 号线转 10 号线', scope: 'fact', ts: Date.now() - 86400000 * 50, confidence: 0.9, recallCount: 5, lastAccessed: Date.now() - 86400000 * 1 },
  { content: '上班单程需要一个半小时', scope: 'fact', ts: Date.now() - 86400000 * 48, confidence: 0.88, recallCount: 3, lastAccessed: Date.now() - 86400000 * 2 },
  { content: '偶尔骑共享单车去地铁站', scope: 'fact', ts: Date.now() - 86400000 * 30, confidence: 0.8, recallCount: 2, lastAccessed: Date.now() - 86400000 * 3 },
  { content: '去年拿到驾照了但不太敢开车', scope: 'fact', ts: Date.now() - 86400000 * 100, confidence: 0.85, recallCount: 2, lastAccessed: Date.now() - 86400000 * 15 },

  // News / current events interests (76-79)
  { content: '我关注科技新闻，每天看 36kr', scope: 'fact', ts: Date.now() - 86400000 * 60, confidence: 0.87, recallCount: 4, lastAccessed: Date.now() - 86400000 * 1 },
  { content: '最近一直在关注 AI 大模型的发展', scope: 'fact', ts: Date.now() - 86400000 * 10, confidence: 0.85, recallCount: 3, lastAccessed: Date.now() - 86400000 * 1 },
  { content: '不看娱乐八卦，觉得浪费时间', scope: 'preference', ts: Date.now() - 86400000 * 90, confidence: 0.82, recallCount: 2, lastAccessed: Date.now() - 86400000 * 12 },
  { content: '喜欢看 B 站的科普视频，关注了半佛仙人', scope: 'preference', ts: Date.now() - 86400000 * 55, confidence: 0.84, recallCount: 3, lastAccessed: Date.now() - 86400000 * 4 },
] as Memory[]

// ═══════════════════════════════════════════════════════════════
// TEST QUERIES: 200 queries (100 direct + 100 semantic)
// ═══════════════════════════════════════════════════════════════

interface TestCase {
  query: string
  expectedIndex: number | number[]  // single index or array (multi-match: pass if ANY hit)
  type: 'direct' | 'semantic'
  description: string
}

const TEST_CASES: TestCase[] = [
  // ════════════════════════════════════════════════════════════
  // DIRECT QUERIES (100 total)
  // ════════════════════════════════════════════════════════════

  // Memory 0-19: Original direct
  { query: '你在哪里上班', expectedIndex: 0, type: 'direct', description: '工作→字节' },
  { query: '你女朋友叫什么', expectedIndex: 1, type: 'direct', description: '女朋友→小雨' },
  { query: '你血压怎么样', expectedIndex: 2, type: 'direct', description: '血压→高' },
  { query: '你养了什么宠物', expectedIndex: 3, type: 'direct', description: '宠物→橘猫' },
  { query: '你在哪里上的大学', expectedIndex: 4, type: 'direct', description: '大学→武汉' },
  { query: '你去过成都吗', expectedIndex: 5, type: 'direct', description: '成都→旅游' },
  { query: '你每天跑多少公里', expectedIndex: 6, type: 'direct', description: '跑步→5公里' },
  { query: '你在学什么新技术', expectedIndex: 7, type: 'direct', description: '技术→Rust' },
  { query: '你妈做什么菜好吃', expectedIndex: 8, type: 'direct', description: '妈→红烧肉' },
  { query: '你面试阿里怎么样了', expectedIndex: 9, type: 'direct', description: '面试→阿里' },
  { query: '你睡眠怎么样', expectedIndex: 10, type: 'direct', description: '睡眠→失眠' },
  { query: '你每个月还多少房贷', expectedIndex: 11, type: 'direct', description: '房贷→8000' },
  { query: '小雨预产期是什么时候', expectedIndex: 12, type: 'direct', description: '预产期→三月' },
  { query: '你喜欢看什么电影', expectedIndex: 13, type: 'direct', description: '电影→科幻' },
  { query: '你周末打篮球吗', expectedIndex: 14, type: 'direct', description: '篮球→周末' },
  { query: '你对什么过敏', expectedIndex: 15, type: 'direct', description: '过敏→花粉' },
  { query: '你想买什么车', expectedIndex: 16, type: 'direct', description: '买车→特斯拉' },
  { query: '你老家在哪里', expectedIndex: 17, type: 'direct', description: '老家→长沙' },
  { query: '你下个月有什么安排', expectedIndex: 18, type: 'direct', description: '安排→婚礼' },
  { query: '你最近加班多吗', expectedIndex: 19, type: 'direct', description: '加班→十一点' },

  // Memory 20-39: Second batch direct
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

  // Memory 40-43: Social media direct
  { query: '我每天刷抖音多久', expectedIndex: 40, type: 'direct', description: '抖音→两小时' },
  { query: '我有技术博客吗', expectedIndex: 41, type: 'direct', description: '博客→50篇' },
  { query: '我微信有多少好友', expectedIndex: 42, type: 'direct', description: '微信→2000人' },
  { query: '我在小红书上关注什么', expectedIndex: 43, type: 'direct', description: '小红书→美食博主' },

  // Memory 44-47: Music direct
  { query: '我最喜欢谁的歌', expectedIndex: 44, type: 'direct', description: '喜欢歌→周杰伦' },
  { query: '写代码时听什么音乐', expectedIndex: 45, type: 'direct', description: '代码音乐→lo-fi' },
  { query: '我去看过什么演唱会', expectedIndex: 46, type: 'direct', description: '演唱会→五月天' },
  { query: '我小时候学过什么乐器', expectedIndex: 47, type: 'direct', description: '乐器→小提琴' },

  // Memory 48-51: Cooking direct
  { query: '我的拿手菜是什么', expectedIndex: 48, type: 'direct', description: '拿手菜→糖醋排骨' },
  { query: '我用什么 App 看菜谱', expectedIndex: 49, type: 'direct', description: '菜谱→下厨房' },
  { query: '我最近学会做什么甜品', expectedIndex: 50, type: 'direct', description: '甜品→提拉米苏' },
  { query: '我不吃什么菜', expectedIndex: 51, type: 'direct', description: '不吃→香菜' },

  // Memory 52-55: Weather direct
  { query: '你怕冷吗', expectedIndex: 52, type: 'direct', description: '怕冷→冬天不出门' },
  { query: '你最喜欢什么季节', expectedIndex: 53, type: 'direct', description: '季节→秋天' },
  { query: '下雨天你一般干嘛', expectedIndex: 54, type: 'direct', description: '下雨→打游戏' },
  { query: '你中暑过吗', expectedIndex: 55, type: 'direct', description: '中暑→公司晕倒' },

  // Memory 56-59: Childhood direct
  { query: '你小时候在哪里长大', expectedIndex: 56, type: 'direct', description: '小时候→农村' },
  { query: '你数学成绩好吗', expectedIndex: 57, type: 'direct', description: '数学→竞赛一等奖' },
  { query: '你怕打针吗', expectedIndex: 58, type: 'direct', description: '打针→怕' },
  { query: '你小时候养过什么动物', expectedIndex: 59, type: 'direct', description: '动物→狗旺财' },

  // Memory 60-63: Goals direct
  { query: '你的梦想是什么', expectedIndex: 60, type: 'direct', description: '梦想→咖啡店' },
  { query: '你打算考什么证', expectedIndex: 61, type: 'direct', description: '考证→PMP' },
  { query: '你想攒多少钱', expectedIndex: 62, type: 'direct', description: '攒钱→200万' },
  { query: '你给父母有什么打算', expectedIndex: 63, type: 'direct', description: '父母→盖房子' },

  // Memory 64-67: Routines direct
  { query: '你早上先干嘛', expectedIndex: 64, type: 'direct', description: '早上→喝咖啡' },
  { query: '你中午在哪吃饭', expectedIndex: 65, type: 'direct', description: '中午→食堂' },
  { query: '你晚上洗完澡干嘛', expectedIndex: 66, type: 'direct', description: '洗澡后→B站' },
  { query: '你睡前做什么', expectedIndex: 67, type: 'direct', description: '睡前→刷微博' },

  // Memory 68-71: Shopping direct
  { query: '你每个月网购花多少钱', expectedIndex: 68, type: 'direct', description: '网购→3000' },
  { query: '你双十一买了什么', expectedIndex: 69, type: 'direct', description: '双十一→零食日用品' },
  { query: '你在哪买衣服', expectedIndex: 70, type: 'direct', description: '买衣服→优衣库Zara' },
  { query: '你买盲盒花了多少', expectedIndex: 71, type: 'direct', description: '盲盒→一千多' },

  // Memory 72-75: Transport direct
  { query: '你怎么上班', expectedIndex: 72, type: 'direct', description: '上班→地铁2转10' },
  { query: '你上班路上要多久', expectedIndex: 73, type: 'direct', description: '通勤→一个半小时' },
  { query: '你骑共享单车吗', expectedIndex: 74, type: 'direct', description: '单车→去地铁站' },
  { query: '你有驾照吗', expectedIndex: 75, type: 'direct', description: '驾照→有但不敢开' },

  // Memory 76-79: News direct
  { query: '你看什么新闻', expectedIndex: 76, type: 'direct', description: '新闻→36kr科技' },
  { query: '你关注 AI 吗', expectedIndex: 77, type: 'direct', description: 'AI→大模型' },
  { query: '你看娱乐八卦吗', expectedIndex: 78, type: 'direct', description: '八卦→不看' },
  { query: '你在 B 站关注了谁', expectedIndex: 79, type: 'direct', description: 'B站→半佛仙人' },

  // ════════════════════════════════════════════════════════════
  // SEMANTIC QUERIES (100 total)
  // ════════════════════════════════════════════════════════════

  // Memory 0-19: Original semantic
  { query: '你会什么编程语言', expectedIndex: 0, type: 'semantic', description: '编程语言→Go' },
  { query: '你对象是谁', expectedIndex: 1, type: 'semantic', description: '对象→女朋友' },
  { query: '你有什么健康问题', expectedIndex: 2, type: 'semantic', description: '健康→血压' },
  { query: '橘子最近怎么样', expectedIndex: 3, type: 'semantic', description: '橘子→猫名' },
  { query: '你母校在哪', expectedIndex: 4, type: 'semantic', description: '母校→大学' },
  { query: '你喜欢吃什么美食', expectedIndex: 5, type: 'semantic', description: '美食→火锅' },
  { query: '你有什么锻炼习惯', expectedIndex: 6, type: 'semantic', description: '锻炼→跑步' },
  { query: '所有权系统你搞懂了吗', expectedIndex: 7, type: 'semantic', description: '所有权→Rust' },
  { query: '你回家最想吃什么', expectedIndex: 8, type: 'semantic', description: '回家吃→红烧肉' },
  { query: '你最近有没有找工作', expectedIndex: 9, type: 'semantic', description: '找工作→面试' },
  { query: '你几点睡觉', expectedIndex: 10, type: 'semantic', description: '几点睡→凌晨一点' },
  { query: '你有什么经济压力', expectedIndex: 11, type: 'semantic', description: '经济压力→房贷' },
  { query: '你要当爸爸了吗', expectedIndex: 12, type: 'semantic', description: '当爸爸→怀孕' },
  { query: '星际穿越你看过吗', expectedIndex: 13, type: 'semantic', description: '星际穿越→最喜欢' },
  { query: '你有什么运动爱好', expectedIndex: 14, type: 'semantic', description: '运动爱好→篮球' },
  { query: '春天出门你要注意什么', expectedIndex: 15, type: 'semantic', description: '春天注意→口罩' },
  { query: '你考虑入手电动车吗', expectedIndex: 16, type: 'semantic', description: '电动车→特斯拉' },
  { query: '你能吃辣吗', expectedIndex: 17, type: 'semantic', description: '吃辣→湖南' },
  { query: '份子钱准备了多少', expectedIndex: 18, type: 'semantic', description: '份子钱→婚礼' },
  { query: '你工作累不累', expectedIndex: 19, type: 'semantic', description: '工作累→加班' },

  // Memory 20-39: Second batch semantic
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

  // Memory 40-43: Social media semantic
  { query: '你平时玩什么短视频', expectedIndex: 40, type: 'semantic', description: '短视频→抖音' },
  { query: '你有没有在网上写东西', expectedIndex: 41, type: 'semantic', description: '写东西→技术博客' },
  { query: '你的社交圈大吗', expectedIndex: 42, type: 'semantic', description: '社交圈→微信2000人' },
  { query: '你平时怎么发现好吃的', expectedIndex: 43, type: 'semantic', description: '发现美食→小红书' },

  // Memory 44-47: Music semantic
  { query: '你的音乐品味', expectedIndex: 44, type: 'semantic', description: '音乐品味→周杰伦' },
  { query: '你工作时需要什么氛围', expectedIndex: 45, type: 'semantic', description: '工作氛围→lo-fi音乐' },
  { query: '你最近有什么娱乐活动', expectedIndex: 46, type: 'semantic', description: '娱乐活动→五月天演唱会' },
  { query: '你有什么半途而废的事', expectedIndex: 47, type: 'semantic', description: '半途而废→小提琴' },

  // Memory 48-51: Cooking semantic
  { query: '你厨艺怎么样', expectedIndex: 48, type: 'semantic', description: '厨艺→糖醋排骨' },
  { query: '你是怎么学做饭的', expectedIndex: 49, type: 'semantic', description: '学做饭→下厨房App' },
  { query: '你最近在厨房搞什么花样', expectedIndex: 50, type: 'semantic', description: '厨房花样→提拉米苏' },
  { query: '你有什么忌口', expectedIndex: 51, type: 'semantic', description: '忌口→香菜' },

  // Memory 52-55: Weather semantic
  { query: '你冬天一般宅在家吗', expectedIndex: 52, type: 'semantic', description: '冬天宅→怕冷' },
  { query: '什么天气让你最舒服', expectedIndex: 53, type: 'semantic', description: '舒服天气→秋天' },
  { query: '你平时打什么游戏', expectedIndex: 54, type: 'semantic', description: '游戏→下雨天' },
  { query: '你在公司出过什么状况', expectedIndex: 55, type: 'semantic', description: '公司状况→中暑晕倒' },

  // Memory 56-59: Childhood semantic
  { query: '你的童年是什么样的', expectedIndex: 56, type: 'semantic', description: '童年→农村摸鱼' },
  { query: '你从小学习就好吗', expectedIndex: 57, type: 'semantic', description: '学习好→数学竞赛' },
  { query: '你去医院会紧张吗', expectedIndex: 58, type: 'semantic', description: '医院紧张→怕打针' },
  { query: '你以前养过宠物吗', expectedIndex: 59, type: 'semantic', description: '以前宠物→旺财' },

  // Memory 60-63: Goals semantic
  { query: '你有什么创业想法', expectedIndex: 60, type: 'semantic', description: '创业→咖啡店' },
  { query: '你在规划什么职业发展', expectedIndex: 61, type: 'semantic', description: '职业发展→PMP' },
  { query: '你的财务目标', expectedIndex: 62, type: 'semantic', description: '财务目标→200万' },
  { query: '你对父母的孝心', expectedIndex: 63, type: 'semantic', description: '孝心→盖房' },

  // Memory 64-67: Routines semantic
  { query: '你有什么早起仪式', expectedIndex: 64, type: 'semantic', description: '早起仪式→咖啡' },
  { query: '你午餐怎么解决', expectedIndex: 65, type: 'semantic', description: '午餐→食堂' },
  { query: '你的睡前娱乐', expectedIndex: [66, 67], type: 'semantic', description: '睡前娱乐→B站/微博' },
  { query: '你有什么放松方式', expectedIndex: [66, 54], type: 'semantic', description: '放松→B站/游戏' },

  // Memory 68-71: Shopping semantic
  { query: '你消费水平怎么样', expectedIndex: 68, type: 'semantic', description: '消费水平→网购3000' },
  { query: '你囤货严重吗', expectedIndex: 69, type: 'semantic', description: '囤货→双十一' },
  { query: '你的穿衣风格', expectedIndex: 70, type: 'semantic', description: '穿衣→优衣库Zara' },
  { query: '你有什么烧钱的爱好', expectedIndex: 71, type: 'semantic', description: '烧钱爱好→盲盒' },

  // Memory 72-75: Transport semantic
  { query: '你的通勤方式', expectedIndex: 72, type: 'semantic', description: '通勤→地铁' },
  { query: '你每天花多少时间在路上', expectedIndex: 73, type: 'semantic', description: '路上时间→一个半小时' },
  { query: '最后一公里怎么解决', expectedIndex: 74, type: 'semantic', description: '最后一公里→共享单车' },
  { query: '你会开车吗', expectedIndex: 75, type: 'semantic', description: '开车→有驾照不敢开' },

  // Memory 76-79: News semantic
  { query: '你关注什么领域的资讯', expectedIndex: 76, type: 'semantic', description: '资讯→科技36kr' },
  { query: '你对 ChatGPT 怎么看', expectedIndex: 77, type: 'semantic', description: 'ChatGPT→关注AI大模型' },
  { query: '你对明星八卦感兴趣吗', expectedIndex: 78, type: 'semantic', description: '明星八卦→不看' },
  { query: '你用什么打发碎片时间', expectedIndex: [79, 40], type: 'semantic', description: '碎片时间→B站/抖音' },

  // ════════════════════════════════════════════════════════════
  // CROSS-DOMAIN / MULTI-MATCH / HARD QUERIES (20 extra, filling to 200)
  // ════════════════════════════════════════════════════════════

  // Multi-memory: daily routine composite
  { query: '我的日常作息是什么样的', expectedIndex: [20, 64, 65, 66, 67], type: 'semantic', description: '日常作息→起床+咖啡+食堂+B站+微博' },
  { query: '描述一下我的一天', expectedIndex: [20, 64, 72, 65, 66], type: 'semantic', description: '一天→起床+咖啡+地铁+食堂+B站' },

  // Negative / exclusion queries
  { query: '我有什么不喜欢吃的', expectedIndex: 51, type: 'semantic', description: '不喜欢吃→香菜' },
  { query: '我不擅长什么', expectedIndex: [75, 47], type: 'semantic', description: '不擅长→开车/小提琴' },

  // Temporal queries
  { query: '我最近在学什么新东西', expectedIndex: [7, 33], type: 'semantic', description: '学新东西→Rust+日语' },
  { query: '我最近花钱买了什么', expectedIndex: [71, 69], type: 'semantic', description: '最近花钱→盲盒/双十一' },

  // Abstract personality queries
  { query: '我的性格特点是什么', expectedIndex: [52, 26, 58], type: 'semantic', description: '性格→怕冷+怕蛇+怕打针' },
  { query: '我是一个怎样的人', expectedIndex: [0, 56, 60], type: 'semantic', description: '怎样的人→工作+童年+梦想' },

  // Cross-domain queries
  { query: '我在网上花多少时间', expectedIndex: [40, 66, 67], type: 'semantic', description: '网上时间→抖音+B站+微博' },
  { query: '我有哪些固定开支', expectedIndex: [11, 68], type: 'semantic', description: '固定开支→房贷+网购' },
  { query: '我都害怕什么', expectedIndex: [26, 58, 52], type: 'semantic', description: '害怕→蛇+打针+冷' },
  { query: '我的社交活动', expectedIndex: [14, 36, 46], type: 'semantic', description: '社交→篮球+羽毛球+演唱会' },
  { query: '我学过哪些技能', expectedIndex: [7, 33, 47], type: 'semantic', description: '技能→Rust+日语+小提琴' },
  { query: '我的饮食偏好', expectedIndex: [17, 51, 48], type: 'semantic', description: '饮食→吃辣+不吃香菜+糖醋排骨' },
  { query: '我有什么经济负担', expectedIndex: [11, 32, 68], type: 'semantic', description: '经济负担→房贷+亏钱+网购' },
  { query: '我对未来有什么规划', expectedIndex: [60, 61, 62, 63], type: 'semantic', description: '未来规划→咖啡店+PMP+攒钱+盖房' },
  { query: '我在字节做什么岗位', expectedIndex: [0, 39], type: 'direct', description: '字节岗位→后端/安全' },
  { query: '和小雨的关系进展', expectedIndex: [1, 12], type: 'direct', description: '小雨→在一起+怀孕' },
  { query: '我坐几号线地铁', expectedIndex: 72, type: 'direct', description: '几号线→2转10' },
  { query: '我在 36kr 上看什么', expectedIndex: 76, type: 'direct', description: '36kr→科技新闻' },

  // ── Additional direct queries to reach 100 ──
  { query: '我的抖音使用时间', expectedIndex: 40, type: 'direct', description: '抖音时间→两小时' },
  { query: '周杰伦的歌我听了多久', expectedIndex: 44, type: 'direct', description: '周杰伦→二十年' },
  { query: '糖醋排骨是我做的吗', expectedIndex: 48, type: 'direct', description: '糖醋排骨→拿手菜' },
  { query: '冬天我愿意出门吗', expectedIndex: 52, type: 'direct', description: '冬天出门→不愿意' },
  { query: '我小时候去河里干嘛', expectedIndex: 56, type: 'direct', description: '河里→摸鱼' },
  { query: '我想开什么店', expectedIndex: 60, type: 'direct', description: '开店→咖啡店' },
  { query: '我早饭前先干嘛', expectedIndex: 64, type: 'direct', description: '早饭前→喝咖啡' },
  { query: '我网购一般花多少', expectedIndex: 68, type: 'direct', description: '网购金额→3000' },
  { query: '我坐地铁转哪条线', expectedIndex: 72, type: 'direct', description: '转线→2转10' },
  { query: '我每天看 36kr 吗', expectedIndex: 76, type: 'direct', description: '36kr→每天看' },
  { query: '五月天的演唱会什么时候去的', expectedIndex: 46, type: 'direct', description: '五月天→上个月' },
  { query: '提拉米苏是我最近学的吗', expectedIndex: 50, type: 'direct', description: '提拉米苏→上周学会' },
  { query: '我去年夏天中暑了吗', expectedIndex: 55, type: 'direct', description: '中暑→去年夏天' },
  { query: 'PMP 什么时候考', expectedIndex: 61, type: 'direct', description: 'PMP→明年' },
  { query: '我通勤要多长时间', expectedIndex: 73, type: 'direct', description: '通勤时间→一个半小时' },

  // ── Additional semantic queries to reach 100 ──
  { query: '我的童年伙伴', expectedIndex: 59, type: 'semantic', description: '童年伙伴→旺财' },
  { query: '我对什么食物反感', expectedIndex: 51, type: 'semantic', description: '食物反感→香菜' },
  { query: '我有什么内容创作经历', expectedIndex: 41, type: 'semantic', description: '内容创作→技术博客' },
  { query: '我的理财经历', expectedIndex: [32, 62], type: 'semantic', description: '理财→炒股亏钱+攒钱目标' },
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
