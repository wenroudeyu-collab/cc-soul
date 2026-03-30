/**
 * memory-utils.ts — Pure utility functions extracted from memory.ts
 * Trigrams, synonyms, time decay, compression, poisoning detection, etc.
 */

import type { Memory } from './types.ts'
import { getParam } from './auto-tune.ts'

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

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

/** Extract character trigrams from text (works for CJK + Latin) — LRU cached (max 500) */
const _trigramCache = new Map<string, { set: Set<string>; ts: number }>()
export function trigrams(text: string): Set<string> {
  const s = text.toLowerCase().replace(/\s+/g, ' ').trim()
  const cached = _trigramCache.get(s)
  if (cached) { cached.ts = Date.now(); return cached.set }
  const set = new Set<string>()
  for (let i = 0; i <= s.length - 3; i++) {
    set.add(s.slice(i, i + 3))
  }
  if (_trigramCache.size >= 500) {
    // Batch evict 20% (100 entries) — sorted by oldest access time
    const entries = [..._trigramCache.entries()].sort((a, b) => a[1].ts - b[1].ts)
    const evictCount = 100
    for (let i = 0; i < evictCount && i < entries.length; i++) {
      _trigramCache.delete(entries[i][0])
    }
  }
  _trigramCache.set(s, { set, ts: Date.now() })
  return set
}

/** Jaccard similarity between two trigram sets: |A∩B| / |A∪B| */
export function trigramSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const t of a) {
    if (b.has(t)) intersection++
  }
  const union = a.size + b.size - intersection
  return union > 0 ? intersection / union : 0
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
// Time Decay — exponential decay with configurable half-life
// ═══════════════════════════════════════════════════════════════════════════════

export function timeDecay(mem: Memory): number {
  const ageDays = (Date.now() - (mem.lastAccessed || mem.ts || Date.now())) / 86400000
  // Exponential decay: half-life configurable (default 90 days)
  return Math.pow(0.5, ageDays / getParam('memory.time_decay_halflife_days'))
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
