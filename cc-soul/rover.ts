/**
 * rover.ts — Web Rover: autonomous web roaming and learning
 *
 * 每小时自动搜索老板最近聊过的话题，学到的东西存记忆（标记[未验证]）。
 * 使用 WebSearch + WebFetch 真正上网搜索，不靠训练数据编。
 */

import type { SoulModule } from './brain.ts'
import { ROVER_PATH, loadJson, debouncedSave } from './persistence.ts'
import { spawnCLI } from './cli.ts'
import { memoryState, addMemory, recall } from './memory.ts'
import { graphState } from './graph.ts'
import { notifySoulActivity, notifyOwnerDM } from './notify.ts'
import { getWeakDomains } from './epistemic.ts'

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

export let roverState = loadJson<{
  lastRoam: number
  lastTechRadar?: number
  topics: string[]
  discoveries: { topic: string; insight: string; ts: number; verified: boolean }[]
}>(ROVER_PATH, { lastRoam: 0, topics: [], discoveries: [] })

// ═══════════════════════════════════════════════════════════════════════════════
// TOPIC SELECTION — from recent conversations + weak domains
// ═══════════════════════════════════════════════════════════════════════════════

// Priority topics from corrections (domains where cc was wrong)
const correctionTopics: string[] = []

export function addCorrectionTopic(topic: string) {
  if (!correctionTopics.includes(topic)) {
    correctionTopics.push(topic)
    if (correctionTopics.length > 10) correctionTopics.shift()
  }
}

export function pickRoamTopic(): { topic: string; isWeak: boolean } | null {
  const alreadyRoamed = new Set(roverState.topics.slice(-20))

  // Priority 0: topics from recent corrections (補課)
  if (correctionTopics.length > 0) {
    const topic = correctionTopics.shift()
    if (topic) return { topic, isWeak: true }
  }

  // Priority 1: Learn about epistemic weak domains (70% chance when available)
  const weakDomains = getWeakDomains()
  if (weakDomains.length > 0 && Math.random() > 0.3) {
    const fresh = weakDomains.filter(d => !alreadyRoamed.has(d))
    if (fresh.length > 0) return { topic: fresh[0], isWeak: true }
  }

  // Priority 2: Extract from recent chat history (actual conversation topics)
  const recentHistory = memoryState.chatHistory.slice(-20)
  const chatTopics: string[] = []
  for (const turn of recentHistory) {
    const words = (turn.user || '').match(/[\u4e00-\u9fff]{3,}/g)
    if (words) {
      for (const w of words) {
        if (w.length >= 3 && !chatTopics.includes(w)) chatTopics.push(w)
      }
    }
  }

  // Priority 3: Tech entities from graph
  const techEntities = graphState.entities.filter(e => e.type === 'tech').map(e => e.name)
  const allTopics = [...new Set([...chatTopics.slice(-10), ...techEntities.slice(-5)])]

  if (allTopics.length === 0) return null

  const fresh = allTopics.filter(t => !alreadyRoamed.has(t))
  const pool = fresh.length > 0 ? fresh : allTopics

  return { topic: pool[Math.floor(Math.random() * pool.length)], isWeak: false }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MEMORY-ENRICHED TOPIC — recall user context to sharpen search queries
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 搜索前先查记忆，从用户偏好/背景中提取关键词来增强搜索词。
 * 例如 topic="Python异步" + 记忆里有"Flask+多线程" → "Python异步 Flask 多线程 最佳实践"
 */
export function enrichTopicWithMemory(topic: string): string {
  const related = recall(topic, 3)
  if (related.length === 0) return topic

  // 从记忆内容中提取技术关键词（中文3+字、英文技术词3+字母）
  const topicWordsLower = new Set(
    (topic.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase())
  )
  const extraKeywords: string[] = []

  for (const mem of related) {
    const words = mem.content.match(/[\u4e00-\u9fff]{3,}|[a-zA-Z][a-zA-Z0-9.+-]{2,}/g) || []
    for (const w of words) {
      const wLower = w.toLowerCase()
      // 跳过已在 topic 里的词、噪声标记、过短词
      if (topicWordsLower.has(wLower)) continue
      if (/^\[|^发现|^漫游|^未验证|^纠正/.test(w)) continue
      if (w.length < 3) continue
      if (!extraKeywords.includes(w) && extraKeywords.length < 6) {
        extraKeywords.push(w)
      }
    }
  }

  if (extraKeywords.length === 0) return topic
  console.log(`[cc-soul][rover] enriched topic: "${topic}" + [${extraKeywords.join(', ')}]`)
  return `${topic} ${extraKeywords.join(' ')}`
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEB ROAM — real web search via Claude + WebSearch/WebFetch
// ═══════════════════════════════════════════════════════════════════════════════

let activeRoverCount = 0

export function webRoam() {
  const now = Date.now()
  // 每小时一次
  if (now - roverState.lastRoam < 3600000) return
  // Need at least 10 memories to know what user cares about
  if (memoryState.memories.length < 10) return
  // Don't stack up
  if (activeRoverCount > 0) return

  const picked = pickRoamTopic()
  if (!picked) return

  const { topic, isWeak } = picked

  roverState.lastRoam = now
  roverState.topics.push(topic)
  if (roverState.topics.length > 50) roverState.topics = roverState.topics.slice(-40)

  const label = isWeak ? '📖 补课' : '🌐 漫游'
  console.log(`[cc-soul][rover] ${label}: ${topic}`)
  notifySoulActivity(`${label}学习: ${topic}`).catch(() => {})

  // 用记忆中的用户偏好/背景关键词增强搜索词
  const enrichedTopic = enrichTopicWithMemory(topic)

  const prompt = isWeak
    ? `你是一个学习助手。用 WebSearch 搜索"${enrichedTopic}"领域最新、最实用的知识点。\n` +
      `必须用 WebSearch 工具真正搜索，不要靠记忆回答。\n` +
      `总结 2-3 条关键发现，每条标明信息来源。\n` +
      `格式：每条一行\n发现1: [内容] (来源: URL或网站名)\n发现2: [内容] (来源: URL或网站名)`
    : `用 WebSearch 搜索关于"${enrichedTopic}"的最新动态或有趣知识。\n` +
      `必须用 WebSearch 工具真正搜索，不要靠记忆回答。\n\n` +
      `要求：\n` +
      `1. 找到 1-3 个有价值的最新信息\n` +
      `2. 用 1-2 句话总结每个发现\n` +
      `3. 标明来源\n\n` +
      `格式：\n发现1: [内容] (来源: URL或网站名)\n发现2: [内容] (来源: URL或网站名)`

  activeRoverCount++

  spawnCLI(prompt, (output) => {
    activeRoverCount--

    if (!output || output.length < 20) {
      console.log(`[cc-soul][rover] search timeout or empty for: ${topic}`)
      return
    }

    const discoveries = output.split('\n')
      .filter(l => l.includes('发现') || l.includes(':') || l.includes('：'))
      .map(l => l.replace(/^发现\d+[:：]\s*/, '').replace(/^\[/, '').replace(/\]$/, '').trim())
      .filter(l => l.length > 10)

    const insightSummaries: string[] = []

    for (const insight of discoveries.slice(0, 3)) {
      const trimmed = insight.slice(0, 200)
      roverState.discoveries.push({ topic, insight: trimmed, ts: now, verified: false })
      addMemory(`[漫游发现][未验证] ${topic}: ${trimmed}`, 'discovery')
      insightSummaries.push(trimmed.slice(0, 80))

      // Proactive self-correction: check if new discovery contradicts past facts
      checkForSelfCorrection(trimmed)
    }

    if (roverState.discoveries.length > 100) {
      roverState.discoveries = roverState.discoveries.slice(-80)
    }

    debouncedSave(ROVER_PATH, roverState)

    // 群通知：包含具体发现内容
    const notifyText = insightSummaries.length > 0
      ? `📚 ${label}发现 ${insightSummaries.length} 条关于「${topic}」的知识:\n${insightSummaries.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      : `📚 ${label}「${topic}」未找到有价值的新信息`

    console.log(`[cc-soul][rover] learned ${discoveries.length} insights about: ${topic}`)
    notifySoulActivity(notifyText).catch(() => {})
  }, 90000, `rover-${topic.slice(0, 20)}`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// TECH RADAR — periodic scan for relevant new techniques
// ═══════════════════════════════════════════════════════════════════════════════

export function techRadarScan() {
  // Only run every 7 days
  const now = Date.now()
  if (now - (roverState.lastTechRadar || 0) < 7 * 86400000) return
  roverState.lastTechRadar = now

  const topics = [
    'AI agent memory architecture 2026',
    'LLM self-improvement techniques',
    'conversational AI personality persistence',
  ]

  const topic = topics[Math.floor(Math.random() * topics.length)]

  spawnCLI(
    `搜索最新的技术趋势："${topic}"。\n` +
    `找出 1-2 个与 AI bot 灵魂/记忆/自我进化相关的新方法或工具。\n` +
    `格式：每条一行，简洁说明是什么 + 为什么可能有用`,
    (output) => {
      if (!output || output.length < 20) return

      const insights = output.split('\n').filter(l => l.trim().length > 10).slice(0, 3)
      for (const insight of insights) {
        roverState.discoveries.push({
          topic: `[技术雷达] ${topic}`,
          insight: insight.trim().slice(0, 200),
          ts: now,
          verified: false,
        })
      }

      // Limit discoveries
      if (roverState.discoveries.length > 100) {
        roverState.discoveries = roverState.discoveries.slice(-80)
      }

      debouncedSave(ROVER_PATH, roverState)
      console.log(`[cc-soul][tech-radar] scanned: ${topic}, found ${insights.length} insights`)
    },
    60000,
    'tech-radar'
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROACTIVE SELF-CORRECTION — check if new discoveries contradict past facts
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * After storing a rover discovery, check if it contradicts any past fact.
 * If overlap is high, proactively notify the owner about potential correction.
 */
function checkForSelfCorrection(newInsight: string) {
  // Only check against older facts (>1 day old) to avoid self-matching
  const pastFacts = memoryState.memories
    .filter(m => m.scope === 'fact' && (Number(m.ts) || 0) < Date.now() - 86400000)

  if (pastFacts.length === 0) return

  // Extract keywords from the new insight
  const insightWords = new Set(
    (newInsight.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase())
  )

  if (insightWords.size < 2) return

  for (const fact of pastFacts) {
    const factWords = (fact.content.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase())
    const overlap = factWords.filter(w => insightWords.has(w)).length

    if (overlap >= 3) {
      // Potential contradiction — notify owner
      notifyOwnerDM(
        `🔄 自我纠正：之前我说过"${fact.content.slice(0, 60)}"，` +
        `但最新了解到"${newInsight.slice(0, 60)}"，可能需要更正`
      ).catch(() => {})

      // Mark the old fact with validUntil (time-bounded, not deleted)
      fact.validUntil = Date.now()
      addMemory(
        `[自我纠正] 旧: ${fact.content.slice(0, 50)} → 新: ${newInsight.slice(0, 50)}`,
        'correction'
      )
      console.log(`[cc-soul][self-correction] flagged: "${fact.content.slice(0, 40)}" contradicted by new insight`)
      break // only one correction per discovery
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISCOVERY VERIFICATION — promote [未验证] → [已验证] when confirmed by facts
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 定期检查未验证的发现，如果有已确认的事实/纠正覆盖相同主题，则标记为已验证。
 * 同时更新 roverState.discoveries 中的 verified 标志。
 */
export function verifyDiscoveries() {
  // 检查记忆中的未验证发现
  const unverified = memoryState.memories.filter(m =>
    m.content.startsWith('[漫游发现][未验证]') && m.scope === 'discovery'
  )
  for (const disc of unverified) {
    const discWords = new Set(
      (disc.content.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase())
    )
    const confirmed = memoryState.memories.some(m => {
      if (m === disc || m.scope === 'expired') return false
      if (m.scope !== 'fact' && m.scope !== 'correction' && m.scope !== 'consolidated') return false
      const mWords = (m.content.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase())
      const overlap = mWords.filter(w => discWords.has(w)).length
      return overlap >= 3
    })
    if (confirmed) {
      disc.content = disc.content.replace('[未验证]', '[已验证]')
      console.log(`[cc-soul][rover] verified discovery: ${disc.content.slice(0, 50)}`)
    }
  }

  // 同步更新 roverState.discoveries 中的 verified 标志
  for (const d of roverState.discoveries) {
    if (d.verified) continue
    const matchingMem = memoryState.memories.find(m =>
      m.scope === 'discovery' && m.content.includes('[已验证]') && m.content.includes(d.insight.slice(0, 30))
    )
    if (matchingMem) {
      d.verified = true
    }
  }

  debouncedSave(ROVER_PATH, roverState)
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECENT DISCOVERIES — inject relevant findings into conversation (with warning)
// ═══════════════════════════════════════════════════════════════════════════════

export function getRecentDiscoveries(msg: string, n = 2): string[] {
  if (roverState.discoveries.length === 0) return []

  const msgWords = new Set((msg.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase()))
  if (msgWords.size === 0) return []

  const relevant = roverState.discoveries
    .map(d => {
      const topicWords = (d.topic + ' ' + d.insight).match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []
      const overlap = topicWords.filter(w => msgWords.has(w.toLowerCase())).length
      return { ...d, score: overlap }
    })
    .filter(d => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)

  return relevant.map(d => {
    const tag = d.verified ? '' : '（注意：这是我自动搜索到的，未经验证）'
    return `对了，我之前了解到关于${d.topic}的一个事: ${d.insight}${tag}`
  })
}

// ── SoulModule registration ──

export const roverModule: SoulModule = {
  id: 'rover',
  name: '知识漫游',
  dependencies: ['memory', 'graph'],
  priority: 50,
  features: ['web_rover'],
}
