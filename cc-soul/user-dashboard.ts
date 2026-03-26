/**
 * user-dashboard.ts — User-facing statistics
 *
 * Users can see their own stats via chat commands.
 * Not a web page — just formatted text responses.
 */

import type { SoulModule } from './brain.ts'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { DATA_DIR } from './persistence.ts'
import { memoryState, getRecallRate } from './memory.ts'
import { evalMetrics, computeEval } from './quality.ts'
import { graphState } from './graph.ts'
import { rules, hypotheses } from './evolution.ts'
import { body, bodyGetParams, emotionVector } from './body.ts'
import { getAllFeatures } from './features.ts'
import { getEpistemicSummary, getWeakDomains } from './epistemic.ts'
import { getProfile, getPersonaUsageSummary, profiles } from './user-profiles.ts'
import { innerState } from './inner-life.ts'
import { lorebookEntries } from './lorebook.ts'
import { skillLibrary } from './tasks.ts'

/**
 * Handle user dashboard commands.
 * Returns formatted stats text or empty string if not a dashboard command.
 */
export function handleDashboardCommand(msg: string, senderId: string, totalMessages: number, corrections: number): string {
  const m = msg.trim().toLowerCase()

  // Full stats
  if (m === 'my stats' || m === 'stats' || m === '我的数据' || m === '数据统计' || m === 'dashboard') {
    return buildFullDashboard(senderId, totalMessages, corrections)
  }

  // Memory stats (enhanced)
  if (m === 'memory stats' || m === '记忆统计') {
    return generateMemoryStats()
  }

  // Memory map / Mermaid visualization
  if (m === '记忆图谱' || m === 'memory map' || m === 'm') {
    return generateMemoryMap()
  }

  // Memory map HTML (handled in handler.ts via dynamic import, but also here for completeness)
  if (m === '记忆图谱 html' || m === 'memory map html') {
    return `正在生成 HTML 图谱...`
  }

  // Knowledge boundary
  if (m === 'knowledge map' || m === '知识地图' || m === 'domains') {
    return buildKnowledgeMap(totalMessages, corrections)
  }

  // Soul state
  if (m === 'soul state' || m === '灵魂状态' || m === 'soul') {
    return buildSoulState(totalMessages, corrections)
  }

  return ''
}

function buildFullDashboard(senderId: string, totalMessages: number, corrections: number): string {
  const profile = senderId ? getProfile(senderId) : null
  const eval_ = computeEval(totalMessages, corrections)
  const params = bodyGetParams()
  const features = getAllFeatures()
  const enabledCount = Object.values(features).filter(v => v === true).length
  const totalFeatures = Object.keys(features).filter(k => !k.startsWith('_')).length

  const taggedMem = memoryState.memories.filter(m => m.tags && m.tags.length > 0).length
  const expiredMem = memoryState.memories.filter(m => m.scope === 'expired').length

  const lines: string[] = [
    '🧠 cc-soul Dashboard',
    '═══════════════════════════════',
    '',
    '📊 Overview',
    `  Messages: ${totalMessages}`,
    `  Corrections: ${corrections} (${totalMessages > 0 ? (corrections / totalMessages * 100).toFixed(1) : 0}%)`,
    `  Quality: ${eval_.avgQuality}/10`,
    `  Features: ${enabledCount}/${totalFeatures} enabled`,
    '',
    '🧠 Memory',
    `  Total: ${memoryState.memories.length}`,
    `  Tagged: ${taggedMem} (${memoryState.memories.length > 0 ? (taggedMem / memoryState.memories.length * 100).toFixed(0) : 0}%)`,
    `  Expired: ${expiredMem}`,
    `  Lorebook: ${lorebookEntries.filter(e => e.enabled).length} entries`,
    `  Skills: ${skillLibrary.length}`,
    (() => {
      const r = getRecallRate()
      return r.total > 0
        ? `  记忆召回率: ${r.rate.toFixed(0)}% (最近 ${r.total} 次查询中命中 ${r.successful} 次)`
        : `  记忆召回率: -- (暂无查询数据)`
    })(),
    '',
    '💪 Body State',
    `  Energy: ${(body.energy * 100).toFixed(0)}%`,
    `  Mood: ${body.mood > 0.3 ? '😊 positive' : body.mood < -0.3 ? '😔 low' : '😐 neutral'} (${body.mood.toFixed(2)})`,
    `  Alertness: ${(body.alertness * 100).toFixed(0)}%`,
    `  Style: ${params.responseStyle}`,
    '',
    '🔬 Knowledge',
    `  Entities: ${graphState.entities.length}`,
    `  Rules: ${rules.length}`,
    `  Hypotheses: ${hypotheses.filter(h => h.status === 'active').length} active`,
  ]

  // Weak domains
  const weakDomains = getWeakDomains()
  if (weakDomains.length > 0) {
    lines.push(`  ⚠️ Weak areas: ${weakDomains.join(', ')}`)
  }

  // User profile
  if (profile) {
    lines.push('')
    lines.push('👤 Your Profile')
    lines.push(`  Tier: ${profile.tier}`)
    lines.push(`  Style: ${profile.style}`)
    lines.push(`  Messages: ${profile.messageCount}`)
    if (profile.corrections > 0) {
      lines.push(`  Corrections: ${profile.corrections}`)
    }
  }

  // Persona usage history
  if (senderId) {
    const personaSummary = getPersonaUsageSummary(senderId)
    if (personaSummary) {
      lines.push('')
      lines.push(personaSummary)
    }
  }

  // Recent journal
  if (innerState.journal.length > 0) {
    lines.push('')
    lines.push('📝 Recent Thoughts')
    for (const j of innerState.journal.slice(-3)) {
      lines.push(`  ${j.time} — ${j.thought.slice(0, 60)}`)
    }
  }

  lines.push('')
  lines.push('Commands: stats | memory stats | m/记忆图谱 | knowledge map | soul state | feature status')

  return lines.join('\n')
}

/**
 * generateMemoryStats — enhanced memory statistics
 * Includes: scope breakdown, 7-day new count, top 5 topics, quality distribution
 */
export function generateMemoryStats(): string {
  const mems = memoryState.memories
  const total = Math.max(1, mems.length)

  // ── By scope ──
  const byScope = new Map<string, number>()
  for (const m of mems) {
    byScope.set(m.scope, (byScope.get(m.scope) || 0) + 1)
  }

  const lines: string[] = [
    '🧠 Memory Statistics',
    '═══════════════════════════════',
    `Total: ${mems.length} / 10,000 capacity`,
    '',
    '── By Scope ──',
  ]

  const sortedScopes = [...byScope.entries()].sort((a, b) => b[1] - a[1])
  for (const [scope, count] of sortedScopes) {
    const bar = '█'.repeat(Math.ceil(count / total * 20))
    lines.push(`  ${scope.padEnd(15)} ${count.toString().padStart(5)} ${bar}`)
  }

  // ── 7-day new count ──
  const sevenDaysAgo = Date.now() - 7 * 86400000
  const recentCount = mems.filter(m => m.ts > sevenDaysAgo).length
  lines.push('')
  lines.push(`── Recent 7 Days ──`)
  lines.push(`  New memories: ${recentCount}`)

  // ── Top 5 topics (by tag frequency) ──
  const tagFreq = new Map<string, number>()
  for (const m of mems) {
    if (m.tags) {
      for (const tag of m.tags) {
        tagFreq.set(tag, (tagFreq.get(tag) || 0) + 1)
      }
    }
  }
  const topTags = [...tagFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  if (topTags.length > 0) {
    lines.push('')
    lines.push('── Top 5 Topics ──')
    for (const [tag, count] of topTags) {
      lines.push(`  ${tag.padEnd(20)} ${count}`)
    }
  }

  // ── Quality distribution (confidence buckets) ──
  const buckets = { high: 0, medium: 0, low: 0, expired: 0 }
  for (const m of mems) {
    const conf = m.confidence ?? 0.7
    if (m.scope === 'expired') buckets.expired++
    else if (conf >= 0.7) buckets.high++
    else if (conf >= 0.4) buckets.medium++
    else buckets.low++
  }
  lines.push('')
  lines.push('── Quality Distribution ──')
  lines.push(`  High (>=0.7):  ${buckets.high}`)
  lines.push(`  Medium (0.4-0.7): ${buckets.medium}`)
  lines.push(`  Low (<0.4):    ${buckets.low}`)
  lines.push(`  Expired:       ${buckets.expired}`)

  // ── Extras ──
  const tagged = mems.filter(m => m.tags && m.tags.length > 0).length
  const withEmotion = mems.filter(m => m.emotion && m.emotion !== 'neutral').length
  lines.push('')
  lines.push(`Tagged: ${tagged} (${(tagged / total * 100).toFixed(0)}%)`)
  lines.push(`Emotional: ${withEmotion}`)
  lines.push(`Chat history: ${memoryState.chatHistory.length} turns`)
  lines.push(`Lorebook: ${lorebookEntries.filter(e => e.enabled).length} active entries`)
  lines.push(`Skills: ${skillLibrary.length} saved`)

  return lines.join('\n')
}

function buildKnowledgeMap(totalMessages: number, corrections: number): string {
  const summary = getEpistemicSummary()

  const lines: string[] = [
    '🔬 Knowledge Map',
    '═══════════════════════════════',
  ]

  if (summary) {
    lines.push(summary)
  } else {
    lines.push('Not enough data yet. Need more conversations to build domain calibration.')
  }

  if (graphState.entities.length > 0) {
    lines.push('')
    lines.push(`Entity Graph: ${graphState.entities.length} entities, ${graphState.relations.length} relations`)
    const top = [...graphState.entities].sort((a, b) => b.mentions - a.mentions).slice(0, 5)
    for (const e of top) {
      lines.push(`  ${e.name} [${e.type}] — ${e.mentions} mentions`)
    }
  }

  return lines.join('\n')
}

function buildSoulState(totalMessages: number, corrections: number): string {
  const lines: string[] = [
    '💫 Soul State',
    '═══════════════════════════════',
    '',
    `Energy: ${'█'.repeat(Math.round(body.energy * 10))}${'░'.repeat(10 - Math.round(body.energy * 10))} ${(body.energy * 100).toFixed(0)}%`,
    `Mood: ${'█'.repeat(Math.round((body.mood + 1) * 5))}${'░'.repeat(10 - Math.round((body.mood + 1) * 5))} ${body.mood.toFixed(2)}`,
    `Alertness: ${'█'.repeat(Math.round(body.alertness * 10))}${'░'.repeat(10 - Math.round(body.alertness * 10))} ${(body.alertness * 100).toFixed(0)}%`,
    `Anomaly: ${'█'.repeat(Math.round(body.anomaly * 10))}${'░'.repeat(10 - Math.round(body.anomaly * 10))} ${(body.anomaly * 100).toFixed(0)}%`,
  ]

  // ── Mood trend (7d) ──
  lines.push('', '── Mood Trend (7d) ──')
  try {
    const moodHistPath = resolve(DATA_DIR, 'mood_history.json')
    if (existsSync(moodHistPath)) {
      const moodHist: { ts: number; mood: number; energy: number }[] = JSON.parse(readFileSync(moodHistPath, 'utf-8'))
      const sevenDays = moodHist.filter(s => Date.now() - s.ts < 7 * 86400000)
      if (sevenDays.length >= 2) {
        const firstHalf = sevenDays.slice(0, Math.floor(sevenDays.length / 2))
        const secondHalf = sevenDays.slice(Math.floor(sevenDays.length / 2))
        const avgFirst = firstHalf.reduce((s, d) => s + d.mood, 0) / firstHalf.length
        const avgSecond = secondHalf.reduce((s, d) => s + d.mood, 0) / secondHalf.length
        const trend = avgSecond - avgFirst > 0.1 ? '📈 improving' : avgSecond - avgFirst < -0.1 ? '📉 declining' : '➡️ stable'
        lines.push(`  Trend: ${trend} (${avgFirst.toFixed(2)} → ${avgSecond.toFixed(2)})`)
        lines.push(`  Samples: ${sevenDays.length}`)
      } else {
        lines.push('  Not enough data')
      }
    }
  } catch { lines.push('  (unavailable)') }

  if (innerState.evolvedSoul) {
    lines.push('')
    lines.push('Self-narrative:')
    lines.push(`  "${innerState.evolvedSoul.slice(0, 150)}"`)
  }

  if (innerState.journal.length > 0) {
    lines.push('')
    lines.push('Latest thoughts:')
    for (const j of innerState.journal.slice(-5)) {
      lines.push(`  ${j.time} [${j.type}] ${j.thought.slice(0, 50)}`)
    }
  }

  return lines.join('\n')
}

/**
 * generateMemoryMap — Mermaid graph TD format memory/entity relationship map
 * Nodes: entities (from graphState) + high-priority memories as supplement
 * Edges: relations (from graphState)
 * Limit: max 30 nodes (Mermaid rendering constraint)
 */
export function generateMemoryMap(): string {
  const MAX_NODES = 30
  const nodeIds = new Map<string, string>()  // name -> mermaid id
  let idCounter = 0

  function getNodeId(name: string): string {
    if (nodeIds.has(name)) return nodeIds.get(name)!
    const id = String.fromCharCode(65 + Math.floor(idCounter / 26)) + String.fromCharCode(65 + (idCounter % 26))
    idCounter++
    nodeIds.set(name, id)
    return id
  }

  // Sanitize label for Mermaid (escape quotes, pipes, brackets)
  function sanitize(s: string): string {
    return s.replace(/["[\]|{}()]/g, ' ').replace(/\s+/g, ' ').trim()
  }

  const lines: string[] = ['📊 cc 记忆图谱 (Mermaid)\n']
  lines.push('```mermaid')
  lines.push('graph TD')

  // 1. Collect entity nodes sorted by mentions (top N)
  const topEntities = [...graphState.entities]
    .filter(e => !e.invalid_at)
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, MAX_NODES)

  if (topEntities.length === 0 && graphState.relations.length === 0) {
    lines.pop() // remove 'graph TD'
    lines.pop() // remove '```mermaid'
    lines.push('实体图谱为空，需要更多对话来构建知识网络。')
    lines.push('')
    lines.push('Tips: 聊天中提到的人物、项目、工具会自动提取为实体节点。')
    return lines.join('\n')
  }

  // Pre-register all entity names
  const entityNames = new Set(topEntities.map(e => e.name))
  for (const e of topEntities) {
    getNodeId(e.name)
  }

  // 2. Collect relations involving top entities
  const usedRelations: { source: string; target: string; type: string }[] = []
  for (const r of graphState.relations) {
    if (!r.invalid_at && (entityNames.has(r.source) || entityNames.has(r.target))) {
      // Ensure both endpoints are registered (may pull in extra nodes up to limit)
      if (nodeIds.size < MAX_NODES || (nodeIds.has(r.source) && nodeIds.has(r.target))) {
        if (!nodeIds.has(r.source) && nodeIds.size < MAX_NODES) getNodeId(r.source)
        if (!nodeIds.has(r.target) && nodeIds.size < MAX_NODES) getNodeId(r.target)
        if (nodeIds.has(r.source) && nodeIds.has(r.target)) {
          usedRelations.push({ source: r.source, target: r.target, type: r.type })
        }
      }
    }
  }

  // 3. Supplement with high-priority memories as standalone nodes (if room)
  const highPriorityMems = memoryState.memories
    .filter(m =>
      m.scope !== 'expired' &&
      (m.emotion === 'important' || m.scope === 'consolidated' || m.scope === 'correction') &&
      (m.confidence ?? 0.7) >= 0.6 &&
      m.content.length > 10
    )
    .sort((a, b) => b.ts - a.ts)

  for (const m of highPriorityMems) {
    if (nodeIds.size >= MAX_NODES) break
    const label = m.content.slice(0, 30)
    // Skip if already covered by an entity
    if (entityNames.has(label)) continue
    const memLabel = `[mem] ${label}`
    if (nodeIds.has(memLabel)) continue
    getNodeId(memLabel)
  }

  // 4. Emit node declarations
  for (const [name, id] of nodeIds) {
    const entity = graphState.entities.find(e => e.name === name)
    if (entity) {
      lines.push(`  ${id}["${sanitize(name)} (${entity.type})"]`)
    } else if (name.startsWith('[mem] ')) {
      lines.push(`  ${id}["${sanitize(name.slice(6))}"]:::mem`)
    } else {
      lines.push(`  ${id}["${sanitize(name)}"]`)
    }
  }

  // 5. Emit edges
  for (const r of usedRelations) {
    const srcId = nodeIds.get(r.source)
    const tgtId = nodeIds.get(r.target)
    if (srcId && tgtId) {
      lines.push(`  ${srcId} -->|${sanitize(r.type)}| ${tgtId}`)
    }
  }

  // 6. Style class for memory nodes
  lines.push('  classDef mem fill:#f9f,stroke:#333,stroke-width:1px')

  lines.push('```')

  // 7. Summary stats
  lines.push('')
  lines.push(`Entities: ${graphState.entities.length} | Relations: ${graphState.relations.length} | Shown: ${nodeIds.size} nodes`)

  return lines.join('\n')
}

/**
 * P1-#7: generateMemoryMapHTML — 生成独立 HTML 文件，用 vis.js CDN 渲染记忆图谱
 * Returns the output file path.
 */
export function generateMemoryMapHTML(): string {
  const MAX_NODES = 50
  const nodes: { id: number; label: string; group: string }[] = []
  const edges: { from: number; to: number; label: string }[] = []
  const nameToId = new Map<string, number>()
  let idCounter = 0

  function getId(name: string, group: string): number {
    if (nameToId.has(name)) return nameToId.get(name)!
    const id = idCounter++
    nameToId.set(name, id)
    nodes.push({ id, label: name.slice(0, 30), group })
    return id
  }

  // Entities
  const topEntities = [...graphState.entities].filter(e => !e.invalid_at).sort((a, b) => b.mentions - a.mentions).slice(0, MAX_NODES)
  for (const e of topEntities) getId(e.name, e.type)

  // Relations
  for (const r of graphState.relations) {
    if (r.invalid_at) continue
    if (nameToId.has(r.source) || nameToId.has(r.target)) {
      if (nodes.length < MAX_NODES) {
        const src = getId(r.source, 'relation')
        const tgt = getId(r.target, 'relation')
        edges.push({ from: src, to: tgt, label: r.type })
      }
    }
  }

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>cc-soul Memory Map</title>
<script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
<style>body{margin:0;font-family:system-ui}#graph{width:100vw;height:100vh}h3{position:fixed;top:8px;left:16px;z-index:1;color:#333}</style>
</head><body><h3>cc-soul Memory Map (${nodes.length} nodes, ${edges.length} edges)</h3>
<div id="graph"></div><script>
var nodes = new vis.DataSet(${JSON.stringify(nodes)});
var edges = new vis.DataSet(${JSON.stringify(edges)});
new vis.Network(document.getElementById('graph'), {nodes, edges}, {
  physics: {stabilization: {iterations: 100}},
  nodes: {shape:'dot',size:16,font:{size:12}},
  edges: {arrows:'to',font:{size:10,align:'middle'}}
});
</script></body></html>`

  const exportDir = resolve(DATA_DIR, 'export')
  if (!existsSync(exportDir)) mkdirSync(exportDir, { recursive: true })
  const outPath = resolve(exportDir, 'memory_map.html')
  writeFileSync(outPath, html, 'utf-8')
  console.log(`[cc-soul][dashboard] generated memory map HTML: ${outPath}`)
  return outPath
}

/**
 * generateDashboardHTML — 生成完整的 Web Dashboard HTML 文件
 * 包含: 记忆概览、情绪曲线、人格分布、记忆成长曲线、知识图谱
 * 数据嵌入 HTML，Chart.js CDN 渲染，独立可打开。
 * Returns output file path.
 */
export function generateDashboardHTML(): string {
  // ── 1. 记忆数据 ──
  const mems = memoryState.memories
  const scopeMap: Record<string, number> = {}
  for (const m of mems) {
    scopeMap[m.scope] = (scopeMap[m.scope] || 0) + 1
  }
  const activeCount = mems.filter(m => m.scope !== 'expired' && m.scope !== 'decayed').length

  // 记忆按天统计 (最近 30 天)
  const dayBuckets: Record<string, number> = {}
  const thirtyDaysAgo = Date.now() - 30 * 86400000
  for (const m of mems) {
    if (m.ts > thirtyDaysAgo) {
      const day = new Date(m.ts).toISOString().slice(0, 10)
      dayBuckets[day] = (dayBuckets[day] || 0) + 1
    }
  }
  const growthDays = Object.keys(dayBuckets).sort()
  const growthCounts = growthDays.map(d => dayBuckets[d])

  // ── 2. 情绪数据 (从文件读取) ──
  const moodPath = resolve(DATA_DIR, 'mood_history.json')
  let moodData: { ts: number; mood: number; energy: number; alertness: number }[] = []
  try {
    if (existsSync(moodPath)) {
      moodData = JSON.parse(readFileSync(moodPath, 'utf-8'))
    }
  } catch { /* ignore */ }
  // 最近 7 天
  const sevenDaysAgo = Date.now() - 7 * 86400000
  const recentMood = moodData.filter(s => s.ts > sevenDaysAgo)
  const moodLabels = recentMood.map(s => new Date(s.ts).toISOString().slice(5, 16).replace('T', ' '))
  const moodValues = recentMood.map(s => +s.mood.toFixed(3))
  const energyValues = recentMood.map(s => +s.energy.toFixed(3))
  const alertnessValues = recentMood.map(s => +((s as any).alertness ?? 0.5).toFixed(3))

  // ── 3. 人格使用分布 (聚合所有用户) ──
  const personaAgg: Record<string, number> = {}
  for (const [, p] of profiles) {
    if (p.personaHistory) {
      for (const h of p.personaHistory) {
        personaAgg[h.persona] = (personaAgg[h.persona] || 0) + h.count
      }
    }
  }
  const personaLabels = Object.keys(personaAgg).sort((a, b) => personaAgg[b] - personaAgg[a])
  const personaCounts = personaLabels.map(k => personaAgg[k])

  // ── 4. 知识图谱节点/边 ──
  const MAX_GRAPH = 60
  const gNodes: { id: number; label: string; group: string; size: number }[] = []
  const gEdges: { from: number; to: number; label: string }[] = []
  const nameToId = new Map<string, number>()
  let gId = 0
  function gGetId(name: string, group: string, mentions: number): number {
    if (nameToId.has(name)) return nameToId.get(name)!
    const id = gId++
    nameToId.set(name, id)
    gNodes.push({ id, label: name.slice(0, 20), group, size: Math.min(30, 8 + mentions * 2) })
    return id
  }
  const topE = [...graphState.entities].filter(e => !e.invalid_at).sort((a, b) => b.mentions - a.mentions).slice(0, MAX_GRAPH)
  for (const e of topE) gGetId(e.name, e.type, e.mentions)
  for (const r of graphState.relations) {
    if (r.invalid_at) continue
    if (nameToId.has(r.source) || nameToId.has(r.target)) {
      if (gNodes.length < MAX_GRAPH) {
        const src = gGetId(r.source, 'relation', 1)
        const tgt = gGetId(r.target, 'relation', 1)
        gEdges.push({ from: src, to: tgt, label: r.type })
      }
    }
  }

  // ── 5. 生成时间 ──
  const generatedAt = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })

  // ── HTML ──
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>cc-soul Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"><\/script>
<script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"><\/script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, 'SF Pro', 'Helvetica Neue', sans-serif; background: #0a0a0f; color: #e0e0e0; min-height: 100vh; }
  .header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 24px 32px; border-bottom: 1px solid #2a2a4a; display: flex; justify-content: space-between; align-items: center; }
  .header h1 { font-size: 24px; font-weight: 600; color: #fff; }
  .header h1 span { color: #7c6bf0; }
  .header .meta { color: #666; font-size: 13px; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; padding: 24px 32px; }
  .stat-card { background: #12121f; border: 1px solid #2a2a4a; border-radius: 12px; padding: 20px; }
  .stat-card .label { color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
  .stat-card .value { font-size: 28px; font-weight: 700; color: #fff; margin-top: 6px; }
  .stat-card .value.purple { color: #7c6bf0; }
  .stat-card .value.green { color: #4ade80; }
  .stat-card .value.blue { color: #60a5fa; }
  .stat-card .value.orange { color: #fb923c; }
  .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; padding: 0 32px 24px; }
  .chart-box { background: #12121f; border: 1px solid #2a2a4a; border-radius: 12px; padding: 20px; }
  .chart-box h3 { font-size: 15px; color: #aaa; margin-bottom: 12px; font-weight: 500; }
  .chart-box canvas { width: 100% !important; max-height: 280px; }
  .full-width { grid-column: 1 / -1; }
  #graph-container { width: 100%; height: 420px; border-radius: 8px; overflow: hidden; }
  @media (max-width: 800px) { .charts { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="header">
  <h1><span>cc-soul</span> Dashboard</h1>
  <div class="meta">Generated: ${generatedAt}</div>
</div>

<div class="stats-grid">
  <div class="stat-card"><div class="label">Total Memories</div><div class="value purple">${mems.length}</div></div>
  <div class="stat-card"><div class="label">Active</div><div class="value green">${activeCount}</div></div>
  <div class="stat-card"><div class="label">Entities</div><div class="value blue">${graphState.entities.length}</div></div>
  <div class="stat-card"><div class="label">Relations</div><div class="value orange">${graphState.relations.length}</div></div>
  <div class="stat-card"><div class="label">Scopes</div><div class="value">${Object.keys(scopeMap).length}</div></div>
  <div class="stat-card"><div class="label">Mood Snapshots</div><div class="value">${moodData.length}</div></div>
</div>

<div class="charts">
  <!-- 记忆 scope 分布饼图 -->
  <div class="chart-box">
    <h3>Memory Scope Distribution</h3>
    <canvas id="scopeChart"></canvas>
  </div>

  <!-- 人格使用分布柱状图 -->
  <div class="chart-box">
    <h3>Persona Usage</h3>
    <canvas id="personaChart"></canvas>
  </div>

  <!-- 情绪曲线 -->
  <div class="chart-box">
    <h3>Mood & Energy (7 Days)</h3>
    <canvas id="moodChart"></canvas>
  </div>

  <!-- PADCN 雷达图 -->
  <div class="chart-box">
    <h3>PADCN Emotion Vector</h3>
    <canvas id="padcnChart"></canvas>
  </div>

  <!-- 记忆成长曲线 -->
  <div class="chart-box">
    <h3>Memory Growth (30 Days)</h3>
    <canvas id="growthChart"></canvas>
  </div>

  <!-- 知识图谱 -->
  <div class="chart-box full-width">
    <h3>Knowledge Graph (${gNodes.length} nodes, ${gEdges.length} edges)</h3>
    <div id="graph-container"></div>
  </div>
</div>

<script>
const COLORS = ['#7c6bf0','#4ade80','#60a5fa','#fb923c','#f87171','#fbbf24','#a78bfa','#34d399','#f472b6','#38bdf8','#818cf8','#facc15'];
const scopeData = ${JSON.stringify(scopeMap)};
const moodLabels = ${JSON.stringify(moodLabels)};
const moodValues = ${JSON.stringify(moodValues)};
const energyValues = ${JSON.stringify(energyValues)};
const personaLabels = ${JSON.stringify(personaLabels)};
const personaCounts = ${JSON.stringify(personaCounts)};
const growthDays = ${JSON.stringify(growthDays)};
const growthCounts = ${JSON.stringify(growthCounts)};
const gNodes = ${JSON.stringify(gNodes)};
const gEdges = ${JSON.stringify(gEdges)};

// Scope 饼图
new Chart(document.getElementById('scopeChart'), {
  type: 'doughnut',
  data: {
    labels: Object.keys(scopeData),
    datasets: [{ data: Object.values(scopeData), backgroundColor: COLORS.slice(0, Object.keys(scopeData).length), borderWidth: 0 }]
  },
  options: { responsive: true, plugins: { legend: { position: 'right', labels: { color: '#aaa', font: { size: 12 } } } } }
});

// 人格柱状图
new Chart(document.getElementById('personaChart'), {
  type: 'bar',
  data: {
    labels: personaLabels,
    datasets: [{ label: 'Usage', data: personaCounts, backgroundColor: COLORS.slice(0, personaLabels.length), borderWidth: 0, borderRadius: 4 }]
  },
  options: { responsive: true, indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#888' }, grid: { color: '#1e1e35' } }, y: { ticks: { color: '#ccc', font: { size: 11 } }, grid: { display: false } } } }
});

// 情绪折线图
new Chart(document.getElementById('moodChart'), {
  type: 'line',
  data: {
    labels: moodLabels,
    datasets: [
      { label: 'Mood', data: moodValues, borderColor: '#7c6bf0', backgroundColor: 'rgba(124,107,240,0.1)', fill: true, tension: 0.3, pointRadius: 1 },
      { label: 'Energy', data: energyValues, borderColor: '#4ade80', backgroundColor: 'rgba(74,222,128,0.05)', fill: true, tension: 0.3, pointRadius: 1 }
    ]
  },
  options: { responsive: true, plugins: { legend: { labels: { color: '#aaa' } } }, scales: { x: { ticks: { color: '#666', maxTicksLimit: 12, font: { size: 10 } }, grid: { color: '#1e1e35' } }, y: { min: -1, max: 1, ticks: { color: '#888' }, grid: { color: '#1e1e35' } } } }
});

// PADCN 雷达图
const padcnData = ${JSON.stringify({
    P: +(emotionVector.pleasure ?? 0).toFixed(2),
    A: +(emotionVector.arousal ?? 0).toFixed(2),
    D: +(emotionVector.dominance ?? 0).toFixed(2),
    C: +(emotionVector.certainty ?? 0).toFixed(2),
    N: +(emotionVector.novelty ?? 0).toFixed(2),
  })};
new Chart(document.getElementById('padcnChart'), {
  type: 'radar',
  data: {
    labels: ['Pleasure','Arousal','Dominance','Certainty','Novelty'],
    datasets: [{
      label: 'Current',
      data: [padcnData.P, padcnData.A, padcnData.D, padcnData.C, padcnData.N],
      borderColor: '#7c6bf0',
      backgroundColor: 'rgba(124,107,240,0.2)',
      pointBackgroundColor: '#7c6bf0'
    }]
  },
  options: {
    responsive: true,
    scales: { r: { min: -1, max: 1, ticks: { color: '#888', stepSize: 0.5 }, grid: { color: '#2a2a4a' }, pointLabels: { color: '#ccc' } } },
    plugins: { legend: { display: false } }
  }
});

// 记忆成长折线图
new Chart(document.getElementById('growthChart'), {
  type: 'line',
  data: {
    labels: growthDays.map(d => d.slice(5)),
    datasets: [{ label: 'New Memories', data: growthCounts, borderColor: '#60a5fa', backgroundColor: 'rgba(96,165,250,0.15)', fill: true, tension: 0.3, pointRadius: 2 }]
  },
  options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#888', font: { size: 10 } }, grid: { color: '#1e1e35' } }, y: { beginAtZero: true, ticks: { color: '#888' }, grid: { color: '#1e1e35' } } } }
});

// 知识图谱 (vis.js)
if (gNodes.length > 0) {
  const groupColors = { person: '#7c6bf0', project: '#4ade80', tool: '#60a5fa', concept: '#fbbf24', relation: '#888', event: '#f87171' };
  const visNodes = new vis.DataSet(gNodes.map(n => ({
    id: n.id, label: n.label, size: n.size,
    color: { background: groupColors[n.group] || '#888', border: 'transparent', highlight: { background: '#fff', border: groupColors[n.group] || '#888' } },
    font: { color: '#ddd', size: 11 }
  })));
  const visEdges = new vis.DataSet(gEdges.map(e => ({ from: e.from, to: e.to, label: e.label, font: { size: 9, color: '#666' }, color: { color: '#333', highlight: '#7c6bf0' }, arrows: 'to' })));
  new vis.Network(document.getElementById('graph-container'), { nodes: visNodes, edges: visEdges }, {
    physics: { stabilization: { iterations: 150 }, barnesHut: { gravitationalConstant: -3000, springLength: 120 } },
    interaction: { hover: true, tooltipDelay: 200 }
  });
} else {
  document.getElementById('graph-container').innerHTML = '<div style="color:#555;text-align:center;padding:80px">No entities yet. Chat more to build the knowledge graph.</div>';
}
<\/script>
</body>
</html>`

  const exportDir = resolve(DATA_DIR, 'export')
  if (!existsSync(exportDir)) mkdirSync(exportDir, { recursive: true })
  const outPath = resolve(exportDir, 'dashboard.html')
  writeFileSync(outPath, html, 'utf-8')
  console.log(`[cc-soul][dashboard] generated web dashboard: ${outPath}`)
  return outPath
}

// ── SoulModule registration ──

export const userDashboardModule: SoulModule = {
  id: 'user-dashboard',
  name: '用户仪表盘',
  priority: 50,
}
