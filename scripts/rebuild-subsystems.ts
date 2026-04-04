/**
 * rebuild-subsystems.ts — 从已有数据重建空子系统
 *
 * 步骤：
 * 0. 迁移 JSON → SQLite（如果 SQLite 数据少于 JSON）
 * 1. Entity Graph：从 memories + facts 提取实体
 * 2. Distillation：触发 L1→L2→L3 蒸馏管道
 * 3. Deep Understand：刷新 7 维分析
 * 4. Person Model：Living Profile + distillPersonModel + crystallizeTraits
 *
 * 用法：npx tsx scripts/rebuild-subsystems.ts
 */

import { createRequire } from 'module'
if (!globalThis.require) (globalThis as any).require = createRequire(import.meta.url)

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const log = (tag: string, msg: string) => console.log(`[rebuild][${tag}] ${msg}`)
const warn = (tag: string, msg: string) => console.warn(`[rebuild][${tag}] ⚠ ${msg}`)

async function main() {
  const t0 = Date.now()
  log('init', '开始重建子系统...')

  // ── 1. 初始化基础设施 ──
  const persistence = require('../cc-soul/persistence.ts')
  persistence.ensureDataDir()

  const sqliteStore = require('../cc-soul/sqlite-store.ts')
  const sqliteOk = sqliteStore.initSQLite()
  log('init', `SQLite ready: ${sqliteOk}`)

  // ── 2. 迁移 JSON → SQLite（补全数据差） ──
  const DATA_DIR = resolve(import.meta.dirname || __dirname, '..', 'data')
  const MEMORIES_JSON = resolve(DATA_DIR, 'memories.json')
  const FACTS_JSON = resolve(DATA_DIR, 'structured_facts.json')
  const HISTORY_JSON = resolve(DATA_DIR, 'chat_history.json')

  // 2a. 迁移 memories
  const sqliteMemCount = sqliteStore.sqliteCount?.() ?? 0
  log('migrate', `SQLite memories: ${sqliteMemCount}`)
  if (existsSync(MEMORIES_JSON)) {
    try {
      const jsonMems = JSON.parse(readFileSync(MEMORIES_JSON, 'utf-8'))
      log('migrate', `JSON memories: ${jsonMems.length}`)
      if (jsonMems.length > sqliteMemCount) {
        log('migrate', `迁移 ${jsonMems.length - sqliteMemCount} 条 memories 到 SQLite...`)
        let migrated = 0
        for (const m of jsonMems) {
          if (m.scope === 'expired') continue
          // 检查是否已存在（按 content 去重）
          const existing = sqliteStore.sqliteFindByContent?.(m.content)
          if (existing) continue
          try {
            sqliteStore.sqliteAddMemory({
              content: m.content,
              scope: m.scope || 'general',
              ts: m.ts || Date.now(),
              emotion: m.emotion || 'neutral',
              userId: m.userId || null,
              visibility: m.visibility || 'global',
              channelId: m.channelId || null,
              tags: m.tags || [],
              confidence: m.confidence ?? 0.7,
              lastAccessed: m.lastAccessed || null,
              tier: m.tier || 'short_term',
              recallCount: m.recallCount || 0,
              lastRecalled: m.lastRecalled || null,
              validFrom: m.validFrom || null,
              validUntil: m.validUntil || null,
              importance: m.importance ?? 5,
            })
            migrated++
          } catch {}
        }
        log('migrate', `迁移了 ${migrated} 条 memories`)
      }
    } catch (e: any) {
      warn('migrate', `memories 迁移失败: ${e.message}`)
    }
  }

  // 2b. 迁移 facts
  const sqliteFactCount = sqliteStore.sqliteFactCount?.() ?? 0
  log('migrate', `SQLite facts: ${sqliteFactCount}`)
  if (existsSync(FACTS_JSON)) {
    try {
      const jsonFacts = JSON.parse(readFileSync(FACTS_JSON, 'utf-8'))
      log('migrate', `JSON facts: ${jsonFacts.length}`)
      if (jsonFacts.length > sqliteFactCount) {
        log('migrate', `迁移 facts 到 SQLite...`)
        let migrated = 0
        for (const f of jsonFacts) {
          if (f.validUntil && f.validUntil > 0) continue  // skip invalidated
          try {
            // 检查是否已存在
            const existing = sqliteStore.sqliteQueryFacts?.({ subject: f.subject, predicate: f.predicate })
            const alreadyExists = existing?.some((e: any) => e.object === f.object)
            if (alreadyExists) continue
            sqliteStore.sqliteAddFact({
              subject: f.subject,
              predicate: f.predicate,
              object: f.object,
              confidence: f.confidence ?? 0.7,
              source: f.source || 'migration',
              ts: f.ts || Date.now(),
              validUntil: 0,
              memoryRef: f.memoryRef || null,
            })
            migrated++
          } catch {}
        }
        log('migrate', `迁移了 ${migrated} 条 facts`)
      }
    } catch (e: any) {
      warn('migrate', `facts 迁移失败: ${e.message}`)
    }
  }

  // 2c. 迁移 chat history
  if (existsSync(HISTORY_JSON)) {
    try {
      sqliteStore.migrateHistoryFromJSON(HISTORY_JSON)
    } catch {}
  }

  // ── 3. 重新加载 memories（包含迁移后的数据）──
  log('memory', '重新加载 memories...')
  const memory = require('../cc-soul/memory.ts')
  memory.loadMemories()
  const { memories, chatHistory } = memory.memoryState
  log('memory', `已加载 ${memories.length} memories, ${chatHistory.length} chat history`)

  // 重新加载 facts
  const factStore = require('../cc-soul/fact-store.ts')
  // fact-store 在模块加载时就读取了，但可能是迁移前的数据
  // 直接用 sqliteLoadAllFacts 重新加载
  let facts = factStore.getAllFacts()
  if (facts.length < 50 && sqliteStore.sqliteLoadAllFacts) {
    facts = sqliteStore.sqliteLoadAllFacts()
  }
  log('facts', `已加载 ${facts.length} facts`)

  // ══════════════════════════════════════════════════════════════
  // STEP 1: Rebuild Entity Graph
  // ══════════════════════════════════════════════════════════════
  log('graph', '=== 重建 Entity Graph ===')
  const graph = require('../cc-soul/graph.ts')
  graph.loadGraph()
  const beforeEntities = graph.graphState.entities.length
  const beforeRelations = graph.graphState.relations.length
  log('graph', `当前: ${beforeEntities} entities, ${beforeRelations} relations`)

  // 实体提取正则
  const ENTITY_PATTERNS: [RegExp, string][] = [
    // 公司/组织（高精度）
    [/(?:在|去|加入|离开)\s*([^\s，。！？]{2,10}?)(?:工作|上班|任职|实习)/g, 'organization'],
    [/\b(Google|Apple|Microsoft|Meta|Amazon|Tencent|Alibaba|ByteDance|Huawei|Baidu|OpenAI|Anthropic|DeepSeek|阿里巴巴|腾讯|字节跳动|百度|华为|美团|京东|拼多多|网易|快手|B站|bilibili|小红书|知乎|微博)\b/gi, 'organization'],
    // 技术/工具/品牌
    [/\b(Python|JavaScript|TypeScript|Go|Rust|Swift|Kotlin|Java|C\+\+|Ruby|PHP|Dart|Elixir|Haskell|Lua|Perl|Scala|Clojure|Objective-C)\b/gi, 'technology'],
    [/\b(React|Vue|Angular|Next\.?js|Nuxt|Svelte|Django|Flask|FastAPI|Express|Spring|Rails|Laravel|Gin|Fiber|Actix|Node\.?js)\b/gi, 'technology'],
    [/\b(Docker|Kubernetes|K8s|Redis|PostgreSQL|MySQL|MongoDB|SQLite|Nginx|Grafana|Prometheus|Terraform|Ansible|Jenkins|GitHub|GitLab|Vercel|Cloudflare|AWS|GCP|Azure)\b/gi, 'technology'],
    [/\b(iPhone|iPad|Mac|MacBook|Android|Linux|Windows|Ubuntu|Debian|CentOS|Arch|iOS|macOS|watchOS)\b/gi, 'technology'],
    [/\b(GPT|Claude|Gemini|LLaMA|Mistral|Qwen|ChatGPT|Copilot|Cursor|Windsurf|OpenClaw)\b/gi, 'technology'],
    [/\b(VS\s?Code|Xcode|IntelliJ|PyCharm|Vim|Neovim|Emacs|Sublime|Zed)\b/gi, 'tool'],
    [/\b(IDA\s?Pro|Frida|Hopper|Ghidra|LLDB|GDB|Charles|Wireshark|mitmproxy)\b/gi, 'tool'],
    [/\b(Mach-O|dyld|ARM64|ObjC|objc_msgSend)\b/g, 'concept'],
    // 地点
    [/\b(北京|上海|广州|深圳|杭州|成都|武汉|南京|西安|重庆|苏州|天津|长沙|东莞|郑州|青岛|厦门|合肥|大连|昆明|福州|济南|沈阳|贵阳|珠海|海口|三亚|拉萨|香港|台北|Singapore|San Francisco|New York|London|Seattle|Berlin|Paris|Tokyo)\b/gi, 'place'],
    // 项目名（高精度）
    [/\b(feishu-bot|cc-soul|openclaw|open-claw)\b/gi, 'project'],
    // 英文专有名词（大写开头，至少3字母，排除常见英语词）
    [/\b([A-Z][a-z]{2,15}(?:\s[A-Z][a-z]{2,15}))\b/g, 'person'],
    // 家庭成员（高精度）
    [/(?:我)(女儿|儿子|孩子|老婆|老公|爸|妈|哥|姐|弟|妹|媳妇|丈夫|女朋友|男朋友)/g, 'person'],
  ]

  const NOISE_WORDS = new Set([
    '我', '你', '他', '她', '它', '我们', '你们', '他们', '这个', '那个',
    '什么', '怎么', '为什么', '如何', '可以', '应该', '需要', '可能', '已经',
    '是的', '不是', '没有', '知道', '觉得', '认为', '的', '了', '吗', '呢',
    '但是', '因为', '所以', '如果', '虽然', '一下', '一些', '一个',
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'been',
    'not', 'but', 'are', 'was', 'will', 'can', 'all', 'your', 'any',
    'some', 'just', 'also', 'very', 'much', 'more', 'well', 'too',
    'let', 'new', 'try', 'use', 'get', 'set', 'put', 'run', 'add',
    'The', 'And', 'For', 'But', 'Not', 'Can', 'Will', 'May', 'Now',
    'Here', 'There', 'When', 'Then', 'What', 'How', 'Why', 'Who',
  ])

  const extractedEntities = new Map<string, { type: string; count: number; relations: Set<string> }>()

  function extractEntities(text: string, source: string) {
    for (const [pattern, type] of ENTITY_PATTERNS) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(text)) !== null) {
        const name = (match[1] || match[0]).trim()
        if (name.length < 2 || name.length > 30) continue
        if (NOISE_WORDS.has(name) || NOISE_WORDS.has(name.toLowerCase())) continue
        if (/^\d+$/.test(name)) continue
        // 过滤单个中文字
        if (/^[\u4e00-\u9fff]$/.test(name)) continue

        const key = name.toLowerCase()
        if (!extractedEntities.has(key)) {
          extractedEntities.set(key, { type, count: 0, relations: new Set() })
        }
        const entry = extractedEntities.get(key)!
        entry.count++
        if (source) entry.relations.add(source)
      }
    }
  }

  log('graph', '从 memories 提取实体...')
  for (const mem of memories) {
    if (mem.scope === 'expired' || mem.scope === 'decayed') continue
    extractEntities(mem.content, mem.scope || 'general')
  }

  log('graph', '从 facts 提取实体...')
  for (const fact of facts) {
    const text = `${fact.subject || ''} ${fact.predicate || ''} ${fact.object || ''}`
    extractEntities(text, 'fact')
    // fact 的 subject/object 本身就是实体
    if (fact.subject && fact.subject.length >= 2 && !NOISE_WORDS.has(fact.subject)) {
      const key = fact.subject.toLowerCase()
      if (!extractedEntities.has(key)) {
        extractedEntities.set(key, { type: 'entity', count: 0, relations: new Set() })
      }
      extractedEntities.get(key)!.count++
      if (fact.predicate) extractedEntities.get(key)!.relations.add(fact.predicate)
    }
    if (fact.object && fact.object.length >= 2 && !NOISE_WORDS.has(fact.object)) {
      const key = fact.object.toLowerCase()
      if (!extractedEntities.has(key)) {
        extractedEntities.set(key, { type: 'entity', count: 0, relations: new Set() })
      }
      extractedEntities.get(key)!.count++
    }
  }

  // 从 chatHistory 提取
  log('graph', '从 chat history 提取实体...')
  for (const turn of chatHistory) {
    extractEntities(turn.user || '', 'chat')
  }

  const filtered = [...extractedEntities.entries()]
    .filter(([, v]) => v.count >= 2)
    .sort((a, b) => b[1].count - a[1].count)

  log('graph', `提取到 ${extractedEntities.size} 个候选实体，过滤后 ${filtered.length} 个（>=2次）`)

  const batchEntities: { name: string; type: string; relation?: string }[] = []

  for (const [key, val] of filtered) {
    // 还原大小写
    let originalName = key
    // 从 facts 优先还原
    for (const fact of facts) {
      for (const field of [fact.subject, fact.object]) {
        if (field && field.toLowerCase() === key) { originalName = field; break }
      }
      if (originalName !== key) break
    }
    if (originalName === key) {
      for (const mem of memories) {
        const idx = mem.content.toLowerCase().indexOf(key)
        if (idx >= 0) {
          originalName = mem.content.slice(idx, idx + key.length)
          break
        }
      }
    }

    batchEntities.push({
      name: originalName,
      type: val.type,
      relation: val.relations.size > 0 ? [...val.relations][0] : undefined,
    })
  }

  if (batchEntities.length > 0) {
    graph.addEntitiesFromAnalysis(batchEntities)
  }

  // 额外：从 facts 创建实体间关系
  let factRelations = 0
  for (const fact of facts) {
    if (fact.subject && fact.object && fact.predicate && fact.subject.length >= 2 && fact.object.length >= 2) {
      try {
        graph.addRelation(fact.subject, fact.object, fact.predicate.slice(0, 30))
        factRelations++
      } catch {}
    }
  }
  log('graph', `从 facts 添加了 ${factRelations} 条关系`)

  const afterEntities = graph.graphState.entities.length
  const afterRelations = graph.graphState.relations.length
  log('graph', `完成: ${beforeEntities} → ${afterEntities} entities, ${beforeRelations} → ${afterRelations} relations`)

  // ══════════════════════════════════════════════════════════════
  // STEP 2: Trigger Distillation Pipeline
  // (直接实现 cluster + zero-LLM distill，绕过 cooldown/session gate)
  // ══════════════════════════════════════════════════════════════
  log('distill', '=== 触发蒸馏管道 ===')
  const distill = require('../cc-soul/distill.ts')
  distill.loadDistillState()
  const beforeStats = distill.getDistillStats()
  log('distill', `当前: ${beforeStats.topicNodes} topic nodes, ${beforeStats.mentalModels} mental models`)

  // 直接实现 L1→L2 蒸馏（绕过 cooldown + session gate）
  {
    const active = memories.filter((m: any) =>
      m.scope !== 'expired' && m.scope !== 'archived' && m.scope !== 'decayed' &&
      m.content.length > 10
    )
    log('distill', `活跃 memories: ${active.length}`)

    // cluster by keyword overlap (同 distill.ts 的 clusterByKeywords)
    const CJK_WORD = /[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi
    const clusters: any[][] = []
    const assigned = new Set<number>()
    for (let i = 0; i < active.length; i++) {
      if (assigned.has(i)) continue
      const cluster = [active[i]]
      assigned.add(i)
      const wordsI = new Set((active[i].content.match(CJK_WORD) || []).map((w: string) => w.toLowerCase()))
      if (wordsI.size === 0) continue
      for (let j = i + 1; j < active.length; j++) {
        if (assigned.has(j)) continue
        const wordsJ = new Set((active[j].content.match(CJK_WORD) || []).map((w: string) => w.toLowerCase()))
        if (wordsJ.size === 0) continue
        let hits = 0
        for (const w of wordsI) { if (wordsJ.has(w)) hits++ }
        const overlap = hits / Math.max(1, Math.min(wordsI.size, wordsJ.size))
        if (overlap >= 0.35) {
          cluster.push(active[j])
          assigned.add(j)
        }
      }
      if (cluster.length >= 2) clusters.push(cluster)
    }
    log('distill', `聚类出 ${clusters.length} 个 cluster`)

    // 对每个 cluster 执行 zero-LLM 蒸馏并直接写入 SQLite
    let nodesCreated = 0
    for (const cluster of clusters) {
      const contents = cluster.map((m: any) => m.content)
      // 简化版 zero-LLM distill
      const allText = contents.join(' ')
      const parts: string[] = []

      // 提取 facts
      try {
        const extractFacts = factStore.extractFacts
        if (extractFacts) {
          const allFacts: any[] = []
          for (const c of contents) {
            const fs = extractFacts(c)
            for (const f of fs) allFacts.push(f)
          }
          const uniqueFacts = allFacts.filter((f: any, i: number) =>
            allFacts.findIndex((x: any) => x.subject === f.subject && x.predicate === f.predicate && x.object === f.object) === i
          ).slice(0, 3)
          if (uniqueFacts.length > 0) {
            parts.push(uniqueFacts.map((f: any) => `${f.subject}${f.predicate}${f.object}`).join('，'))
          }
        }
      } catch {}

      // 提取实体
      try {
        const mentioned = graph.findMentionedEntities
        if (mentioned) {
          const ec = new Map<string, number>()
          for (const c of contents) {
            const es = mentioned(c)
            for (const e of es) ec.set(e, (ec.get(e) ?? 0) + 1)
          }
          const core = [...ec.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n)
          if (core.length > 0 && parts.length === 0) parts.push(`涉及：${core.join('、')}`)
        }
      } catch {}

      // 行为提取
      const likeMatch = allText.match(/(?:喜欢|爱|偏好)(.{2,15}?)(?=[，。！？\s]|$)/g)
      if (likeMatch) for (const m of likeMatch.slice(0, 2)) parts.push(m.replace(/[，。！？\s]+$/, ''))
      const habitMatch = allText.match(/(?:每天|经常|习惯|总是)(.{2,20}?)(?=[，。！？\s]|$)/g)
      if (habitMatch) parts.push(habitMatch[0].replace(/[，。！？\s]+$/, ''))

      const summary = parts.join('；')
      if (summary.length < 8) continue  // 信息量不够

      // 从第一条记忆提取主题名
      const topicName = cluster[0].content.slice(0, 15).replace(/[，。！？\s]+$/, '') || '未分类'
      const node = {
        topic: topicName.slice(0, 20),
        summary: summary.slice(0, 200),
        sourceCount: cluster.length,
        lastUpdated: Date.now(),
        userId: cluster[0].userId || undefined,
        hitCount: 0,
        missCount: 0,
        lastHitTs: 0,
        stale: false,
        confidence: 0.5,
      }

      try {
        sqliteStore.dbSaveTopicNode(node)
        nodesCreated++
      } catch (e: any) {
        warn('distill', `保存 topic node 失败: ${e.message}`)
      }
    }
    log('distill', `直接创建了 ${nodesCreated} 个 topic nodes`)
  }

  // 尝试调用 L2→L3（mental model 更新）
  try { distill.runDistillPipeline() } catch {}
  try { distill.distillL2toL3() } catch {}

  const afterStats = distill.getDistillStats()
  log('distill', `完成: ${afterStats.topicNodes} topic nodes, ${afterStats.mentalModels} mental models`)

  // ══════════════════════════════════════════════════════════════
  // STEP 3: Trigger Deep Understand
  // ══════════════════════════════════════════════════════════════
  log('deep-understand', '=== 触发深层理解 ===')
  const du = require('../cc-soul/deep-understand.ts')
  try {
    du.updateDeepUnderstand()
    const duCtx = du.getDeepUnderstandContext()
    log('deep-understand', `完成: ${duCtx || '(数据不足，需要>=10条chatHistory)'}`)
  } catch (e: any) {
    warn('deep-understand', `错误: ${e.message}`)
  }

  // ══════════════════════════════════════════════════════════════
  // STEP 4: Trigger Person Model
  // ══════════════════════════════════════════════════════════════
  log('person-model', '=== 触发人格模型 ===')
  const personModel = require('../cc-soul/person-model.ts')

  // 4a. updateLivingProfile — 从 memories 提取身份信息
  log('person-model', '更新 Living Profile...')
  let profileUpdates = 0
  for (const mem of memories) {
    if (mem.scope === 'expired' || mem.scope === 'decayed') continue
    const importance = mem.importance ?? 5
    if (importance >= 5) {
      try {
        // 传入 importance >= 7 以通过阈值检查
        personModel.updateLivingProfile(mem.content, mem.scope || 'general', Math.max(importance, 7))
        profileUpdates++
      } catch {}
    }
  }
  log('person-model', `处理了 ${profileUpdates} 条记忆`)

  // 4b. distillPersonModel
  log('person-model', '蒸馏 Person Model...')
  try {
    personModel.distillPersonModel()
  } catch (e: any) {
    warn('person-model', `distillPersonModel: ${e.message}`)
  }

  // 4c. crystallizeTraits
  log('person-model', '结晶 traits...')
  try {
    const n = personModel.crystallizeTraits()
    log('person-model', `结晶了 ${n} 个 traits`)
  } catch (e: any) {
    warn('person-model', `crystallizeTraits: ${e.message}`)
  }

  // ══════════════════════════════════════════════════════════════
  // STEP 5: PageRank
  // ══════════════════════════════════════════════════════════════
  log('graph', '计算 PageRank...')
  try {
    graph.computePageRank()
    log('graph', `PageRank 完成: ${graph.graphState.ranks.size} 个节点`)
  } catch (e: any) {
    warn('graph', `PageRank: ${e.message}`)
  }

  // ══════════════════════════════════════════════════════════════
  // 最终汇总
  // ══════════════════════════════════════════════════════════════
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  const finalDistillStats = distill.getDistillStats()

  console.log('\n' + '='.repeat(60))
  console.log('  重建完成汇总')
  console.log('='.repeat(60))
  console.log(`  耗时: ${elapsed}s`)
  console.log(`  Memories: ${memories.length}`)
  console.log(`  Facts: ${facts.length}`)
  console.log(`  Chat History: ${chatHistory.length}`)
  console.log('-'.repeat(60))
  console.log(`  Entity Graph: ${beforeEntities} -> ${graph.graphState.entities.length} entities`)
  console.log(`                ${beforeRelations} -> ${graph.graphState.relations.length} relations`)
  console.log(`                ${graph.graphState.ranks.size} ranked nodes`)
  console.log('-'.repeat(60))
  console.log(`  Distill: ${beforeStats.topicNodes} -> ${finalDistillStats.topicNodes} topic nodes`)
  console.log(`           ${beforeStats.mentalModels} -> ${finalDistillStats.mentalModels} mental models`)
  console.log('-'.repeat(60))
  const duCtx = du.getDeepUnderstandContext()
  console.log(`  Deep Understand: ${duCtx ? 'POPULATED' : 'EMPTY (needs >=10 chatHistory)'}`)
  if (duCtx) console.log(`    ${duCtx.slice(0, 150)}`)
  console.log('-'.repeat(60))
  try {
    const pm = personModel.getPersonModel()
    const profile = personModel.getLivingProfile()
    const summary = personModel.getLivingProfileSummary()
    console.log(`  Person Model: identity="${(pm.identity || '(空)').slice(0, 60)}"`)
    console.log(`                ${pm.values?.length || 0} values, ${pm.styleMarkers?.length || 0} style markers`)
    console.log(`  Living Profile: v${profile.version}, name="${profile.identity?.name || '(空)'}", ${profile.traits?.length || 0} traits`)
    if (summary) console.log(`    ${summary.slice(0, 150)}`)
  } catch {}
  console.log('='.repeat(60))

  // 等待异步 CLI 任务完成
  log('cleanup', '等待异步 CLI 任务...')
  await new Promise(r => setTimeout(r, 3000))

  // 重新获取 distill stats（CLI 回调可能已完成）
  const finalStats2 = distill.getDistillStats()
  if (finalStats2.topicNodes !== finalDistillStats.topicNodes) {
    log('distill', `异步更新后: ${finalStats2.topicNodes} topic nodes`)
  }

  log('done', `全部完成 (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
}

main().catch(e => {
  console.error(`[rebuild] 致命错误: ${e.message}`)
  console.error(e.stack)
  process.exit(1)
})
