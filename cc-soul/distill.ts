/**
 * distill.ts — Three-layer memory distillation pipeline
 *
 * Layer 3: User mental model (~200 chars per user, always injected)
 * Layer 2: Topic graph nodes (~50 nodes, retrieved by topic)
 * Layer 1: Raw memories (thousands, rarely accessed directly)
 *
 * Triggered from heartbeat. Each layer has its own cadence:
 *   Layer 1 → 2: every 6 hours (cluster raw memories into topic nodes)
 *   Layer 2 → 3: every 12 hours (distill topics into user mental model)
 *   Layer 3 refresh: every 24 hours (full re-synthesis from all layers)
 */

import { resolve } from 'path'
import { DATA_DIR, loadJson, saveJson, debouncedSave, adaptiveCooldown } from './persistence.ts'
import { memoryState, addMemory, buildCoreMemoryContext } from './memory.ts'
import { spawnCLI } from './cli.ts'
import type { Memory } from './types.ts'

// ═══════════════════════════════════════════════════════════════════════════════
// PATHS & CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const MENTAL_MODELS_PATH = resolve(DATA_DIR, 'mental_models.json')
const TOPIC_NODES_PATH = resolve(DATA_DIR, 'topic_nodes.json')
const DISTILL_STATE_PATH = resolve(DATA_DIR, 'distill_state.json')

const L1_TO_L2_BASE = 6 * 3600000    // 6 hours
const L2_TO_L3_BASE = 12 * 3600000   // 12 hours
const L3_REFRESH_BASE = 24 * 3600000 // 24 hours
// Adaptive cooldowns (scale by user activity when userId available)
const L1_TO_L2_COOLDOWN = L1_TO_L2_BASE   // used in global context (no userId)
const L2_TO_L3_COOLDOWN = L2_TO_L3_BASE
const L3_REFRESH_COOLDOWN = L3_REFRESH_BASE
const MIN_MEMORIES_FOR_DISTILL = 20       // don't distill if too few
const MAX_TOPIC_NODES = 80
const MAX_MODEL_LENGTH = 600              // chars per user mental model

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface TopicNode {
  topic: string            // e.g. "iOS逆向", "芒果偏好", "feishu-bot部署"
  summary: string          // distilled understanding
  sourceCount: number      // how many raw memories contributed
  lastUpdated: number
  userId?: string          // per-user or global
}

interface MentalModel {
  userId: string
  model: string            // natural language: "这个人是..."
  topics: string[]         // top topic references
  lastUpdated: number
  version: number
}

interface DistillState {
  lastL1toL2: number
  lastL2toL3: number
  lastL3Refresh: number
  totalDistills: number
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let topicNodes: TopicNode[] = []
let mentalModels = new Map<string, MentalModel>()
let distillState: DistillState = { lastL1toL2: 0, lastL2toL3: 0, lastL3Refresh: 0, totalDistills: 0 }

// ═══════════════════════════════════════════════════════════════════════════════
// LOAD / SAVE
// ═══════════════════════════════════════════════════════════════════════════════

export function loadDistillState() {
  topicNodes = loadJson<TopicNode[]>(TOPIC_NODES_PATH, [])
  distillState = loadJson<DistillState>(DISTILL_STATE_PATH, distillState)
  const raw = loadJson<Record<string, MentalModel>>(MENTAL_MODELS_PATH, {})
  mentalModels.clear()
  for (const [id, m] of Object.entries(raw)) {
    mentalModels.set(id, m)
  }
  console.log(`[cc-soul][distill] loaded: ${topicNodes.length} topics, ${mentalModels.size} mental models`)
}

function saveTopicNodes() {
  debouncedSave(TOPIC_NODES_PATH, topicNodes, 5000)
}

function saveMentalModels() {
  const obj: Record<string, MentalModel> = {}
  for (const [id, m] of mentalModels) obj[id] = m
  debouncedSave(MENTAL_MODELS_PATH, obj, 5000)
}

function saveDistillState_() {
  saveJson(DISTILL_STATE_PATH, distillState)
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 1 → LAYER 2: Raw memories → Topic nodes
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Cluster raw memories by topic similarity, then distill each cluster
 * into a topic node summary.
 */
export function distillL1toL2() {
  const now = Date.now()
  if (now - distillState.lastL1toL2 < L1_TO_L2_COOLDOWN) return
  distillState.lastL1toL2 = now

  // Get active, non-expired memories
  const active = memoryState.memories.filter(m =>
    m.scope !== 'expired' && m.scope !== 'archived' && m.scope !== 'decayed' &&
    m.content.length > 10
  )
  if (active.length < MIN_MEMORIES_FOR_DISTILL) return

  // Group by userId (or 'global' for no userId)
  const byUser = new Map<string, Memory[]>()
  for (const m of active) {
    const key = m.userId || '_global'
    if (!byUser.has(key)) byUser.set(key, [])
    byUser.get(key)!.push(m)
  }

  // For each user group, cluster by topic
  // Limit total CLI calls to avoid queue overflow (CLI queue max = 10)
  let cliCallsThisRound = 0
  const MAX_CLI_PER_DISTILL = 8

  for (const [userId, memories] of byUser) {
    if (memories.length < 5) continue
    if (cliCallsThisRound >= MAX_CLI_PER_DISTILL) break

    // Simple topic clustering: group by scope + keyword overlap
    const clusters = clusterByKeywords(memories)

    // Emotion-weighted L2 promotion: sort clusters so emotionally significant ones get priority
    clusters.sort((a, b) => {
      const emotionScore = (cluster: Memory[]) => cluster.reduce((sum, m) => {
        const w = (m.emotion === 'important' || m.emotion === 'warm') ? 1.5
          : m.emotion === 'painful' ? 1.3 : 1.0
        return sum + w
      }, 0)
      return emotionScore(b) - emotionScore(a)
    })

    for (const cluster of clusters) {
      if (cluster.length < 2) continue
      if (cliCallsThisRound >= MAX_CLI_PER_DISTILL) break

      // Check if we already have a topic node for this cluster
      const clusterText = cluster.map(m => m.content.slice(0, 80)).join('\n')
      const existingNode = topicNodes.find(n =>
        n.userId === (userId === '_global' ? undefined : userId) &&
        keywordOverlap(n.topic, clusterText) > 0.3
      )

      if (existingNode && now - existingNode.lastUpdated < L1_TO_L2_COOLDOWN) continue

      // 优先用零 LLM 蒸馏（省 token）
      const zeroLLMResult = zeroLLMDistill(cluster.map(m => m.content))
      if (zeroLLMResult && zeroLLMResult.length > 10) {
        // 零 LLM 蒸馏成功，不调 LLM
        // 从第一条记忆提取主题名
        const topicName = cluster[0].content.slice(0, 10).replace(/[，。！？\s]+$/, '') || '未分类'
        const node: TopicNode = {
          topic: topicName.slice(0, 20),
          summary: zeroLLMResult.slice(0, 200),
          sourceCount: cluster.length,
          lastUpdated: Date.now(),
          userId: userId === '_global' ? undefined : userId,
        }
        if (existingNode) {
          existingNode.topic = node.topic
          existingNode.summary = node.summary
          existingNode.sourceCount += cluster.length
          existingNode.lastUpdated = node.lastUpdated
        } else {
          topicNodes.push(node)
          if (topicNodes.length > MAX_TOPIC_NODES) {
            topicNodes.sort((a, b) => b.lastUpdated - a.lastUpdated)
            topicNodes.length = MAX_TOPIC_NODES
          }
        }
        saveTopicNodes()
        console.log(`[cc-soul][distill] L1→L2 (zero-LLM): "${node.topic}" (${cluster.length} memories → 1 node)`)
        continue  // 跳过 LLM 蒸馏
      }

      // fallback: LLM 蒸馏（只在零 LLM 结果太短时）
      const prompt = [
        '将以下记忆片段蒸馏为一个主题节点。格式：',
        '主题: <2-6字的主题名>',
        '摘要: <1-2句话的核心理解，不超过100字>',
        '',
        '记忆片段:',
        ...cluster.slice(0, 15).map(m => `- ${m.content.slice(0, 120)}`),
      ].join('\n')

      cliCallsThisRound++
      spawnCLI(prompt, (output) => {
        if (!output || output.length < 10) return
        const topicMatch = output.match(/主题[:：]\s*(.+?)(?:\n|$)/)
        const summaryMatch = output.match(/摘要[:：]\s*(.+?)(?:\n|$)/)
        if (!topicMatch || !summaryMatch) return

        const node: TopicNode = {
          topic: topicMatch[1].trim().slice(0, 20),
          summary: summaryMatch[1].trim().slice(0, 200),
          sourceCount: cluster.length,
          lastUpdated: Date.now(),
          userId: userId === '_global' ? undefined : userId,
        }

        if (existingNode) {
          // Update existing
          existingNode.topic = node.topic
          existingNode.summary = node.summary
          existingNode.sourceCount += cluster.length
          existingNode.lastUpdated = node.lastUpdated
        } else {
          topicNodes.push(node)
          // Cap total nodes
          if (topicNodes.length > MAX_TOPIC_NODES) {
            topicNodes.sort((a, b) => b.lastUpdated - a.lastUpdated)
            topicNodes.length = MAX_TOPIC_NODES
          }
        }
        saveTopicNodes()
        console.log(`[cc-soul][distill] L1→L2: "${node.topic}" (${cluster.length} memories → 1 node)`)
      })
    }
  }

  distillState.totalDistills++
  saveDistillState_()
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 2 → LAYER 3: Topic nodes → Mental model
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Synthesize topic nodes + user profile into a concise mental model.
 * One model per user. This is the "I know this person" summary.
 */
export function distillL2toL3() {
  const now = Date.now()
  if (now - distillState.lastL2toL3 < L2_TO_L3_COOLDOWN) return
  distillState.lastL2toL3 = now

  // Collect unique userIds from topic nodes and memories
  const userIds = new Set<string>()
  for (const n of topicNodes) {
    if (n.userId) userIds.add(n.userId)
  }
  // Also check memories for users without topic nodes yet
  for (const m of memoryState.memories) {
    if (m.userId && m.scope !== 'expired') userIds.add(m.userId)
  }

  // Also generate a global model (for owner / default)
  userIds.add('_global')

  for (const userId of userIds) {
    const isGlobal = userId === '_global'

    // Gather this user's topic nodes
    const userTopics = topicNodes.filter(n =>
      isGlobal ? !n.userId : n.userId === userId
    )

    // Gather user-specific memories (recent preferences, corrections)
    const userMems = memoryState.memories.filter(m =>
      (isGlobal ? !m.userId : m.userId === userId) &&
      m.scope !== 'expired' && m.scope !== 'archived' &&
      (m.scope === 'preference' || m.scope === 'correction' || m.scope === 'fact' || m.scope === 'consolidated')
    ).slice(-20)

    if (userTopics.length === 0 && userMems.length < 3) continue

    // Get existing model for incremental update
    const existing = mentalModels.get(userId)

    const prompt = [
      `用2-3段自然语言描述你对这个${isGlobal ? '主要用户' : '用户'}的理解。`,
      '像心理学家写案例笔记，不要列清单。包含：',
      '1. 这个人是谁（身份、职业、技术水平）',
      '2. 沟通偏好（风格、雷区、喜好）',
      '3. 关键事实（重要偏好、习惯、在意的事）',
      `不超过${MAX_MODEL_LENGTH}字。`,
      '',
      userTopics.length > 0 ? '已知的主题理解:' : '',
      ...userTopics.slice(0, 20).map(n => `- [${n.topic}] ${n.summary}`),
      '',
      userMems.length > 0 ? '关键记忆:' : '',
      ...userMems.map(m => `- [${m.scope}] ${m.content.slice(0, 100)}`),
      '',
      existing ? `上一版理解（需要更新，不是照抄）:\n${existing.model}` : '',
    ].filter(Boolean).join('\n')

    spawnCLI(prompt, (output) => {
      if (!output || output.length < 30) return

      const model: MentalModel = {
        userId,
        model: output.slice(0, MAX_MODEL_LENGTH),
        topics: userTopics.slice(0, 10).map(n => n.topic),
        lastUpdated: Date.now(),
        version: (existing?.version ?? 0) + 1,
      }
      mentalModels.set(userId, model)
      saveMentalModels()
      console.log(`[cc-soul][distill] L2→L3: ${isGlobal ? 'global' : userId.slice(0, 8)} model v${model.version} (${output.length} chars)`)
    }, 60000)
  }

  saveDistillState_()
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API — for prompt injection and augments
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the mental model for a user. Falls back to global model.
 * This is what gets injected into SOUL.md / bootstrap.
 */
export function getMentalModel(userId?: string): string {
  if (userId) {
    const m = mentalModels.get(userId)
    if (m) return m.model
  }
  const g = mentalModels.get('_global')
  return g?.model ?? ''
}

/**
 * Get topic nodes relevant to a message (for Layer 2 augment).
 */
export function getRelevantTopics(msg: string, userId?: string, maxNodes = 5): TopicNode[] {
  if (topicNodes.length === 0) return []

  const scored: { node: TopicNode; score: number }[] = []
  for (const node of topicNodes) {
    // Filter by user if specified
    if (userId && node.userId && node.userId !== userId) continue

    const overlap = keywordOverlap(msg, `${node.topic} ${node.summary}`)
    if (overlap > 0.1) {
      scored.push({ node, score: overlap })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, maxNodes).map(s => s.node)
}

/**
 * Build Layer 2 augment: topic context relevant to current message.
 */
export function buildTopicAugment(msg: string, userId?: string): string {
  const relevant = getRelevantTopics(msg, userId)
  if (relevant.length === 0) return ''
  const lines = relevant.map(n => `- [${n.topic}] ${n.summary}`)
  return `[主题记忆] 相关主题理解:\n${lines.join('\n')}`
}

/**
 * Build Layer 3 augment: user mental model for bootstrap/SOUL.md.
 */
export function buildMentalModelAugment(userId?: string): string {
  const model = getMentalModel(userId)
  if (!model) return ''
  return `[用户心智模型]\n${model}`
}

/**
 * Run the full distillation pipeline (called from heartbeat).
 */
export function runDistillPipeline() {
  distillL1toL2()
  // L2→L3 runs less frequently
  const now = Date.now()
  if (now - distillState.lastL2toL3 >= L2_TO_L3_COOLDOWN) {
    distillL2toL3()
  }
}

/**
 * Get distill stats for diagnostics.
 */
export function getDistillStats() {
  return {
    topicNodes: topicNodes.length,
    mentalModels: mentalModels.size,
    ...distillState,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ZERO-LLM DISTILL — 零 LLM 蒸馏：用规则提取特征替代 LLM 摘要
// 省 100% 的蒸馏 token，速度快 10x
// ═══════════════════════════════════════════════════════════════════════════════

function zeroLLMDistill(memories: string[]): string {
  const allWords = new Map<string, number>()
  const traits: string[] = []

  for (const content of memories) {
    // 词频统计
    const words = (content.match(/[\u4e00-\u9fff]{2,4}|[a-zA-Z]{3,}/gi) || []).map(w => w.toLowerCase())
    for (const w of words) allWords.set(w, (allWords.get(w) || 0) + 1)

    // 特征提取
    if (/每天|经常|习惯|总是/.test(content)) traits.push('有规律性')
    if (/喜欢|爱|偏好/.test(content)) {
      const obj = content.match(/喜欢(.{2,8})/)?.[1]
      if (obj) traits.push(`偏好:${obj.replace(/[，。！？\s]+$/, '')}`)
    }
    if (/讨厌|不喜欢|受不了/.test(content)) {
      const obj = content.match(/(?:讨厌|不喜欢)(.{2,8})/)?.[1]
      if (obj) traits.push(`反感:${obj.replace(/[，。！？\s]+$/, '')}`)
    }
    if (/焦虑|压力|担心|紧张/.test(content)) traits.push('有压力')
    if (/学|研究|探索/.test(content)) traits.push('学习型')
    if (/快|效率|优化/.test(content)) traits.push('效率导向')
  }

  // 取 top 5 高频关键词
  const topWords = [...allWords.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w]) => w)

  // 去重特征
  const uniqueTraits = [...new Set(traits)].slice(0, 5)

  // 组合摘要
  const parts: string[] = []
  if (topWords.length > 0) parts.push(`关键词: ${topWords.join(', ')}`)
  if (uniqueTraits.length > 0) parts.push(`特征: ${uniqueTraits.join(', ')}`)

  return parts.join(' | ') || memories[0]?.slice(0, 60) || ''
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOPIC CONFIDENCE — 蒸馏反馈闭环：根据回复质量调整 topic node 置信度
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 调整 topic node 的置信度。quality 高 → confidence 上升，quality 低 → 下降并标记重新蒸馏。
 */
export function adjustTopicConfidence(topicName: string, delta: number) {
  const node = topicNodes.find(n => n.topic === topicName)
  if (!node) return
  const confidence = ((node as any).confidence ?? 0.5) + delta
  ;(node as any).confidence = Math.max(0.1, Math.min(0.95, confidence))
  // confidence 过低 → 标记需要重新蒸馏（下次 L1→L2 时会重新处理）
  if ((node as any).confidence < 0.3) {
    node.lastUpdated = 0  // 重置 lastUpdated 使其在下次蒸馏时被重新处理
    console.log(`[cc-soul][distill] topic "${topicName}" confidence too low (${(node as any).confidence.toFixed(2)}), marked for re-distill`)
  }
  saveTopicNodes()
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Simple keyword-based clustering. Groups memories that share >40% keywords.
 */
function clusterByKeywords(memories: Memory[]): Memory[][] {
  const CJK_WORD = /[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi
  const clusters: Memory[][] = []
  const assigned = new Set<number>()

  for (let i = 0; i < memories.length; i++) {
    if (assigned.has(i)) continue
    const cluster = [memories[i]]
    assigned.add(i)

    const wordsI = new Set((memories[i].content.match(CJK_WORD) || []).map(w => w.toLowerCase()))
    if (wordsI.size === 0) continue

    for (let j = i + 1; j < memories.length; j++) {
      if (assigned.has(j)) continue
      const wordsJ = new Set((memories[j].content.match(CJK_WORD) || []).map(w => w.toLowerCase()))
      if (wordsJ.size === 0) continue

      let hits = 0
      for (const w of wordsI) { if (wordsJ.has(w)) hits++ }
      const overlap = hits / Math.max(1, Math.min(wordsI.size, wordsJ.size))

      if (overlap >= 0.4) {
        cluster.push(memories[j])
        assigned.add(j)
      }
    }

    if (cluster.length >= 2) {
      clusters.push(cluster)
    }
  }

  return clusters
}

/**
 * Calculate keyword overlap ratio between two text strings.
 */
function keywordOverlap(a: string, b: string): number {
  const CJK_WORD = /[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi
  const wordsA = new Set((a.match(CJK_WORD) || []).map(w => w.toLowerCase()))
  const wordsB = new Set((b.match(CJK_WORD) || []).map(w => w.toLowerCase()))
  if (wordsA.size === 0 || wordsB.size === 0) return 0

  let hits = 0
  for (const w of wordsA) { if (wordsB.has(w)) hits++ }
  return hits / Math.max(1, Math.min(wordsA.size, wordsB.size))
}
