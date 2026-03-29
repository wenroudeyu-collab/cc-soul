/**
 * body.ts — Body State system
 * Simulates energy, mood, load, alertness, anomaly.
 */

import type { SoulModule } from './brain.ts'
import type { BodyState, BodyParams } from './types.ts'
import { DATA_DIR, loadJson, debouncedSave } from './persistence.ts'
import { getParam } from './auto-tune.ts'
import { resolve } from 'path'
import { EMOTION_POSITIVE, EMOTION_NEGATIVE, detectEmotionLabel, emotionLabelToPADCN } from './signals.ts'

const BODY_STATE_PATH = resolve(DATA_DIR, 'body_state.json')

// ── #6 PADCN 五维情绪向量 ──
export interface EmotionVector {
  pleasure: number    // 愉悦度 [-1, 1]
  arousal: number     // 激活度 [-1, 1]
  dominance: number   // 控制感 [-1, 1]
  certainty: number   // 确定感 [-1, 1]
  novelty: number     // 新奇感 [-1, 1]
}

// Known limitation: emotionVector is global, not per-user. Acceptable for single-user deployments.
export const emotionVector: EmotionVector = { pleasure: 0, arousal: 0, dominance: 0.3, certainty: 0.5, novelty: 0 }

export const body: BodyState = {
  energy: 1.0,
  mood: 0.3,
  load: 0.0,
  alertness: 0.5,
  anomaly: 0.0,
}

let lastTickTime = Date.now()

// ── #7 昼夜节律 ──
function circadianModifier(): { energyMod: number; moodMod: number } {
  const hour = new Date().getHours()
  if (hour >= 23 || hour < 6) return { energyMod: -0.2, moodMod: -0.1 }
  if (hour >= 6 && hour < 9) return { energyMod: 0.1, moodMod: 0.1 }
  if (hour >= 14 && hour < 16) return { energyMod: -0.1, moodMod: 0 }
  return { energyMod: 0, moodMod: 0 }
}

export function bodyTick() {
  const now = Date.now()
  const minutes = Math.min(10, (now - lastTickTime) / 60000)
  lastTickTime = now

  // #7 昼夜节律影响恢复速率
  const circadian = circadianModifier()
  const energyRecovery = getParam('body.energy_recovery_per_min') + circadian.energyMod * 0.01
  // Energy recovery: faster when idle
  const safeEnergyRecovery = Math.max(0, Math.min(0.1, energyRecovery))
  body.energy = Math.min(1.0, body.energy + safeEnergyRecovery * minutes)
  // Alertness natural decay toward 0.5
  const alertDecay = getParam('body.alertness_decay_per_min') || 0.005
  const alertRecovery = getParam('body.alertness_recovery_per_min') || 0.003
  if (body.alertness > 0.5) {
    body.alertness = Math.max(0.5, body.alertness - Math.max(0, alertDecay) * minutes)
  } else if (body.alertness < 0.5) {
    body.alertness = Math.min(0.5, body.alertness + Math.max(0, alertRecovery) * minutes)
  }
  // Load decay
  const loadDecay = getParam('body.load_decay_per_min') || 0.02
  body.load = Math.max(0, body.load - Math.max(0, loadDecay) * minutes)
  // Mood drift toward neutral (circadian affects drift)
  if (body.mood !== 0) {
    const decayFactor = getParam('body.mood_decay_factor') || 0.95
    const safeFactor = (decayFactor > 0 && decayFactor <= 1) ? decayFactor : 0.95
    body.mood *= Math.pow(safeFactor, Math.min(30, minutes))
  }
  body.mood = Math.max(-1, Math.min(1, body.mood + circadian.moodMod * 0.01 * minutes))
  // Anomaly decay
  body.anomaly = Math.max(0, body.anomaly - (getParam('body.anomaly_decay_per_min') || 0.01) * minutes)

  // #6 情绪向量自然衰减（向中性漂移）
  for (const k of Object.keys(emotionVector) as (keyof EmotionVector)[]) {
    emotionVector[k] *= 0.98
  }

  recordMoodSnapshot()
  saveBodyState()
}

export function bodyOnMessage(complexity: number, _userId?: string) {
  // complexity 0-1 based on message length/content
  const baseEnergyCost = getParam('body.message_energy_base_cost') || 0.02
  const complexityEnergyCost = getParam('body.message_energy_complexity_cost') || 0.03
  const baseLoadIncrease = getParam('body.message_load_base') || 0.1
  const complexityLoadIncrease = getParam('body.message_load_complexity') || 0.15
  body.energy = Math.max(0, body.energy - baseEnergyCost - complexity * complexityEnergyCost)
  body.load = Math.min(1.0, body.load + baseLoadIncrease + complexity * complexityLoadIncrease)
  // #6 情绪向量：高复杂度 → arousal↑ novelty↑
  const clamp = (v: number) => Math.max(-1, Math.min(1, v))
  emotionVector.arousal = clamp(emotionVector.arousal + complexity * 0.15)
  emotionVector.novelty = clamp(emotionVector.novelty + complexity * 0.1)
}

export function bodyOnCorrection() {
  body.alertness = Math.min(1.0, body.alertness + getParam('body.correction_alertness_boost'))
  body.mood = Math.max(-1, body.mood - getParam('body.correction_mood_penalty'))
  body.anomaly = Math.min(1.0, body.anomaly + (getParam('body.correction_anomaly_boost') || 0.15))
  // #6 情绪向量：被纠正 → certainty↓ dominance↓ pleasure↓
  const clamp = (v: number) => Math.max(-1, Math.min(1, v))
  emotionVector.certainty = clamp(emotionVector.certainty - 0.2)
  emotionVector.dominance = clamp(emotionVector.dominance - 0.1)
  emotionVector.pleasure = clamp(emotionVector.pleasure - 0.15)
}

export function bodyOnPositiveFeedback() {
  body.energy = Math.min(1.0, body.energy + getParam('body.positive_energy_boost'))
  body.mood = Math.min(1.0, body.mood + getParam('body.positive_mood_boost'))
  body.anomaly = Math.max(0, body.anomaly - (getParam('body.positive_anomaly_reduction') || 0.05))
  // #6 情绪向量：正面反馈 → pleasure↑ certainty↑ dominance↑
  const clamp = (v: number) => Math.max(-1, Math.min(1, v))
  emotionVector.pleasure = clamp(emotionVector.pleasure + 0.2)
  emotionVector.certainty = clamp(emotionVector.certainty + 0.1)
  emotionVector.dominance = clamp(emotionVector.dominance + 0.1)
}

// ═══════════════════════════════════════════════════════════════════════════════
// Emotional Contagion — bidirectional mood transfer with resilience
// ═══════════════════════════════════════════════════════════════════════════════

/** Per-user emotional state (keyed by senderId, avoids multi-user bleed) */
interface UserEmotionState {
  valence: number        // -1 (negative) to 1 (positive)
  arousal: number        // 0 (calm) to 1 (intense)
  trend: number          // -1 (declining) to 1 (improving)
  history: number[]      // last 10 valence readings
  lastUpdate: number
}

const userEmotions = new Map<string, UserEmotionState>()
const DEFAULT_EMOTION: UserEmotionState = { valence: 0, arousal: 0, trend: 0, history: [], lastUpdate: 0 }

function getUserEmotion(senderId?: string): UserEmotionState {
  const key = senderId || '_default'
  let emotion = userEmotions.get(key)
  if (!emotion) {
    emotion = { ...DEFAULT_EMOTION, history: [] }
    userEmotions.set(key, emotion)
  }
  return emotion
}

// RESILIENCE now read from getParam('body.resilience') — tunable via auto-tune

/**
 * Update user emotion from message signals.
 * Then apply contagion to cc's mood with resilience damping.
 */
/** Last detected emotion label (exposed for augment injection) */
export let lastDetectedEmotion: { label: string; confidence: number } = { label: 'neutral', confidence: 0 }

export function processEmotionalContagion(msg: string, attentionType: string, frustration: number, senderId?: string) {
  const userEmotion = getUserEmotion(senderId)

  // ── 细粒度情绪检测（12种）──
  const detected = detectEmotionLabel(msg)
  lastDetectedEmotion = detected

  // ── PADCN 向量更新：用检测到的情绪直接驱动 ──
  if (detected.confidence > 0.5) {
    const delta = emotionLabelToPADCN(detected.label)
    const weight = detected.confidence * 0.3 // 衰减系数
    emotionVector.pleasure = emotionVector.pleasure * 0.8 + delta.pleasure * weight
    emotionVector.arousal = emotionVector.arousal * 0.8 + delta.arousal * weight
    emotionVector.dominance = emotionVector.dominance * 0.9 + delta.dominance * weight * 0.5
    emotionVector.certainty = emotionVector.certainty * 0.9 + delta.certainty * weight * 0.5
    emotionVector.novelty = emotionVector.novelty * 0.9 + delta.novelty * weight * 0.5
  }

  // ── Valence 计算（兼容旧系统）──
  let valence = 0
  const m = msg.toLowerCase()

  // 用新系统的检测结果驱动 valence
  if (['joy', 'gratitude', 'pride', 'relief', 'anticipation'].includes(detected.label)) {
    valence += 0.3 + detected.confidence * 0.3
  } else if (['anger', 'anxiety', 'frustration', 'sadness', 'disappointment'].includes(detected.label)) {
    valence -= 0.3 + detected.confidence * 0.3
  } else if (detected.label === 'confusion') {
    valence -= 0.1
  }

  // 旧系统兜底（万一新检测漏了）
  if (valence === 0) {
    if (EMOTION_POSITIVE.some(w => m.includes(w))) valence += 0.4
    if (EMOTION_NEGATIVE.some(w => m.includes(w))) valence -= 0.4
  }

  valence -= frustration * 0.3
  if (attentionType === 'correction') valence -= 0.2
  if (msg.length < 5 && valence === 0) valence = -0.05

  valence = Math.max(-1, Math.min(1, valence))

  // Update user emotion state
  userEmotion.valence = userEmotion.valence * 0.7 + valence * 0.3  // EMA smoothing
  userEmotion.arousal = Math.min(1, Math.abs(valence) + frustration * 0.5)

  // Trend: compare current to average of history
  userEmotion.history.push(userEmotion.valence)
  if (userEmotion.history.length > 10) userEmotion.history.shift()
  if (userEmotion.history.length >= 3) {
    const avg = userEmotion.history.reduce((a, b) => a + b, 0) / userEmotion.history.length
    userEmotion.trend = userEmotion.valence - avg
  }

  userEmotion.lastUpdate = Date.now()

  // Evict old entries to prevent unbounded growth
  if (userEmotions.size > 50) {
    let oldestKey = '', oldestTime = Infinity
    for (const [k, v] of userEmotions) {
      if (v.lastUpdate < oldestTime) { oldestTime = v.lastUpdate; oldestKey = k }
    }
    if (oldestKey) userEmotions.delete(oldestKey)
  }

  // === Emotional contagion: user's emotion affects cc's mood ===
  const contagionStrength = (1 - Math.max(0, Math.min(1, getParam('body.resilience')))) * getParam('body.contagion_max_shift') // max mood shift per message
  const moodDelta = valence * contagionStrength

  body.mood = Math.max(-1, Math.min(1, body.mood + moodDelta))

  // If cc's mood drops too low, activate "cooldown" — extra alertness
  if (body.mood < -0.5) {
    body.alertness = Math.min(1.0, body.alertness + 0.1)
  }

  // If user trend is improving, cc's mood recovers faster
  if (userEmotion.trend > 0.1) {
    body.mood = Math.min(1, body.mood + 0.03)
  }
}

/** Get user emotional wellness summary (for proactive voice wellness checks) */
export function getUserEmotionSummary(): { needsCare: boolean; reason: string; worstUser: string } {
  let worstValence = Infinity
  let worstUser = ''
  let reason = ''

  for (const [uid, emotion] of userEmotions) {
    if (uid === '_default') continue
    // Sustained negative emotion (valence < -0.3 AND declining trend)
    if (emotion.valence < -0.3 && emotion.trend < -0.1 && Date.now() - emotion.lastUpdate < 86400000) {
      if (emotion.valence < worstValence) {
        worstValence = emotion.valence
        worstUser = uid
        reason = emotion.valence < -0.5 ? '情绪持续低落' : '情绪有些低'
      }
    }
  }

  return { needsCare: worstValence < -0.3, reason, worstUser }
}

/**
 * Get emotional contagion context for augment injection.
 */
export function getEmotionContext(senderId?: string): string {
  const userEmotion = getUserEmotion(senderId)
  const parts: string[] = []

  // User emotional state
  const uValence = userEmotion.valence
  if (uValence < -0.3) {
    parts.push(`用户情绪偏低(${uValence.toFixed(2)})`)
    if (userEmotion.trend < -0.1) parts.push('且在恶化')
    if (userEmotion.arousal > 0.6) parts.push('情绪激烈')
  } else if (uValence > 0.3) {
    parts.push(`用户情绪积极(${uValence.toFixed(2)})`)
  }

  // CC's own mood affected by contagion
  if (body.mood < -0.3) {
    parts.push('你自己也受到影响了，保持冷静')
  }

  if (parts.length === 0) return ''
  return `[情绪感知] ${parts.join('；')}`
}

// ═══════════════════════════════════════════════════════════════════════════════
// EMOTIONAL ARC — mood history + trend detection
// ═══════════════════════════════════════════════════════════════════════════════

const MOOD_HISTORY_PATH = resolve(DATA_DIR, 'mood_history.json')
const MAX_MOOD_HISTORY = 168 // 7 days × 24 hours

interface MoodSnapshot {
  ts: number
  mood: number
  energy: number
  alertness: number
}

let moodHistory: MoodSnapshot[] = []
let lastMoodSnapshot = 0

export function loadMoodHistory() {
  moodHistory = loadJson<MoodSnapshot[]>(MOOD_HISTORY_PATH, [])
}

/**
 * Record mood snapshot (called from bodyTick, max 1/hour).
 */
export function recordMoodSnapshot() {
  const now = Date.now()
  if (now - lastMoodSnapshot < 3600000) return // 1 per hour
  lastMoodSnapshot = now

  moodHistory.push({ ts: now, mood: body.mood, energy: body.energy, alertness: body.alertness })
  if (moodHistory.length > MAX_MOOD_HISTORY) moodHistory = moodHistory.slice(-MAX_MOOD_HISTORY)
  debouncedSave(MOOD_HISTORY_PATH, moodHistory)
}

/**
 * Detect mood trend over last N hours.
 */
export function getMoodTrend(hours = 24): 'improving' | 'declining' | 'stable' {
  const cutoff = Date.now() - hours * 3600000
  const recent = moodHistory.filter(s => s.ts > cutoff)
  if (recent.length < 3) return 'stable'

  const firstHalf = recent.slice(0, Math.floor(recent.length / 2))
  const secondHalf = recent.slice(Math.floor(recent.length / 2))
  const avgFirst = firstHalf.reduce((s, m) => s + m.mood, 0) / firstHalf.length
  const avgSecond = secondHalf.reduce((s, m) => s + m.mood, 0) / secondHalf.length

  if (avgSecond - avgFirst > 0.15) return 'improving'
  if (avgFirst - avgSecond > 0.15) return 'declining'
  return 'stable'
}

/**
 * Get emotional arc context for augment injection.
 */
export function getEmotionalArcContext(): string {
  const trend = getMoodTrend()
  if (trend === 'stable') return ''
  if (trend === 'declining') return '[Emotional arc] Mood has been declining recently — be more careful and supportive'
  return '[Emotional arc] Mood improving — confidence is up'
}

/**
 * getMoodState — unified mood data access point.
 * Replaces all direct reads of mood_history.json across the codebase.
 */
export function getMoodState(): {
  current: { mood: number; energy: number; alertness: number };
  trend: 'improving' | 'stable' | 'declining';
  recentLowDays: number;
  avgMood24h: number | null;
  avgEnergy24h: number | null;
  moodRatio: { positive: number; negative: number; total: number } | null;
} {
  const now = Date.now()
  const recent24h = moodHistory.filter(s => now - s.ts < 24 * 3600000)
  const recent3d = moodHistory.filter(s => now - s.ts < 3 * 86400000)

  // 24h averages
  let avgMood24h: number | null = null
  let avgEnergy24h: number | null = null
  if (recent24h.length >= 2) {
    avgMood24h = recent24h.reduce((s, d) => s + d.mood, 0) / recent24h.length
    avgEnergy24h = recent24h.reduce((s, d) => s + d.energy, 0) / recent24h.length
  }

  // Recent low days: group by day, count days with avg < -0.3
  let recentLowDays = 0
  const dayBuckets = new Map<string, number[]>()
  for (const s of recent3d) {
    const day = new Date(s.ts).toISOString().slice(0, 10)
    if (!dayBuckets.has(day)) dayBuckets.set(day, [])
    dayBuckets.get(day)!.push(s.mood)
  }
  const dayAvgs = [...dayBuckets.entries()]
    .map(([day, moods]) => ({ day, avg: moods.reduce((a, b) => a + b, 0) / moods.length }))
    .sort((a, b) => a.day.localeCompare(b.day))
  recentLowDays = dayAvgs.filter(d => d.avg < -0.3).length

  // Mood ratio from last 50 snapshots
  let moodRatio: { positive: number; negative: number; total: number } | null = null
  if (moodHistory.length >= 2) {
    const last50 = moodHistory.slice(-50)
    moodRatio = {
      positive: last50.filter(m => m.mood > 0.3).length,
      negative: last50.filter(m => m.mood < -0.3).length,
      total: last50.length,
    }
  }

  return {
    current: { mood: body.mood, energy: body.energy, alertness: body.alertness },
    trend: getMoodTrend(),
    recentLowDays,
    avgMood24h,
    avgEnergy24h,
    moodRatio,
  }
}

/**
 * Check if today's mood snapshots are all low (for same-day care trigger).
 */
export function isTodayMoodAllLow(threshold = -0.2, minCount = 3): boolean {
  const todayStr = new Date().toISOString().slice(0, 10)
  const todayMoods = moodHistory
    .filter(s => new Date(s.ts).toISOString().slice(0, 10) === todayStr)
    .map(s => s.mood)
  return todayMoods.length >= minCount && todayMoods.every(m => m < threshold)
}

/** #6 返回可读情绪摘要 */
export function getEmotionSummary(): string {
  const ev = emotionVector
  const parts: string[] = []
  if (ev.pleasure > 0.3) parts.push('愉悦')
  else if (ev.pleasure < -0.3) parts.push('不快')
  if (ev.arousal > 0.3) parts.push('兴奋')
  else if (ev.arousal < -0.3) parts.push('平静')
  if (ev.dominance > 0.3) parts.push('自信')
  else if (ev.dominance < -0.3) parts.push('被动')
  if (ev.certainty > 0.3) parts.push('确定')
  else if (ev.certainty < -0.3) parts.push('不确定')
  if (ev.novelty > 0.3) parts.push('好奇')
  else if (ev.novelty < -0.3) parts.push('熟悉')
  return parts.length > 0 ? parts.join('且') : '平衡'
}

export function bodyGetParams(): BodyParams {
  const maxTokensMultiplier = body.energy > 0.6 ? 1.0 : body.energy > 0.3 ? 0.8 : 0.6
  const soulTone = body.mood > 0.3 ? '积极' : body.mood < -0.3 ? '低落' : '平静'
  const shouldSelfCheck = body.alertness > 0.7 || body.anomaly > 0.5
  const responseStyle = body.load > 0.7 ? '简洁' : body.energy > 0.7 ? '详细' : '适中'
  return { maxTokensMultiplier, soulTone, shouldSelfCheck, responseStyle }
}

export function bodyStateString(): string {
  const params = bodyGetParams()
  return `精力:${body.energy.toFixed(2)} 心情:${params.soulTone} 负载:${body.load.toFixed(2)} 警觉:${body.alertness.toFixed(2)} 异常感:${body.anomaly.toFixed(2)} 情绪:${getEmotionSummary()} → 风格:${params.responseStyle}`
}

// ═══════════════════════════════════════════════════════════════════════════════
// Body State Persistence
// ═══════════════════════════════════════════════════════════════════════════════

export function saveBodyState() {
  debouncedSave(BODY_STATE_PATH, {
    energy: body.energy,
    mood: body.mood,
    load: body.load,
    alertness: body.alertness,
    anomaly: body.anomaly,
    emotionVector,
  })
}

export function loadBodyState() {
  const saved = loadJson<any>(BODY_STATE_PATH, null)
  if (saved) {
    body.energy = saved.energy ?? 1.0
    body.mood = saved.mood ?? 0.3
    body.load = saved.load ?? 0.0
    body.alertness = saved.alertness ?? 0.5
    body.anomaly = saved.anomaly ?? 0.0
    // #6 恢复情绪向量（兼容旧数据）
    if (saved.emotionVector) {
      for (const k of Object.keys(emotionVector) as (keyof EmotionVector)[]) {
        emotionVector[k] = saved.emotionVector[k] ?? emotionVector[k]
      }
    }
    console.log(`[cc-soul][body] loaded state: e=${body.energy.toFixed(2)} m=${body.mood.toFixed(2)} emotion=${getEmotionSummary()}`)
  }
}

/**
 * P1-#10: generateMoodReport — 情绪周报
 * 统计最近 7 天的 mood 快照：平均值、最高点、最低点、趋势
 */
export function generateMoodReport(): string {
  const sevenDaysAgo = Date.now() - 7 * 86400000
  const recent = moodHistory.filter(s => s.ts > sevenDaysAgo)

  if (recent.length < 2) {
    return '📊 情绪周报\n═══════════════════════════════\n数据不足（需要至少 2 个小时的快照），请稍后再试。'
  }

  const moods = recent.map(s => s.mood)
  const avgMood = moods.reduce((a, b) => a + b, 0) / moods.length
  const maxMood = Math.max(...moods)
  const minMood = Math.min(...moods)
  const maxSnap = recent.find(s => Math.abs(s.mood - maxMood) < 0.001)
  const minSnap = recent.find(s => Math.abs(s.mood - minMood) < 0.001)
  if (!maxSnap || !minSnap) return '数据异常'

  // Trend: first half vs second half
  const half = Math.floor(recent.length / 2)
  const avgFirst = moods.slice(0, half).reduce((a, b) => a + b, 0) / half
  const avgSecond = moods.slice(half).reduce((a, b) => a + b, 0) / (moods.length - half)
  const trend = avgSecond - avgFirst > 0.15 ? '📈 上升' : avgFirst - avgSecond > 0.15 ? '📉 下降' : '➡️ 平稳'

  const fmtDate = (ts: number) => new Date(ts).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

  const lines = [
    '📊 情绪周报（最近 7 天）',
    '═══════════════════════════════',
    `快照数: ${recent.length}`,
    `平均心情: ${avgMood.toFixed(2)}`,
    `最高点: ${maxMood.toFixed(2)} (${fmtDate(maxSnap.ts)})`,
    `最低点: ${minMood.toFixed(2)} (${fmtDate(minSnap.ts)})`,
    `趋势: ${trend} (前半周 ${avgFirst.toFixed(2)} → 后半周 ${avgSecond.toFixed(2)})`,
    '',
    '当前状态:',
    `  精力: ${(body.energy * 100).toFixed(0)}%`,
    `  心情: ${body.mood.toFixed(2)}`,
    `  情绪: ${getEmotionSummary()}`,
  ]
  return lines.join('\n')
}

// ═══════════════════════════════════════════════════════════════════════════════
// EMOTION ANCHORS — track topics correlated with positive/negative mood
// ═══════════════════════════════════════════════════════════════════════════════

const EMOTION_ANCHORS_PATH = resolve(DATA_DIR, 'emotion_anchors.json')

interface EmotionAnchorEntry { topic: string; count: number }
interface EmotionAnchors {
  positive: EmotionAnchorEntry[]
  negative: EmotionAnchorEntry[]
}

let emotionAnchors: EmotionAnchors = { positive: [], negative: [] }
let _emotionAnchorsLoaded = false

export function loadEmotionAnchors(): void {
  emotionAnchors = loadJson<EmotionAnchors>(EMOTION_ANCHORS_PATH, { positive: [], negative: [] })
  _emotionAnchorsLoaded = true
}

function ensureEmotionAnchorsLoaded(): void {
  if (!_emotionAnchorsLoaded) loadEmotionAnchors()
}

function saveEmotionAnchors(): void {
  debouncedSave(EMOTION_ANCHORS_PATH, emotionAnchors)
}

/**
 * Track emotion anchor: when user discusses a topic, record mood correlation.
 * Called from handler.ts after cognition pipeline runs.
 */
export function trackEmotionAnchor(keywords: string[]): void {
  ensureEmotionAnchorsLoaded()
  if (keywords.length === 0) return

  const currentMood = body.mood
  if (Math.abs(currentMood) <= 0.3) return // neutral — not interesting

  const bucket = currentMood > 0.3 ? 'positive' : 'negative'
  const list = emotionAnchors[bucket]

  for (const kw of keywords.slice(0, 3)) {
    const normalized = kw.toLowerCase().trim()
    if (normalized.length < 2) continue
    const existing = list.find(e => e.topic === normalized)
    if (existing) {
      existing.count++
    } else {
      list.push({ topic: normalized, count: 1 })
    }
  }

  // Cap to top 50 per bucket
  emotionAnchors[bucket] = list.sort((a, b) => b.count - a.count).slice(0, 50)
  saveEmotionAnchors()
}

/**
 * Get emotion anchor warning for augment injection.
 * Returns augment text if current message touches a negative topic.
 */
export function getEmotionAnchorWarning(msg: string): string {
  ensureEmotionAnchorsLoaded()
  const m = msg.toLowerCase()
  const negativeHits = emotionAnchors.negative
    .filter(e => e.count >= 2 && m.includes(e.topic))
  if (negativeHits.length === 0) return ''
  const topics = negativeHits.map(e => e.topic).join('、')
  return `[情绪提示] 话题「${topics}」之前让用户感到不适，注意语气和措辞`
}

/**
 * Format emotion anchors for display command.
 */
export function formatEmotionAnchors(): string {
  ensureEmotionAnchorsLoaded()
  const lines: string[] = ['🎯 情绪锚点', '═══════════════════════════════']

  if (emotionAnchors.positive.length === 0 && emotionAnchors.negative.length === 0) {
    lines.push('暂无数据（需要更多对话积累）')
    return lines.join('\n')
  }

  if (emotionAnchors.positive.length > 0) {
    lines.push('')
    lines.push('😊 正面情绪话题:')
    for (const e of emotionAnchors.positive.slice(0, 10)) {
      lines.push(`  • ${e.topic} (${e.count}次)`)
    }
  }

  if (emotionAnchors.negative.length > 0) {
    lines.push('')
    lines.push('😔 负面情绪话题:')
    for (const e of emotionAnchors.negative.slice(0, 10)) {
      lines.push(`  • ${e.topic} (${e.count}次)`)
    }
  }

  return lines.join('\n')
}

// ── SoulModule registration ──

export const bodyModule: SoulModule = {
  id: 'body',
  name: '身体状态',
  priority: 90,
  init() {
    loadBodyState()
    loadMoodHistory()
  },
}
