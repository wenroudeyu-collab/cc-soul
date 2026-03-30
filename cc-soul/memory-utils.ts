/**
 * memory-utils.ts — Pure utility functions extracted from memory.ts
 * Trigrams, synonyms, time decay, compression, poisoning detection, etc.
 */

import type { Memory } from './types.ts'
import { getParam } from './auto-tune.ts'

// ═══════════════════════════════════════════════════════════════════════════════
// Constants — now backed by auto-tune, with legacy const for backward compat
// ═══════════════════════════════════════════════════════════════════════════════

export function getMaxMemories(): number { return getParam('memory.max_memories') }
export function getMaxHistory(): number { return getParam('memory.max_history') }
export function getInjectHistory(): number { return getParam('memory.inject_history') }
// 保留旧的 const 作为向后兼容
export const MAX_MEMORIES = 10000
export const MAX_HISTORY = 100      // 保留最近 100 轮完整历史
export const INJECT_HISTORY = 30    // 注入最近 30 轮到 prompt（token 限制）

// ═══════════════════════════════════════════════════════════════════════════════
// Fisher-Yates Shuffle
// ═══════════════════════════════════════════════════════════════════════════════

/** Fisher-Yates shuffle — unbiased random ordering */
export function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

// ═══════════════════════════════════════════════════════════════════════════════
// Trigram Fuzzy Matching — fills the gap between exact-tag and TF-IDF
// ═══════════════════════════════════════════════════════════════════════════════

/** Extract character trigrams from text (works for CJK + Latin) — LRU cached (max 2000, batch evict 20%) */
const _trigramCache = new Map<string, { set: Set<string>; ts: number }>()
export function trigrams(text: string): Set<string> {
  const s = text.toLowerCase().replace(/\s+/g, ' ').trim()
  const cached = _trigramCache.get(s)
  if (cached) { cached.ts = Date.now(); return cached.set }
  const set = new Set<string>()
  for (let i = 0; i <= s.length - 3; i++) {
    set.add(s.slice(i, i + 3))
  }
  if (_trigramCache.size >= 2000) {
    // Batch evict 20% (400 entries) — sorted by oldest access time
    const entries = [..._trigramCache.entries()].sort((a, b) => a[1].ts - b[1].ts)
    const evictCount = Math.ceil(_trigramCache.size * 0.2)
    for (let i = 0; i < evictCount && i < entries.length; i++) {
      _trigramCache.delete(entries[i][0])
    }
  }
  _trigramCache.set(s, { set, ts: Date.now() })
  return set
}

/**
 * 多粒度 n-gram 分词（CJK 2-4gram + Latin 3gram）
 * 比纯 trigram 更适合中文：
 * - "机器学习算法" → ["机器", "器学", "学习", "习算", "算法", "机器学", "器学习", "学习算", "习算法", "机器学习", "器学习算", "学习算法"]
 * - English words use standard trigrams
 */
const _ngramCache = new Map<string, { set: Set<string>; ts: number }>()
export function multiGramTokenize(text: string): Set<string> {
  const s = text.toLowerCase().replace(/\s+/g, ' ').trim()
  const cached = _ngramCache.get(s)
  if (cached) { cached.ts = Date.now(); return cached.set }

  const set = new Set<string>()

  // CJK segments: extract 2-gram, 3-gram, 4-gram
  const cjkSegs = s.match(/[\u4e00-\u9fff]+/g) || []
  for (const seg of cjkSegs) {
    for (let n = 2; n <= Math.min(4, seg.length); n++) {
      for (let i = 0; i <= seg.length - n; i++) {
        set.add(seg.slice(i, i + n))
      }
    }
  }

  // Latin: standard trigrams
  const latinSegs = s.match(/[a-z]+/g) || []
  for (const seg of latinSegs) {
    if (seg.length < 3) continue
    for (let i = 0; i <= seg.length - 3; i++) {
      set.add(seg.slice(i, i + 3))
    }
  }

  // Cache management (same as trigrams cache)
  const maxCache = 2000
  if (_ngramCache.size >= maxCache) {
    const entries = [..._ngramCache.entries()].sort((a, b) => a[1].ts - b[1].ts)
    const evictCount = Math.floor(maxCache * 0.2)
    for (let i = 0; i < evictCount && i < entries.length; i++) {
      _ngramCache.delete(entries[i][0])
    }
  }
  _ngramCache.set(s, { set, ts: Date.now() })
  return set
}

/** Jaccard similarity between two trigram sets: |A∩B| / |A∪B| — supports optional IDF weighting */
export function trigramSimilarity(a: Set<string>, b: Set<string>, idf?: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0

  // IDF-weighted Jaccard when idf map provided
  if (idf && idf.size > 0) {
    let intersection = 0, union = 0
    const all = new Set([...a, ...b])
    for (const t of all) {
      const w = idf.get(t) || 1.0
      const inA = a.has(t) ? 1 : 0
      const inB = b.has(t) ? 1 : 0
      intersection += Math.min(inA, inB) * w
      union += Math.max(inA, inB) * w
    }
    return union > 0 ? intersection / union : 0
  }

  // Plain Jaccard (original behavior when no idf)
  let intersection = 0
  for (const t of a) {
    if (b.has(t)) intersection++
  }
  const union = a.size + b.size - intersection
  return union > 0 ? intersection / union : 0
}

/**
 * 词级语义匹配：专门处理短文本去重（三角字对短文本不灵）
 * "用户住北京" vs "用户住在北京朝阳" → 词级重叠 = {"住":1, "北京":1} / total = 高
 * 补充 trigramSimilarity 对短文本的不足
 */
export function wordOverlapSimilarity(textA: string, textB: string): number {
  const wordsA = new Set((textA.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}/gi) || []).map(w => w.toLowerCase()))
  const wordsB = new Set((textB.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}/gi) || []).map(w => w.toLowerCase()))
  if (wordsA.size === 0 || wordsB.size === 0) return 0
  let overlap = 0
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++
  }
  // Dice coefficient: 2*|A∩B| / (|A| + |B|) — 比 Jaccard 对短文本更友好
  return (2 * overlap) / (wordsA.size + wordsB.size)
}

/** 混合相似度：三角字 + 词级匹配取 max（短文本自动切换到词级） */
export function hybridSimilarity(textA: string, textB: string): number {
  const triSim = trigramSimilarity(trigrams(textA), trigrams(textB))
  const wordSim = wordOverlapSimilarity(textA, textB)
  return Math.max(triSim, wordSim)
}

/** Build IDF map from a trigram corpus: trigram → log(N / (1 + df)) */
export function buildTrigramIDF(allTrigrams: Set<string>[]): Map<string, number> {
  const df = new Map<string, number>()
  for (const tSet of allTrigrams) {
    for (const t of tSet) {
      df.set(t, (df.get(t) || 0) + 1)
    }
  }
  const N = allTrigrams.length || 1
  const idf = new Map<string, number>()
  for (const [tri, count] of df) {
    idf.set(tri, Math.log(N / (1 + count)))
  }
  return idf
}

// ═══════════════════════════════════════════════════════════════════════════════
// Synonym Map — lightweight semantic expansion for tag matching
// ═══════════════════════════════════════════════════════════════════════════════

export const SYNONYM_MAP: Record<string, string[]> = {
  // Chinese synonyms
  '二进制': ['binary', 'mach-o', 'elf', '可执行文件', '逆向'],
  '逆向': ['reverse', '反编译', 'ida', 'frida', 'hook', '破解'],
  '代码': ['code', '函数', '脚本', 'script', '程序'],
  '部署': ['deploy', '上线', '发布', 'release', '服务器'],
  '数据库': ['database', 'sql', 'mysql', 'redis', 'mongodb', 'db'],
  '性能': ['performance', '优化', '速度', '延迟', 'latency'],
  '错误': ['error', 'bug', 'crash', '报错', '异常', 'exception'],
  '图片': ['image', 'ocr', '识别', '照片', 'screenshot', '截图'],
  '调试': ['debug', 'breakpoint', 'lldb', 'gdb', '断点'],
  '网络': ['network', 'http', 'tcp', 'socket', '请求', 'request'],
  '内存': ['memory', '泄漏', 'leak', 'malloc', '堆', 'heap'],
  '线程': ['thread', '并发', 'concurrent', '锁', 'lock', 'async'],
  // English synonyms
  'binary': ['二进制', 'mach-o', 'executable', 'elf'],
  'hook': ['frida', '拦截', 'intercept', 'swizzle'],
  'debug': ['调试', 'breakpoint', 'lldb', 'gdb'],
  'api': ['接口', 'endpoint', 'rest', 'http'],
  'deploy': ['部署', '上线', '发布', 'release'],
  'performance': ['性能', '优化', 'optimize', 'latency'],
  'error': ['错误', 'bug', 'crash', 'exception', '异常'],
  'memory': ['内存', 'leak', 'malloc', 'heap'],
  'thread': ['线程', '并发', 'concurrent', 'lock'],
  'python': ['py', 'pip', 'flask', 'django', '脚本'],
  'swift': ['swiftui', 'ios', 'xcode', 'objc', 'objective-c'],
  'test': ['测试', 'unittest', 'pytest', 'vitest', '单元测试'],
}

/** 中文高频停用词（出现在几乎所有文本中，对区分度无贡献） */
export const CJK_STOPWORDS = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们',
  '这', '那', '有', '和', '就', '不', '也', '都', '要', '会',
  '到', '说', '对', '去', '能', '没', '把', '让', '被', '从',
  '上', '下', '出', '来', '还', '可', '以', '很', '着', '过',
])

export function expandQueryWithSynonyms(words: Set<string>): Set<string> {
  const expanded = new Set(words)
  for (const word of words) {
    const synonyms = SYNONYM_MAP[word]
    if (synonyms) {
      for (const s of synonyms) expanded.add(s)
    }
  }
  return expanded
}

// ═══════════════════════════════════════════════════════════════════════════════
// Time Decay — unified Weibull model (delegates to smart-forget.ts)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Unified time decay using Weibull survival model from smart-forget.ts.
 * Replaces the old exp(half-life) model for consistency across the codebase.
 */
let _sfMod: any = null
export function timeDecay(mem: Memory): number {
  // Lazy import (cached) to avoid circular dependency at module level
  if (!_sfMod) {
    try { _sfMod = require('./smart-forget.ts') } catch {
      // ESM fallback: use inline Weibull (same formula as smart-forget.ts)
      const ageDays = (Date.now() - (mem.lastAccessed || mem.ts || Date.now())) / 86400000
      const lambda = 30 // default fact scope
      return Math.exp(-Math.pow(ageDays / lambda, 1.5))
    }
  }
  const ageDays = (Date.now() - (mem.lastAccessed || mem.ts || Date.now())) / 86400000
  const lambda = _sfMod.effectiveLambda(mem.scope || 'fact', mem.recallCount ?? 0, mem.emotionIntensity)
  return _sfMod.weibullSurvival(ageDays, lambda, _sfMod.WEIBULL_K)
}

// ═══════════════════════════════════════════════════════════════════════════════
// Memory Semantic Compression — condense verbose memories into compact facts
// ═══════════════════════════════════════════════════════════════════════════════

/** Redundant prefixes/fillers to strip from memory text */
export const COMPRESS_PATTERNS: [RegExp, string][] = [
  // Remove "用户说/提到/表示/告诉我" etc. prefixes
  [/^(?:用户|他|她|对方)(?:说|提到|表示|告诉我|跟我说|反馈|回复|回答|补充|指出|觉得|认为|希望|想要|需要|打算|计划)\s*(?:了|过|着)?\s*(?:，|,)?\s*/g, ''],
  // Remove "我觉得/我认为/我发现" etc.
  [/(?:我觉得|我认为|我发现|我注意到|我看到|据说|好像|似乎|可能是|应该是)\s*(?:，|,)?\s*/g, ''],
  // Remove "其实/事实上/实际上/说实话/老实说"
  [/(?:其实|事实上|实际上|说实话|老实说|总的来说|简单来说|换句话说)\s*(?:，|,)?\s*/g, ''],
  // Remove "非常/特别/很/比较/相当" intensity modifiers (keep the adjective)
  [/(?:非常|特别|很|比较|相当|十分|极其|超级)\s*(?=[\u4e00-\u9fff])/g, ''],
  // Remove "的话/来说/而言/方面"
  [/(?:的话|来说|而言|方面|这块|这个)/g, ''],
  // Remove trailing "了/的/呢/吧/啊/嘛"
  [/[了的呢吧啊嘛]+\s*$/g, ''],
  // Collapse multiple spaces/punctuation
  [/\s{2,}/g, ' '],
  [/(?:，|,){2,}/g, '，'],
]

/**
 * Compress a verbose memory into a compact factual statement.
 * Pure text rules — no LLM call.
 */
export function compressMemory(memory: Memory): string {
  let text = memory.content.trim()

  // Short enough already — don't compress
  if (text.length <= 30) return text

  // Apply pattern-based compression
  for (const [pattern, replacement] of COMPRESS_PATTERNS) {
    text = text.replace(pattern, replacement)
  }

  // Trim leading/trailing punctuation
  text = text.replace(/^[，,、。：:；;\s]+/, '').replace(/[，,、。：:；;\s]+$/, '').trim()

  // If compression removed too much, return original
  if (text.length < 5) return memory.content.trim()

  return text
}

// ═══════════════════════════════════════════════════════════════════════════════
// Memory Poisoning Detection
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Memory poisoning defense: detect attempts to inject malicious content into memory store.
 * Checks for patterns that could manipulate future behavior via stored memories.
 */
export function detectMemoryPoisoning(content: string): boolean {
  const patterns = [
    /\bignore\s+(all\s+)?previous\b/i,
    /忽略(之前|上面|所有)(的)?指令/,
    /\byou\s+(are|must|should)\s+now\b/i,
    /\bfrom\s+now\s+on\b/i,
    /\bnew\s+(instructions?|rules?|persona)\s*:/i,
    /\bsystem\s*prompt\s*:/i,
    /\boverride\s+(all|system|safety|rules)\b/i,
    /你(现在|必须|应该)(是|变成|扮演)/,
    /\[INST\]|\[SYS\]|<<SYS>>|<\|im_start\|>/i,
  ]
  return patterns.some(p => p.test(content))
}

// ═══════════════════════════════════════════════════════════════════════════════
// Chain-of-Thought Reasoning Extraction
// ═══════════════════════════════════════════════════════════════════════════════

// ── Chain-of-Thought reasoning extraction ──
export function extractReasoning(content: string): { reasoning?: Memory['reasoning'] } {
  // Chinese: 因为X所以Y
  let m = content.match(/因为(.{3,80})所以(.{3,120})/)
  if (m) return { reasoning: { context: m[1].trim(), conclusion: m[2].trim(), confidence: 0.7 } }
  // English: based on X therefore Y / because X therefore Y
  m = content.match(/(?:based on|because)\s+(.{3,80})(?:therefore|so|thus)\s+(.{3,120})/i)
  if (m) return { reasoning: { context: m[1].trim(), conclusion: m[2].trim(), confidence: 0.7 } }
  // X → Y / X => Y (arrow notation)
  m = content.match(/(.{3,80})\s*[=\-]>\s*(.{3,120})/)
  if (m) return { reasoning: { context: m[1].trim(), conclusion: m[2].trim(), confidence: 0.6 } }
  return {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// Default Visibility
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Default visibility based on scope:
 * - fact/discovery → global (technical facts everyone can use)
 * - correction/preference → channel (specific to where it happened)
 * - proactive/curiosity/reflection → private
 * - others → channel
 */
export function defaultVisibility(scope: string): 'global' | 'channel' | 'private' {
  if (scope === 'fact' || scope === 'discovery') return 'global'
  if (scope === 'correction' || scope === 'preference') return 'channel'
  if (scope === 'proactive' || scope === 'curiosity' || scope === 'reflection') return 'private'
  return 'channel'
}

// ═══════════════════════════════════════════════════════════════════════════════
// Adaptive Decay — 通用自适应衰减（供 patterns.ts / epistemic.ts 复用）
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 通用自适应衰减：年龄 + 使用频率 二维衰减
 * 供 patterns.ts (模式衰减) 和 epistemic.ts (知识衰减) 复用
 *
 * @param ageMs - 距上次使用的毫秒数
 * @param useCount - 使用/命中次数
 * @param halfLifeMs - 基础半衰期（毫秒）
 * @param usageProtection - 每次使用降低衰减的系数（默认 0.5）
 * @returns 衰减后的保留率 [0, 1]
 */
export function adaptiveDecay(
  ageMs: number,
  useCount: number,
  halfLifeMs: number = 90 * 86400000,  // 默认 90 天
  usageProtection: number = 0.5,
): number {
  // 基础衰减：指数衰减
  const baseDecay = Math.exp(-ageMs * Math.LN2 / halfLifeMs)

  // 使用频率保护：hitCount 越高，衰减越慢
  const protection = 1 + useCount * usageProtection

  // 最终保留率
  const retention = 1 - (1 - baseDecay) / protection

  return Math.max(0, Math.min(1, retention))
}

// ═══════════════════════════════════════════════════════════════════════════════
// Bayesian Belief — 通用贝叶斯信念更新（Beta-Bernoulli 模型）
// 供 theory-of-mind.ts / behavior-prediction.ts / epistemic.ts 共用
// ═══════════════════════════════════════════════════════════════════════════════

export interface BayesianBelief {
  alpha: number    // 成功次数 + 先验
  beta: number     // 失败次数 + 先验
  lastSeen: number // 上次更新时间戳
}

export function createBelief(prior: number = 1): BayesianBelief {
  return { alpha: prior, beta: prior, lastSeen: Date.now() }
}

export function updateBelief(belief: BayesianBelief, success: boolean): void {
  if (success) belief.alpha++
  else belief.beta++
  belief.lastSeen = Date.now()
}

export function beliefPosterior(belief: BayesianBelief): number {
  return belief.alpha / (belief.alpha + belief.beta)
}

export function beliefConfidence(belief: BayesianBelief): number {
  // Wilson score lower bound (95% CI)
  const n = belief.alpha + belief.beta - 2
  if (n < 2) return 0.5
  const p = (belief.alpha - 1) / n
  const z = 1.96
  return (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n)
}

/** 时间衰减：旧的证据逐渐失效 */
export function decayBelief(belief: BayesianBelief, halfLifeMs: number = 30 * 86400000): void {
  const ageFactor = Math.exp(-(Date.now() - belief.lastSeen) * Math.LN2 / halfLifeMs)
  belief.alpha = Math.max(1, belief.alpha * ageFactor)
  belief.beta = Math.max(1, belief.beta * ageFactor)
}
