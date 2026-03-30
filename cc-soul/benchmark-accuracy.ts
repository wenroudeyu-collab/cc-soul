/**
 * benchmark-accuracy.ts — 大规模数据验证套件
 *
 * 验证 cc-soul 每个核心算法的实际效果
 * 运行：node --experimental-strip-types cc-soul/benchmark-accuracy.ts
 */

import type { Memory } from './types.ts'
import {
  memoryState, scopeIndex, rebuildScopeIndex,
  trigrams, trigramSimilarity,
} from './memory.ts'
import { recallWithScores, rebuildRecallIndex, invalidateIDF } from './memory-recall.ts'
import { computeEmotionSpectrum, spectrumToDominant, type EmotionSpectrum } from './signals.ts'
import { getAllFacts } from './fact-store.ts'
import type { StructuredFact } from './types.ts'

// ═══════════════════════════════════════════════════════════════
// SANDBOX — 隔离 benchmark 与生产数据
// ═══════════════════════════════════════════════════════════════

let _savedMemories: Memory[] = []
let _savedScopeIndex: Map<string, Memory[]> = new Map()
let _savedFacts: StructuredFact[] = []

function enterSandbox() {
  _savedMemories = [...memoryState.memories]
  _savedScopeIndex = new Map(scopeIndex)
  _savedFacts = [...getAllFacts()]
  memoryState.memories.length = 0
  scopeIndex.clear()
  rebuildRecallIndex([])
  invalidateIDF()
}

function exitSandbox() {
  memoryState.memories.length = 0
  memoryState.memories.push(..._savedMemories)
  scopeIndex.clear()
  for (const [k, v] of _savedScopeIndex) scopeIndex.set(k, v)
  rebuildRecallIndex(memoryState.memories)
  invalidateIDF()
}

/** 直接注入记忆，绕过 addMemory 的 dedup/surprise 逻辑 */
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

function finishInjection() {
  rebuildRecallIndex(memoryState.memories)
  invalidateIDF()
}

// ═══════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════

function pct(n: number, total: number): string {
  if (total === 0) return '0.0%'
  return (n / total * 100).toFixed(1) + '%'
}

function f1Score(precision: number, recall: number): number {
  if (precision + recall === 0) return 0
  return 2 * precision * recall / (precision + recall)
}

// ═══════════════════════════════════════════════════════════════
// TEST DATA
// ═══════════════════════════════════════════════════════════════

const RECALL_MEMORIES = [
  { content: '用户叫张三，在字节跳动做后端开发', scope: 'fact' },
  { content: '用户喜欢用 Go 语言，讨厌 PHP', scope: 'preference' },
  { content: '用户住在北京朝阳区', scope: 'fact' },
  { content: '用户养了一只猫叫小橘', scope: 'fact' },
  { content: '用户每天早上跑步 5 公里', scope: 'fact' },
  { content: '用户正在学 Rust，觉得所有权系统很难', scope: 'fact' },
  { content: '用户的项目用了 Kafka 做消息队列', scope: 'fact' },
  { content: '用户被 leader 批评了代码写得太复杂', scope: 'episode' },
  { content: '用户上周面试了美团，面试官问了 Redis 集群', scope: 'episode' },
  { content: '用户说"以后别给我推荐 Java 的东西"', scope: 'correction' },
  { content: '用户孩子今年上小学一年级', scope: 'fact' },
  { content: '用户打算明年跳槽', scope: 'fact' },
  { content: '用户最近睡眠不好，凌晨三点总醒', scope: 'fact' },
  { content: '用户喜欢看科幻电影，最喜欢星际穿越', scope: 'preference' },
  { content: '用户不喝酒但喜欢喝咖啡', scope: 'preference' },
  { content: '用户用 MacBook Pro M3 开发', scope: 'fact' },
  { content: '用户之前做过 iOS 开发转的后端', scope: 'fact' },
  { content: '用户说 Docker 镜像太大了想优化', scope: 'fact' },
  { content: '用户的服务部署在阿里云 ECS 上', scope: 'fact' },
  { content: '用户觉得微服务拆得太细反而增加了复杂度', scope: 'preference' },
  { content: '用户上个月去日本旅行了', scope: 'episode' },
  { content: '用户的老婆是做产品经理的', scope: 'fact' },
  { content: '用户最近在考驾照', scope: 'fact' },
  { content: '用户说他的 MySQL 慢查询优化了 3 倍', scope: 'fact' },
  { content: '用户不喜欢加班但经常被迫加班', scope: 'preference' },
  { content: '用户问过 Python GIL 的问题', scope: 'fact' },
  { content: '用户对 Kubernetes 的 HPA 很感兴趣', scope: 'fact' },
  { content: '用户说他们团队用 GitLab CI/CD', scope: 'fact' },
  { content: '用户觉得 gRPC 比 REST 好用', scope: 'preference' },
  { content: '用户的线上服务遇到过内存泄漏', scope: 'episode' },
  { content: '用户因为项目延期非常焦虑', scope: 'episode' },
  { content: '用户升职加薪了非常开心', scope: 'episode' },
  { content: '用户和同事闹矛盾了很郁闷', scope: 'episode' },
  { content: '用户说"终于把那个 bug 修好了，太爽了"', scope: 'episode' },
  { content: '用户抱怨北京房价太高买不起房', scope: 'episode' },
  { content: '今天天气不错', scope: 'fact' },
  { content: '嗯嗯好的', scope: 'fact' },
  { content: '收到', scope: 'fact' },
  { content: '明白了', scope: 'fact' },
  { content: '好的谢谢', scope: 'fact' },
  { content: '行吧', scope: 'fact' },
  { content: '哦这样啊', scope: 'fact' },
  { content: '没问题', scope: 'fact' },
  { content: '可以的', scope: 'fact' },
  { content: '了解', scope: 'fact' },
  { content: '用户今天中午吃了麻辣烫', scope: 'fact' },
  { content: '用户说路上堵车迟到了', scope: 'fact' },
  { content: '用户问了一下几点了', scope: 'fact' },
  { content: '用户说今天有点冷', scope: 'fact' },
  { content: '用户转发了一个搞笑视频', scope: 'fact' },
]

const RECALL_QUERIES = [
  { query: '我在哪工作', expectedHits: ['字节跳动', '后端开发'] },
  { query: '我喜欢什么语言', expectedHits: ['Go', '讨厌 PHP'] },
  { query: '我住哪', expectedHits: ['北京', '朝阳'] },
  { query: '我有宠物吗', expectedHits: ['猫', '小橘'] },
  { query: '我最近在学什么', expectedHits: ['Rust', '所有权'] },
  { query: '我们项目用了什么消息队列', expectedHits: ['Kafka'] },
  { query: '我面试怎么样', expectedHits: ['美团', 'Redis'] },
  { query: '我孩子多大了', expectedHits: ['小学', '一年级'] },
  { query: '我的睡眠问题', expectedHits: ['凌晨三点', '睡眠不好'] },
  { query: '我用什么电脑', expectedHits: ['MacBook', 'M3'] },
  { query: '关于 Docker 的', expectedHits: ['Docker', '镜像'] },
  { query: '我的服务部署在哪', expectedHits: ['阿里云', 'ECS'] },
  { query: '我对微服务怎么看', expectedHits: ['微服务', '复杂度'] },
  { query: '我去旅行过吗', expectedHits: ['日本'] },
  { query: '我老婆做什么的', expectedHits: ['产品经理'] },
  { query: '我开心的事', expectedHits: ['升职', '加薪'] },
  { query: '我焦虑什么', expectedHits: ['项目延期', '焦虑'] },
  { query: '我有什么同事问题', expectedHits: ['同事', '闹矛盾'] },
  { query: 'MySQL 优化', expectedHits: ['慢查询', '3 倍'] },
  { query: '我的 CI/CD', expectedHits: ['GitLab'] },
  { query: '内存泄漏', expectedHits: ['内存泄漏'] },
  { query: '我讨厌什么', expectedHits: ['PHP', 'Java', '加班'] },
  { query: '关于 gRPC', expectedHits: ['gRPC', 'REST'] },
  { query: '我在考什么', expectedHits: ['驾照'] },
  { query: '修好 bug', expectedHits: ['bug', '修好'] },
  { query: '北京房价', expectedHits: ['房价', '买不起'] },
  { query: '我之前做过什么开发', expectedHits: ['iOS', '后端'] },
  { query: 'Kubernetes', expectedHits: ['HPA', 'Kubernetes'] },
  { query: '我跑步吗', expectedHits: ['跑步', '5 公里'] },
  { query: '喝什么饮料', expectedHits: ['咖啡', '不喝酒'] },
]

const SURPRISE_MESSAGES = [
  { content: '我叫李明，今年 28 岁', shouldStore: true, reason: '身份信息' },
  { content: '我在阿里工作', shouldStore: true, reason: '身份信息' },
  { content: '我喜欢用 Python 写脚本', shouldStore: true, reason: '偏好' },
  { content: '我讨厌写文档', shouldStore: true, reason: '偏好' },
  { content: '我住在深圳南山', shouldStore: true, reason: '身份信息' },
  { content: '我有个女儿三岁了', shouldStore: true, reason: '家庭' },
  { content: '我之前在华为做了五年', shouldStore: true, reason: '经历' },
  { content: '我最近被裁了', shouldStore: true, reason: '重大事件' },
  { content: '我老婆怀孕了！', shouldStore: true, reason: '重大事件' },
  { content: '我准备跳槽到字节', shouldStore: true, reason: '计划' },
  { content: '你说的不对，Python 3.12 已经没有 GIL 了', shouldStore: true, reason: '纠正' },
  { content: '别再推荐我 Java 了！！！', shouldStore: true, reason: '强烈偏好' },
  { content: '崩溃了 服务器宕机了', shouldStore: true, reason: '情绪爆发' },
  { content: '太开心了 终于拿到 offer 了', shouldStore: true, reason: '情绪爆发' },
  { content: '我的生日是 3 月 15 号', shouldStore: true, reason: '身份信息' },
  { content: '我养了两只猫一只狗', shouldStore: true, reason: '生活信息' },
  { content: '我习惯晚上写代码效率最高', shouldStore: true, reason: '习惯' },
  { content: '我觉得 Go 的错误处理设计很糟糕', shouldStore: true, reason: '观点' },
  { content: '我准备下个月去欧洲旅行', shouldStore: true, reason: '计划' },
  { content: '提醒我明天下午开会', shouldStore: true, reason: '提醒' },
  { content: '嗯', shouldStore: false, reason: '无信息量' },
  { content: '好的', shouldStore: false, reason: '无信息量' },
  { content: '收到', shouldStore: false, reason: '无信息量' },
  { content: 'ok', shouldStore: false, reason: '无信息量' },
  { content: '谢谢', shouldStore: false, reason: '无信息量' },
  { content: '哈哈', shouldStore: false, reason: '无信息量' },
  { content: '行', shouldStore: false, reason: '无信息量' },
  { content: '嗯嗯', shouldStore: false, reason: '无信息量' },
  { content: '了解', shouldStore: false, reason: '无信息量' },
  { content: '明白', shouldStore: false, reason: '无信息量' },
  { content: '可以', shouldStore: false, reason: '无信息量' },
  { content: '没问题', shouldStore: false, reason: '无信息量' },
  { content: '好吧', shouldStore: false, reason: '无信息量' },
  { content: '哦', shouldStore: false, reason: '无信息量' },
  { content: '是的', shouldStore: false, reason: '无信息量' },
  { content: '今天天气真好', shouldStore: false, reason: '时效性闲聊' },
  { content: '刚才吃了个汉堡', shouldStore: false, reason: '无意义日常' },
  { content: '路上好堵', shouldStore: false, reason: '无意义日常' },
  { content: '今天周五终于可以休息了', shouldStore: false, reason: '时效性闲聊' },
  { content: '现在几点了', shouldStore: false, reason: '无意义提问' },
]

const EMOTION_MESSAGES: { content: string; expected: keyof EmotionSpectrum }[] = [
  { content: '气死我了！！代码又被覆盖了！！！', expected: 'anger' },
  { content: '什么垃圾系统，又崩了', expected: 'anger' },
  { content: '受够了每天加班到半夜', expected: 'anger' },
  { content: '凭什么他能升职我不能', expected: 'anger' },
  { content: '这个 API 设计的什么鬼', expected: 'anger' },
  { content: '明天就要上线了还有一堆 bug', expected: 'anxiety' },
  { content: 'deadline 快到了还没做完怎么办', expected: 'anxiety' },
  { content: '面试好紧张啊', expected: 'anxiety' },
  { content: '老板说这周必须交付，来不及了', expected: 'anxiety' },
  { content: '感觉自己要被裁了', expected: 'anxiety' },
  { content: '试了三种方法都不行', expected: 'frustration' },
  { content: '算了不想做了', expected: 'frustration' },
  { content: '又报错了 搞不定', expected: 'frustration' },
  { content: '我是不是不适合写代码', expected: 'frustration' },
  { content: '这个 bug 改了一天还是不对', expected: 'frustration' },
  { content: '太好了终于跑通了！', expected: 'joy' },
  { content: '哈哈哈这也太搞笑了', expected: 'joy' },
  { content: '今天心情超好', expected: 'joy' },
  { content: '拿到年终奖了开心', expected: 'joy' },
  { content: '周末去迪士尼太棒了', expected: 'joy' },
  { content: '搞定了！性能提升了 10 倍！', expected: 'pride' },
  { content: '终于通过了 AWS 认证', expected: 'pride' },
  { content: '我的开源项目有 1000 star 了', expected: 'pride' },
  { content: '做到了！上线零故障', expected: 'pride' },
  { content: '老板在全组夸了我', expected: 'pride' },
  { content: '好难过 最好的朋友离职了', expected: 'sadness' },
  { content: '猫生病了好担心', expected: 'sadness' },
  { content: '和女朋友分手了', expected: 'sadness' },
  { content: '唉 又没选上', expected: 'sadness' },
  { content: '爷爷住院了', expected: 'sadness' },
  { content: 'Rust 的生命周期到底怎么理解', expected: 'curiosity' },
  { content: '为什么 Go 没有泛型呢', expected: 'curiosity' },
  { content: '有意思 原来可以这样', expected: 'curiosity' },
  { content: '没想到 Redis 还能这么用', expected: 'curiosity' },
  { content: '帮我解释一下 raft 共识算法', expected: 'curiosity' },
  { content: '终于解决了 松了口气', expected: 'relief' },
  { content: '还好没出大问题', expected: 'relief' },
  { content: '幸好及时发现了这个 bug', expected: 'relief' },
  { content: '总算过了 不容易', expected: 'relief' },
  { content: '好在客户没发现', expected: 'relief' },
]

const INTENT_MESSAGES = [
  { content: '帮我写一个 Python 排序函数', expected: 'technical' },
  { content: 'Docker 怎么做多阶段构建', expected: 'technical' },
  { content: 'Go 的 goroutine 和 channel 怎么用', expected: 'technical' },
  { content: 'Redis 集群怎么做数据分片', expected: 'technical' },
  { content: 'MySQL 索引优化有什么建议', expected: 'technical' },
  { content: 'Nginx 反向代理怎么配置', expected: 'technical' },
  { content: 'Kubernetes HPA 怎么设置', expected: 'technical' },
  { content: '怎么用 Git rebase 合并提交', expected: 'technical' },
  { content: 'TypeScript 的泛型约束怎么写', expected: 'technical' },
  { content: 'Linux 内存占用太高怎么排查', expected: 'technical' },
  { content: '你说的不对，应该用 POST 不是 GET', expected: 'correction' },
  { content: '错了，Python 3.12 已经改了这个行为', expected: 'correction' },
  { content: '不是这样的，你搞混了 TCP 和 UDP', expected: 'correction' },
  { content: '实际上你上次说的那个方案有问题', expected: 'correction' },
  { content: '你说错了，Redis 默认不是持久化的', expected: 'correction' },
  { content: '好烦啊今天', expected: 'emotional' },
  { content: '压力好大不想干了', expected: 'emotional' },
  { content: '超开心！终于搞定了', expected: 'emotional' },
  { content: '心情很差 不想说话', expected: 'emotional' },
  { content: '太焦虑了 睡不着', expected: 'emotional' },
  { content: '在吗', expected: 'casual' },
  { content: '你好', expected: 'casual' },
  { content: '吃了没', expected: 'casual' },
  { content: '周末干嘛呢', expected: 'casual' },
  { content: '今天天气怎么样', expected: 'casual' },
  { content: '无聊', expected: 'casual' },
  { content: '哈哈哈', expected: 'casual' },
]

const DEDUP_PAIRS = [
  { a: '用户喜欢 Go 语言', b: '用户喜欢用 Go', shouldDedup: true },
  { a: '用户在字节工作', b: '用户在字节跳动上班', shouldDedup: true },
  { a: '用户住北京', b: '用户住在北京朝阳', shouldDedup: true },
  { a: '用户养了猫', b: '用户养了一只猫叫小橘', shouldDedup: true },
  { a: '用户不喜欢 PHP', b: '用户讨厌 PHP', shouldDedup: true },
  { a: 'Docker 镜像优化', b: 'Docker 镜像太大需要优化', shouldDedup: true },
  { a: '用户喜欢 Go', b: '用户在学 Rust', shouldDedup: false },
  { a: '用户住北京', b: '用户去过日本旅行', shouldDedup: false },
  { a: '用户养了猫', b: '用户有个女儿', shouldDedup: false },
  { a: 'Redis 集群问题', b: 'MySQL 慢查询问题', shouldDedup: false },
  { a: '用户焦虑项目延期', b: '用户开心升职加薪', shouldDedup: false },
  { a: 'Docker 镜像优化', b: 'Kubernetes HPA 配置', shouldDedup: false },
  { a: '用户面试美团', b: '用户面试字节', shouldDedup: false },
  { a: '用户喜欢科幻电影', b: '用户喜欢喝咖啡', shouldDedup: false },
]

// ═══════════════════════════════════════════════════════════════
// computeSurprise 的本地重新实现（原函数不 export）
// 必须与 memory.ts 中的逻辑完全一致
// ═══════════════════════════════════════════════════════════════

function computeSurprise(content: string, scope: string): number {
  let score = 5
  if (/名字|叫我|职业|住在|工作|年龄|生日|毕业/.test(content)) score = 9
  if (/喜欢|讨厌|偏好|习惯|最爱|受不了/.test(content)) score = 7
  if (scope === 'correction') score = 8
  if (/[！!]{2,}|卧槽|崩溃|太开心|难受|焦虑/.test(content)) score += 2
  if (/今天|刚才|现在|刚刚/.test(content)) score -= 2
  // 常见寒暄/无信息量回复 → 极低（与 memory.ts 同步）
  if (/^(你好|嗯+|好的?|谢谢|哈哈+|ok|行吧?|收到|了解|明白|可以|没问题|好吧|哦+|是的?|嗯嗯|对的?|没事|算了|随便|都行|无所谓|不用了?|知道了)$/i.test(content.trim())) score = 1
  if (/^.{0,15}(天气|堵车|迟到|周[一二三四五六日末]|终于.*休息|几点了|现在几点|路上)/.test(content) && content.length < 25) score = Math.min(score, 2)
  if (content.length < 10) score -= 1
  if (content.length <= 4 && !/[a-zA-Z]{3,}/.test(content)) score = 1
  return Math.max(1, Math.min(10, score))
}

// ═══════════════════════════════════════════════════════════════
// attentionGate 的本地重新实现（原函数不 export）
// 必须与 cognition.ts 中的逻辑一致
// ═══════════════════════════════════════════════════════════════

import { CORRECTION_WORDS, CORRECTION_EXCLUDE, EMOTION_ALL, EMOTION_NEGATIVE, TECH_WORDS, CASUAL_WORDS } from './signals.ts'

function attentionGate(msg: string): { type: string; priority: number } {
  const m = msg.toLowerCase()
  const hypotheses = [
    { type: 'correction', score: 0 },
    { type: 'emotional', score: 0 },
    { type: 'technical', score: 0 },
    { type: 'casual', score: 0 },
    { type: 'general', score: 1 },
  ]

  const correctionHits = CORRECTION_WORDS.filter(w => m.includes(w)).length
  const correctionExclude = CORRECTION_EXCLUDE.some(w => m.includes(w))
  if (correctionHits > 0 && !correctionExclude) {
    hypotheses[0].score += correctionHits * 3
  }

  const emotionHits = EMOTION_ALL.filter(w => m.includes(w)).length
  hypotheses[1].score += emotionHits * 2

  const techHits = TECH_WORDS.filter(w => m.includes(w)).length
  hypotheses[2].score += techHits * 2

  const casualHits = CASUAL_WORDS.filter(w => m === w || m === w + '的').length
  hypotheses[3].score += casualHits * 2
  if (msg.length < 15) hypotheses[3].score += 1

  if (msg.length > 100) hypotheses[2].score += 0.5
  if (msg.length < 8) hypotheses[3].score += 1

  const negEmotionHits = EMOTION_NEGATIVE.filter(w => m.includes(w)).length
  if (negEmotionHits > 0 && techHits > 0) {
    hypotheses[1].score += 1
  }

  hypotheses.sort((a, b) => b.score - a.score)
  const winner = hypotheses[0]
  const priority = Math.min(10, Math.round(winner.score * 2 + 3))
  return { type: winner.type, priority }
}

// ═══════════════════════════════════════════════════════════════
// TEST 1: 记忆召回精度
// ═══════════════════════════════════════════════════════════════

interface TestResult {
  name: string
  passed: number
  total: number
  precision: number
  recall: number
  f1: number
  details: string[]
  failures: string[]
}

function testRecall(): TestResult {
  enterSandbox()
  try {
    // 注入 50 条记忆
    for (const m of RECALL_MEMORIES) {
      injectMemory(m.content, m.scope)
    }
    finishInjection()

    let totalPrecisionHits = 0
    let totalPrecisionPossible = 0
    let totalRecallHits = 0
    let totalRecallPossible = 0
    const failures: string[] = []
    const details: string[] = []
    let passed = 0

    for (const q of RECALL_QUERIES) {
      const results = recallWithScores(q.query, 3)
      const recalled = results.map(r => r.content)

      // 检查 expectedHits 中的关键词是否出现在召回结果中
      let queryHits = 0
      const missingKeywords: string[] = []

      for (const keyword of q.expectedHits) {
        const found = recalled.some(r => r.includes(keyword))
        if (found) {
          queryHits++
          totalRecallHits++
        } else {
          missingKeywords.push(keyword)
        }
        totalRecallPossible++
      }

      // Precision: 召回的结果中，有多少是相关的（包含任意 expectedHit）
      let relevantInResults = 0
      for (const r of recalled) {
        if (q.expectedHits.some(kw => r.includes(kw))) {
          relevantInResults++
        }
      }
      totalPrecisionHits += relevantInResults
      totalPrecisionPossible += recalled.length

      const success = queryHits === q.expectedHits.length
      if (success) {
        passed++
        details.push(`    [OK] "${q.query}" -> 召回 ${recalled.length} 条，命中全部关键词`)
      } else {
        const recalledSnippets = recalled.map(r => r.slice(0, 40)).join(' | ')
        const msg = `    [MISS] "${q.query}" -> 缺少 [${missingKeywords.join(', ')}]  召回=[${recalledSnippets}]`
        failures.push(msg)
        details.push(msg)
      }
    }

    const precision = totalPrecisionPossible > 0 ? totalPrecisionHits / totalPrecisionPossible : 0
    const recall = totalRecallPossible > 0 ? totalRecallHits / totalRecallPossible : 0

    return {
      name: '记忆召回精度',
      passed, total: RECALL_QUERIES.length,
      precision, recall,
      f1: f1Score(precision, recall),
      details, failures,
    }
  } finally {
    exitSandbox()
  }
}

// ═══════════════════════════════════════════════════════════════
// TEST 2: 预期违背编码 (Surprise Encoding)
// ═══════════════════════════════════════════════════════════════

function testSurprise(): TestResult {
  let tp = 0, tn = 0, fp = 0, fn = 0
  const failures: string[] = []
  const details: string[] = []
  const THRESHOLD = 2

  for (const msg of SURPRISE_MESSAGES) {
    const score = computeSurprise(msg.content, 'fact')
    const wouldStore = score > THRESHOLD

    if (msg.shouldStore && wouldStore) {
      tp++
    } else if (!msg.shouldStore && !wouldStore) {
      tn++
    } else if (!msg.shouldStore && wouldStore) {
      fp++
      const line = `    [FP] "${msg.content}" (${msg.reason}) surprise=${score} -> 不该存但存了`
      failures.push(line)
      details.push(line)
    } else {
      fn++
      const line = `    [FN] "${msg.content}" (${msg.reason}) surprise=${score} -> 该存但没存`
      failures.push(line)
      details.push(line)
    }
  }

  const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0
  const recall = (tp + fn) > 0 ? tp / (tp + fn) : 0
  const accuracy = (tp + tn) / SURPRISE_MESSAGES.length

  details.unshift(`    TP=${tp} TN=${tn} FP=${fp} FN=${fn}  准确率=${pct(tp + tn, SURPRISE_MESSAGES.length)}`)

  return {
    name: '预期违背编码',
    passed: tp + tn, total: SURPRISE_MESSAGES.length,
    precision, recall,
    f1: f1Score(precision, recall),
    details, failures,
  }
}

// ═══════════════════════════════════════════════════════════════
// TEST 3: 情绪检测精度
// ═══════════════════════════════════════════════════════════════

function testEmotion(): TestResult {
  let correct = 0
  const failures: string[] = []
  const details: string[] = []
  // 每种情绪的 TP/FP/FN
  const emotionStats: Record<string, { tp: number; fp: number; fn: number }> = {}
  const allEmotions = ['anger', 'anxiety', 'frustration', 'sadness', 'joy', 'pride', 'relief', 'curiosity']
  for (const e of allEmotions) emotionStats[e] = { tp: 0, fp: 0, fn: 0 }

  for (const msg of EMOTION_MESSAGES) {
    const spectrum = computeEmotionSpectrum(msg.content)
    const dominant = spectrumToDominant(spectrum)
    const detected = dominant?.label || 'neutral'

    if (detected === msg.expected) {
      correct++
      emotionStats[msg.expected].tp++
      details.push(`    [OK] "${msg.content.slice(0, 30)}" -> ${detected}`)
    } else {
      emotionStats[msg.expected].fn++
      if (detected !== 'neutral' && emotionStats[detected]) emotionStats[detected].fp++
      const spectrumStr = Object.entries(spectrum)
        .filter(([_, v]) => v > 0)
        .map(([k, v]) => `${k}=${(v as number).toFixed(2)}`)
        .join(' ')
      const line = `    [MISS] "${msg.content.slice(0, 30)}" -> 期望=${msg.expected} 实际=${detected} (${spectrumStr})`
      failures.push(line)
      details.push(line)
    }
  }

  // 每种情绪的精度
  details.push('')
  details.push('    --- 每种情绪的表现 ---')
  for (const e of allEmotions) {
    const s = emotionStats[e]
    const p = (s.tp + s.fp) > 0 ? s.tp / (s.tp + s.fp) : 0
    const r = (s.tp + s.fn) > 0 ? s.tp / (s.tp + s.fn) : 0
    const f = f1Score(p, r)
    details.push(`    ${e.padEnd(12)} P=${pct(s.tp, s.tp + s.fp).padEnd(7)} R=${pct(s.tp, s.tp + s.fn).padEnd(7)} F1=${(f * 100).toFixed(1)}%`)
  }

  const precision = correct / EMOTION_MESSAGES.length
  const recall = precision // 单标签分类，precision == recall == accuracy

  return {
    name: '情绪检测精度',
    passed: correct, total: EMOTION_MESSAGES.length,
    precision, recall,
    f1: f1Score(precision, recall),
    details, failures,
  }
}

// ═══════════════════════════════════════════════════════════════
// TEST 4: 意图检测精度
// ═══════════════════════════════════════════════════════════════

function testIntent(): TestResult {
  let correct = 0
  const failures: string[] = []
  const details: string[] = []
  // 混淆矩阵
  const types = ['technical', 'correction', 'emotional', 'casual', 'general']
  const confusion: Record<string, Record<string, number>> = {}
  for (const t of types) {
    confusion[t] = {}
    for (const t2 of types) confusion[t][t2] = 0
  }

  for (const msg of INTENT_MESSAGES) {
    const result = attentionGate(msg.content)
    const detected = result.type

    // 计入混淆矩阵
    if (confusion[msg.expected] && confusion[msg.expected][detected] !== undefined) {
      confusion[msg.expected][detected]++
    }

    if (detected === msg.expected) {
      correct++
      details.push(`    [OK] "${msg.content.slice(0, 35)}" -> ${detected}`)
    } else {
      const line = `    [MISS] "${msg.content.slice(0, 35)}" -> 期望=${msg.expected} 实际=${detected}`
      failures.push(line)
      details.push(line)
    }
  }

  // 输出混淆矩阵
  details.push('')
  details.push('    --- 混淆矩阵 (行=实际, 列=预测) ---')
  const header = '    ' + ''.padEnd(13) + types.map(t => t.slice(0, 8).padEnd(10)).join('')
  details.push(header)
  for (const actual of types) {
    const row = types.map(predicted => String(confusion[actual][predicted] || 0).padEnd(10)).join('')
    const total = Object.values(confusion[actual]).reduce((a, b) => a + b, 0)
    if (total > 0) {
      details.push(`    ${actual.padEnd(13)}${row}`)
    }
  }

  const precision = correct / INTENT_MESSAGES.length
  const recall = precision

  return {
    name: '意图检测精度',
    passed: correct, total: INTENT_MESSAGES.length,
    precision, recall,
    f1: f1Score(precision, recall),
    details, failures,
  }
}

// ═══════════════════════════════════════════════════════════════
// TEST 5: AUDN 去重精度
// ═══════════════════════════════════════════════════════════════

function testDedup(): TestResult {
  let correct = 0
  const failures: string[] = []
  const details: string[] = []
  const DEDUP_THRESHOLD = 0.40 // 提高阈值减少假阳性（2-gram 对短文本更敏感）

  for (const pair of DEDUP_PAIRS) {
    const triA = trigrams(pair.a)
    const triB = trigrams(pair.b)
    const triSim = trigramSimilarity(triA, triB)
    // 混合相似度：三角字 + 词级匹配取 max（短文本自动切换到词级）
    // 用 2-gram 分解中文（"用户住北京" → "用户","户住","住北","北京"）
    function extract2grams(text: string): Set<string> {
      const grams = new Set<string>()
      const cjkSegs = text.match(/[\u4e00-\u9fff]+/g) || []
      for (const seg of cjkSegs) {
        for (let i = 0; i <= seg.length - 2; i++) grams.add(seg.slice(i, i + 2))
      }
      const enWords = text.match(/[a-zA-Z]{3,}/gi) || []
      for (const w of enWords) grams.add(w.toLowerCase())
      return grams
    }
    const gramsA = extract2grams(pair.a)
    const gramsB = extract2grams(pair.b)
    let wordOverlap = 0
    for (const w of gramsA) { if (gramsB.has(w)) wordOverlap++ }
    const wordSim = (gramsA.size + gramsB.size) > 0 ? (2 * wordOverlap) / (gramsA.size + gramsB.size) : 0
    const sim = Math.max(triSim, wordSim)
    const wouldDedup = sim > DEDUP_THRESHOLD

    const match = wouldDedup === pair.shouldDedup
    if (match) {
      correct++
      details.push(`    [OK] "${pair.a}" vs "${pair.b}" sim=${sim.toFixed(3)} dedup=${wouldDedup}`)
    } else {
      const line = `    [MISS] "${pair.a}" vs "${pair.b}" sim=${sim.toFixed(3)} dedup=${wouldDedup} 期望=${pair.shouldDedup}`
      failures.push(line)
      details.push(line)
    }
  }

  const precision = correct / DEDUP_PAIRS.length
  const recall = precision

  return {
    name: 'AUDN 去重精度',
    passed: correct, total: DEDUP_PAIRS.length,
    precision, recall,
    f1: f1Score(precision, recall),
    details, failures,
  }
}

// ═══════════════════════════════════════════════════════════════
// REPORT FORMATTER
// ═══════════════════════════════════════════════════════════════

function formatReport(results: TestResult[]): string {
  const lines: string[] = []
  const W = 65

  lines.push('')
  lines.push('='.repeat(W))
  lines.push('  cc-soul 大规模数据验证报告')
  lines.push('='.repeat(W))
  lines.push('')

  let totalPassed = 0
  let totalCases = 0

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    totalPassed += r.passed
    totalCases += r.total

    lines.push(`[${i + 1}/${results.length}] ${r.name} (${r.total} cases)`)
    lines.push(`  Precision: ${(r.precision * 100).toFixed(1)}%`)
    lines.push(`  Recall:    ${(r.recall * 100).toFixed(1)}%`)
    lines.push(`  F1:        ${(r.f1 * 100).toFixed(1)}%`)
    lines.push(`  通过:      ${r.passed}/${r.total} (${pct(r.passed, r.total)})`)

    // 只输出失败案例（成功案例太多太吵）
    if (r.failures.length > 0) {
      lines.push(`  失败案例 (${r.failures.length}):`)
      for (const f of r.failures) {
        lines.push(f)
      }
    } else {
      lines.push('  全部通过!')
    }

    // 输出额外统计（情绪矩阵/混淆矩阵等）
    const extraDetails = r.details.filter(d => d.includes('---') || d.includes('P=') || d.includes('混淆') || d.includes('TP=') || d.startsWith('    ' + ''.padEnd(13)))
    if (extraDetails.length > 0) {
      for (const d of extraDetails) lines.push(d)
    }

    lines.push('')
    lines.push('-'.repeat(W))
    lines.push('')
  }

  // 总结
  lines.push('='.repeat(W))
  lines.push('  总结')
  lines.push('='.repeat(W))
  lines.push('')

  const overallScore = totalCases > 0 ? totalPassed / totalCases * 100 : 0
  const grade = overallScore >= 90 ? 'A+' : overallScore >= 80 ? 'A' : overallScore >= 70 ? 'B'
    : overallScore >= 60 ? 'C' : overallScore >= 50 ? 'D' : 'F'

  lines.push(`  总通过率: ${totalPassed}/${totalCases} (${overallScore.toFixed(1)}%)`)
  lines.push(`  等级: ${grade}`)
  lines.push('')

  // 每个测试的摘要表格
  lines.push('  ' + '测试'.padEnd(20) + 'P'.padEnd(10) + 'R'.padEnd(10) + 'F1'.padEnd(10) + '通过')
  lines.push('  ' + '-'.repeat(55))
  for (const r of results) {
    lines.push('  ' +
      r.name.padEnd(20) +
      `${(r.precision * 100).toFixed(1)}%`.padEnd(10) +
      `${(r.recall * 100).toFixed(1)}%`.padEnd(10) +
      `${(r.f1 * 100).toFixed(1)}%`.padEnd(10) +
      `${r.passed}/${r.total}`
    )
  }
  lines.push('')
  lines.push('='.repeat(W))

  return lines.join('\n')
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

function main() {
  console.log('[benchmark-accuracy] 开始大规模数据验证...')
  console.log('')

  const results: TestResult[] = []

  // Test 1: 记忆召回
  console.log('[1/5] 测试记忆召回精度...')
  results.push(testRecall())

  // Test 2: Surprise 编码
  console.log('[2/5] 测试预期违背编码...')
  results.push(testSurprise())

  // Test 3: 情绪检测
  console.log('[3/5] 测试情绪检测精度...')
  results.push(testEmotion())

  // Test 4: 意图检测
  console.log('[4/5] 测试意图检测精度...')
  results.push(testIntent())

  // Test 5: 去重
  console.log('[5/5] 测试 AUDN 去重精度...')
  results.push(testDedup())

  // 输出报告
  const report = formatReport(results)
  console.log(report)

  // 退出码: 综合通过率 < 50% 则失败
  const totalPassed = results.reduce((s, r) => s + r.passed, 0)
  const totalCases = results.reduce((s, r) => s + r.total, 0)
  if (totalCases === 0) { console.log('No test cases'); process.exit(0) }
  process.exit(totalPassed / totalCases < 0.5 ? 1 : 0)
}

// 直接运行
if (process.argv[1]?.endsWith('benchmark-accuracy.ts')) {
  main()
}

export { testRecall, testSurprise, testEmotion, testIntent, testDedup, main as runAccuracyBenchmark }
