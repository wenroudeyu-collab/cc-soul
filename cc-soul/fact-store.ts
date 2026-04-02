/**
 * fact-store.ts — Structured Fact Extraction & Storage
 *
 * Mem0-style key-value fact store. Extracts subject-predicate-object triples
 * from natural language memories for precise querying.
 *
 * Two extraction modes:
 *   1. Rule-based (instant, zero LLM cost) — pattern matching
 *   2. LLM-based (async, via spawnCLI) — deep extraction on heartbeat
 */

import type { StructuredFact } from './types.ts'
import { DATA_DIR, loadJson, debouncedSave } from './persistence.ts'
import { resolve } from 'path'
import {
  isSQLiteReady, sqliteAddFact, sqliteQueryFacts,
  sqliteInvalidateFacts, sqliteFactCount, sqliteGetFactsBySubject,
} from './sqlite-store.ts'

const FACTS_PATH = resolve(DATA_DIR, 'structured_facts.json')
let facts: StructuredFact[] = loadJson<StructuredFact[]>(FACTS_PATH, [])
function saveFacts() { debouncedSave(FACTS_PATH, facts) }

// ═══════════════════════════════════════════════════════════════════════════════
// RULE-BASED EXTRACTION — instant, zero cost
// ═══════════════════════════════════════════════════════════════════════════════

interface ExtractionRule {
  pattern: RegExp
  extract: (match: RegExpMatchArray, content: string) => StructuredFact | null
}

const RULES: ExtractionRule[] = [
  // "我叫X" / "我是X" / "我名字叫X" / "大家叫我X" → name
  { pattern: /(?:我叫|我名字(?:是|叫)|大家(?:都)?叫我|我的名字(?:是|叫)?)\s*([^\s，。！？,;；\n]{1,8})/, extract: (m) => {
    const name = m[1].trim()
    // 排除疑问句："我叫什么名字" / "我叫什么" 不是在告诉名字
    if (/^(什么|啥|谁|哪|吗|呢|嘛)/.test(name)) return null
    if (name.length < 1) return null
    return { subject: 'user', predicate: 'name', object: name,
      confidence: 0.95, source: 'user_said', ts: Date.now(), validUntil: 0 }
  }},
  // "我喜欢X" / "我爱X" / "我偏好X" — stop at punctuation or conjunctions
  { pattern: /我(?:喜欢|爱|偏好|特别喜欢|超喜欢)(?:用)?\s*([^，。！？,;；\n]{2,15})/, extract: (m) => ({
    subject: 'user', predicate: 'likes', object: m[1].trim(),
    confidence: 0.85, source: 'user_said', ts: Date.now(), validUntil: 0,
  })},
  // "我不喜欢X" / "我讨厌X" / "我不爱X"
  { pattern: /我(?:不喜欢|讨厌|不爱|不想用|受不了)\s*(.{2,20})/, extract: (m) => ({
    subject: 'user', predicate: 'dislikes', object: m[1].replace(/[。，！？\s]+$/, ''),
    confidence: 0.85, source: 'user_said', ts: Date.now(), validUntil: 0,
  })},
  // "我用X" / "我在用X" / "我常用X"
  { pattern: /我(?:用|在用|常用|一直用)\s*(.{2,20})/, extract: (m) => ({
    subject: 'user', predicate: 'uses', object: m[1].replace(/[。，！？\s]+$/, ''),
    confidence: 0.8, source: 'user_said', ts: Date.now(), validUntil: 0,
  })},
  // "我在X工作" / "我在X做Y" / "我是X的"
  { pattern: /我(?:在|是)\s*(.{2,15})(?:工作|上班|就职|的员工|做\S{2,10})/, extract: (m) => ({
    subject: 'user', predicate: 'works_at', object: m[0].replace(/^我(?:在|是)\s*/, '').replace(/[。，！？\s]+$/, ''),
    confidence: 0.9, source: 'user_said', ts: Date.now(), validUntil: 0,
  })},
  // "我住在X" — only match explicit residence, not "我在X工作"
  { pattern: /我(?:住在|住)\s*([^，。！？,;；\n]{2,10})/, extract: (m) => {
    const place = m[1].trim()
    if (place.length < 2 || /^(这|那|哪|什么|怎么)/.test(place)) return null
    if (/工作|上班|就职/.test(place)) return null  // "住在X工作" → skip
    return { subject: 'user', predicate: 'lives_in', object: place,
      confidence: 0.7, source: 'user_said', ts: Date.now(), validUntil: 0 }
  }},
  // "我是做X的" / "我是X工程师/开发/设计师"
  { pattern: /我是(?:做)?(.{2,15})(?:的|工程师|开发|设计师|产品|运营)/, extract: (m) => ({
    subject: 'user', predicate: 'occupation', object: m[1].replace(/[。，！？\s]+$/, ''),
    confidence: 0.85, source: 'user_said', ts: Date.now(), validUntil: 0,
  })},
  // "X比Y好" / "X比Y快" — preference
  { pattern: /(.{2,10})比(.{2,10})(?:好|快|强|稳定|方便|简单)/, extract: (m) => ({
    subject: 'user', predicate: 'prefers', object: `${m[1].trim()} over ${m[2].trim()}`,
    confidence: 0.7, source: 'ai_inferred', ts: Date.now(), validUntil: 0,
  })},
  // "我X岁" / "我今年X" → age
  { pattern: /我(?:今年)?(\d{1,3})岁/, extract: (m) => ({
    subject: 'user', predicate: 'age', object: m[1],
    confidence: 0.9, source: 'user_said', ts: Date.now(), validUntil: 0,
  })},
  // "我养了X" / "我家有X" / "我们养了X"（猫/狗/宠物）→ has_pet
  { pattern: /我们?(?:养了|家有|有一只|有一条|有一个)\s*([^，。！？,;；\n]{2,10}?)(?:猫|狗|鱼|鸟|兔|仓鼠|宠物)?/, extract: (m) => {
    const obj = m[1].trim()
    if (obj.length < 1 || /^(什么|哪|这|那)/.test(obj)) return null
    return { subject: 'user', predicate: 'has_pet', object: m[0].replace(/^我(?:养了|家有|有一只|有一条|有一个)\s*/, '').replace(/[。，！？\s]+$/, ''),
      confidence: 0.8, source: 'user_said', ts: Date.now(), validUntil: 0 }
  }},
  // "我有个女儿/儿子/孩子" / "我有X个孩子" → has_family
  { pattern: /我有(?:个|一个|两个|三个)?\s*([^，。！？,;；\n]{1,10}?)(?:女儿|儿子|孩子|闺女|宝宝|小孩|老婆|老公|丈夫|妻子|爸|妈|哥|姐|弟|妹)/, extract: (m) => ({
    subject: 'user', predicate: 'has_family', object: m[0].replace(/^我有(?:个|一个|两个|三个)?\s*/, '').replace(/[。，！？\s]+$/, ''),
    confidence: 0.9, source: 'user_said', ts: Date.now(), validUntil: 0,
  })},
  // "我女儿/儿子叫X" → family_name
  { pattern: /我(?:女儿|儿子|孩子|闺女|宝宝|老婆|老公)叫\s*([^，。！？,;；\n]{1,8})/, extract: (m) => ({
    subject: 'user', predicate: 'family_name', object: m[0].replace(/^我/, '').replace(/[。，！？\s]+$/, ''),
    confidence: 0.9, source: 'user_said', ts: Date.now(), validUntil: 0,
  })},
  // "我每天X" / "我习惯X" → habit
  { pattern: /我(?:每天|习惯|一般都|通常|经常)\s*([^，。！？,;；\n]{2,20})/, extract: (m) => ({
    subject: 'user', predicate: 'habit', object: m[1].replace(/[。，！？\s]+$/, ''),
    confidence: 0.75, source: 'user_said', ts: Date.now(), validUntil: 0,
  })},
  // "我毕业于X" / "我读的X大学" → educated_at
  { pattern: /我(?:毕业于|毕业|读的|上的)\s*([^，。！？,;；\n]{2,15})(?:大学|学院|学校)?/, extract: (m) => ({
    subject: 'user', predicate: 'educated_at', object: m[1].replace(/[。，！？\s]+$/, ''),
    confidence: 0.85, source: 'user_said', ts: Date.now(), validUntil: 0,
  })},
  // "我老婆/老公/女朋友/男朋友" → relationship
  { pattern: /我(?:老婆|老公|女朋友|男朋友|媳妇|对象|另一半|爱人)\s*([^，。！？,;；\n\s]{0,8})/, extract: (m, content) => {
    const relType = m[0].match(/老婆|老公|女朋友|男朋友|媳妇|对象|另一半|爱人/)?.[0] || 'partner'
    const detail = m[1]?.trim()
    // 过滤隐式疑问：捕获内容含"什么/哪/谁/怎么/叫什么" = 在提问不是在陈述
    if (detail && /什么|哪|谁|怎么|吗$|呢$/.test(detail)) return null
    return { subject: 'user', predicate: 'relationship', object: detail ? `${relType}：${detail}` : relType,
      confidence: 0.85, source: 'user_said', ts: Date.now(), validUntil: 0 }
  }},
  // "我住X楼/X层" → lives_in (floor)
  { pattern: /我住(?:在)?(\d{1,3})(?:楼|层)/, extract: (m) => ({
    subject: 'user', predicate: 'lives_in', object: `${m[1]}楼`,
    confidence: 0.7, source: 'user_said', ts: Date.now(), validUntil: 0,
  })},
  // "我用Mac/Windows/Linux" → uses_os
  { pattern: /我(?:用|在用|一直用)\s*(Mac|MacBook|Windows|Linux|Ubuntu|macOS|win|WSL)/i, extract: (m) => ({
    subject: 'user', predicate: 'uses_os', object: m[1],
    confidence: 0.85, source: 'user_said', ts: Date.now(), validUntil: 0,
  })},
]

/**
 * Extract structured facts from a text string (rule-based, instant).
 * Returns new facts not already in the store.
 */
export function extractFacts(content: string, source: StructuredFact['source'] = 'user_said', userId?: string): StructuredFact[] {
  const extracted: StructuredFact[] = []

  // 疑问句整体过滤：提问不是在陈述事实
  const trimmed = content.trim()
  if (/[？?]$/.test(trimmed) || /(.)\1不\1/.test(trimmed) || /[吗呢吧嘛]$/.test(trimmed)) {
    return extracted  // 疑问句不提取任何事实
  }

  // LLM 分析内容过滤：方括号标签开头的内容是系统生成的分析，不是用户说的事实
  // 动态判断：用户说话不会以 [标签] 开头
  if (/^\[.{1,10}\]/.test(trimmed)) {
    return extracted
  }

  // ── 动态引擎提取（优先）──
  try {
    const { dynamicExtract, updateStructureStrength } = require('./dynamic-extractor.ts')
    const dynamicResults = dynamicExtract(content, userId)
    for (const r of dynamicResults) {
      const exists = facts.some(f =>
        f.subject === r.subject && f.predicate === r.predicate &&
        f.object === r.object && f.validUntil === 0
      )
      if (!exists) {
        const fact: StructuredFact = {
          subject: r.subject, predicate: r.predicate, object: r.object,
          confidence: r.confidence, source: r.source as any,
          ts: Date.now(), validUntil: 0, memoryRef: content.slice(0, 60),
        }
        extracted.push(fact)
        // 反馈强度学习
        if (userId) updateStructureStrength(r.structureWord, userId, true)
      }
    }
  } catch {}

  // ── 旧正则规则（种子兜底）──
  for (const rule of RULES) {
    const match = content.match(rule.pattern)
    if (match) {
      const fact = rule.extract(match, content)
      if (fact) {
        fact.source = source
        fact.memoryRef = content.slice(0, 60)
        // Dedup: skip if same subject+predicate+object already extracted
        const exists = facts.some(f =>
          f.subject === fact.subject && f.predicate === fact.predicate &&
          f.object === fact.object && f.validUntil === 0
        ) || extracted.some(e =>
          e.subject === fact.subject && e.predicate === fact.predicate &&
          e.object === fact.object
        )
        if (!exists) extracted.push(fact)
      }
    }
  }
  return extracted
}

/**
 * Add facts to the store. Auto-invalidates conflicting old facts.
 */
export function addFacts(newFacts: StructuredFact[]) {
  for (const nf of newFacts) {
    // 质量过滤：新 fact 比旧 fact 信息量更少时不做 supersede
    // 防止"我养了宠物 叫什么来着"→ has_pet=宠物 覆盖 has_pet=一只叫豆豆的猫
    let shouldSupersede = true
    for (const old of facts) {
      if (old.subject === nf.subject && old.predicate === nf.predicate &&
          old.object !== nf.object && old.validUntil === 0) {
        // 新 object 比旧 object 短 50%+ 且旧的 confidence 更高 → 不覆盖
        if (nf.object.length < old.object.length * 0.5 && (old.confidence ?? 0) >= (nf.confidence ?? 0)) {
          console.log(`[cc-soul][facts] skip supersede (info loss): "${nf.object}" < "${old.object}"`)
          shouldSupersede = false
          break
        }
      }
    }
    // Invalidate conflicting facts (same subject+predicate, different object)
    if (shouldSupersede) {
      for (const old of facts) {
        if (old.subject === nf.subject && old.predicate === nf.predicate &&
            old.object !== nf.object && old.validUntil === 0) {
          old.validUntil = Date.now()
          console.log(`[cc-soul][facts] superseded: ${old.subject}.${old.predicate}="${old.object}" → "${nf.object}"`)
        }
      }
    } else {
      continue  // 跳过这条低质量 fact
    }
    facts.push(nf)

    // Dual-write to SQLite (indexed queries)
    if (isSQLiteReady()) {
      try {
        sqliteInvalidateFacts(nf.subject, nf.predicate, nf.object)
        sqliteAddFact(nf)
      } catch { /* JSON fallback still works */ }
    }
  }
  if (newFacts.length > 0) {
    saveFacts()
    console.log(`[cc-soul][facts] added ${newFacts.length} structured facts`)
    try { const { emitCacheEvent } = require('./memory-utils.ts'); emitCacheEvent('fact_updated') } catch {}
  }
}

/**
 * Query facts by subject and/or predicate.
 * Only returns valid (non-expired) facts.
 */
export function queryFacts(opts: { subject?: string; predicate?: string; object?: string }): StructuredFact[] {
  // Prefer SQLite: uses idx_fact_subj_pred index → O(log n)
  if (isSQLiteReady()) {
    try {
      const results = sqliteQueryFacts(opts)
      if (results.length > 0) return results
    } catch { /* fallback to in-memory */ }
  }

  // Fallback: in-memory array scan
  return facts.filter(f => {
    if (f.validUntil > 0) return false  // expired
    if (opts.subject && f.subject !== opts.subject) return false
    if (opts.predicate && f.predicate !== opts.predicate) return false
    if (opts.object && !f.object.includes(opts.object)) return false
    return true
  })
}

/**
 * 事实演化时间线（Zep 启发）：同一 subject+predicate 的所有版本按时间排列
 * 返回最新版 + 变化轨迹。用户问"以前"时返回历史版本。
 */
export function queryFactTimeline(subject: string, predicate: string): Array<{ object: string; validFrom: number; validUntil: number; confidence: number; source: string }> {
  // 包含已失效的版本（validUntil > 0）
  const allVersions = facts.filter(f =>
    f.subject === subject && f.predicate === predicate
  ).sort((a, b) => a.ts - b.ts)

  // SQLite 补充
  if (isSQLiteReady() && allVersions.length === 0) {
    try {
      const results = sqliteQueryFacts({ subject, predicate })
      // SQLite 版本只返回有效的，还需要查过期的
      // 暂用内存版本
    } catch {}
  }

  return allVersions.map(f => ({
    object: f.object,
    validFrom: f.ts,
    validUntil: f.validUntil,
    confidence: f.confidence,
    source: f.source,
  }))
}

/**
 * 格式化事实时间线为可读字符串
 */
export function formatFactTimeline(subject: string, predicate: string): string | null {
  const timeline = queryFactTimeline(subject, predicate)
  if (timeline.length <= 1) return null  // 无变化历史

  const current = timeline.find(v => v.validUntil === 0) ?? timeline[timeline.length - 1]
  const history = timeline.filter(v => v.validUntil > 0)

  if (history.length === 0) return null

  const historyStr = history.map(v => {
    const date = new Date(v.validFrom).toLocaleDateString('zh-CN')
    return `${date}:${v.object}`
  }).join(' → ')

  return `${predicate}: ${historyStr} → 现在:${current.object}`
}

/**
 * Get all valid facts for a subject (usually "user"), formatted as readable string.
 */
export function getFactSummary(subject = 'user'): string {
  let valid: StructuredFact[]
  if (isSQLiteReady()) {
    try { valid = sqliteGetFactsBySubject(subject) } catch { valid = [] }
  } else {
    valid = facts.filter(f => f.subject === subject && f.validUntil === 0)
  }
  if (valid.length === 0) return ''

  const grouped: Record<string, string[]> = {}
  for (const f of valid) {
    if (!grouped[f.predicate]) grouped[f.predicate] = []
    grouped[f.predicate].push(f.object)
  }

  const LABELS: Record<string, string> = {
    name: '名字', likes: '喜欢', dislikes: '不喜欢', uses: '使用', works_at: '工作于',
    lives_in: '住在', occupation: '职业', prefers: '偏好', has: '拥有',
    age: '年龄', has_pet: '养宠', has_family: '家人', habit: '习惯', educated_at: '毕业于',
    relationship: '伴侣', family_name: '家人名字', learning: '在学', uses_os: '操作系统',
  }

  return Object.entries(grouped)
    .map(([pred, objs]) => `${LABELS[pred] || pred}: ${objs.join('、')}`)
    .join('；')
}

/**
 * Auto-extract facts from a memory being added.
 * Call this from addMemory() in memory.ts.
 */
export function autoExtractFromMemory(content: string, scope: string, source?: StructuredFact['source']) {
  // Only extract from user-facing scopes
  if (['expired', 'decayed', 'dream', 'curiosity', 'system'].includes(scope)) return
  const autoSource = source || (scope === 'correction' || scope === 'preference' ? 'user_said' : 'ai_observed')
  const newFacts = extractFacts(content, autoSource)
  if (newFacts.length > 0) addFacts(newFacts)
}

export function getAllFacts(): StructuredFact[] { return facts }
export function getFactCount(): number {
  if (isSQLiteReady()) { try { return sqliteFactCount() } catch { /* fallback */ } }
  return facts.filter(f => f.validUntil === 0).length
}
