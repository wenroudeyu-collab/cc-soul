/**
 * deep-understand.ts — 7 维深层理解引擎
 * 周期性分析积累数据，产出影响回复策略的洞察。纯规则驱动，不调 LLM。
 */
import { resolve } from 'path'
import { DATA_DIR, loadJson, debouncedSave } from './persistence.ts'
import { memoryState, ensureMemoriesLoaded } from './memory.ts'
import { getPersonModel } from './person-model.ts'

const DU_PATH = resolve(DATA_DIR, 'deep_understand.json')

interface DeepUnderstandState {
  temporal: { peakHours: number[]; stressDay: string | null; lateNightFrequency: number }
  sayDo: { gaps: { stated: string; actual: string; frequency: number }[] }
  growth: { direction: 'growing' | 'plateauing' | 'struggling'; details: string }
  unspoken: { needs: { domain: string; confidence: number; evidence: string }[] }
  cognitive: { load: 'high' | 'normal' | 'low'; indicator: string }
  stress: { stressLevel: number; signals: string[] }
  dynamicProfile: string
  updatedAt: number
}

const DEFAULTS: DeepUnderstandState = {
  temporal: { peakHours: [], stressDay: null, lateNightFrequency: 0 },
  sayDo: { gaps: [] }, growth: { direction: 'plateauing', details: '' },
  unspoken: { needs: [] }, cognitive: { load: 'normal', indicator: '' },
  stress: { stressLevel: 0, signals: [] }, dynamicProfile: '', updatedAt: 0,
}

let state: DeepUnderstandState = loadJson<DeepUnderstandState>(DU_PATH, { ...DEFAULTS })

// ── 1. Temporal Patterns ──
function analyzeTemporalPatterns(): DeepUnderstandState['temporal'] {
  const history = memoryState.chatHistory
  if (history.length < 10) return state.temporal
  const hourCounts = new Array(24).fill(0)
  const dayMood = new Map<number, number[]>()
  let lateNight = 0
  for (const h of history) {
    const d = new Date(h.ts), hr = d.getHours()
    hourCounts[hr]++
    if (hr >= 23 || hr < 4) lateNight++
    const day = d.getDay()
    if (!dayMood.has(day)) dayMood.set(day, [])
    dayMood.get(day)!.push((h.user.length < 10 && (hr >= 22 || hr < 6)) ? -1 : 0)
  }
  const peakHours = hourCounts.map((c: number, i: number) => ({ h: i, c }))
    .sort((a: {h:number,c:number}, b: {h:number,c:number}) => b.c - a.c)
    .slice(0, 3).filter((x: {h:number,c:number}) => x.c > 0).map((x: {h:number,c:number}) => x.h)
  let stressDay: string | null = null, worstAvg = 0
  const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  for (const [day, moods] of dayMood) {
    if (moods.length < 3) continue
    const avg = moods.reduce((a, b) => a + b, 0) / moods.length
    if (avg < worstAvg) { worstAvg = avg; stressDay = dayNames[day] }
  }
  return { peakHours, stressDay, lateNightFrequency: lateNight / history.length }
}

// ── 2. Say-Do Gap ──
function analyzeSayDoGap(): DeepUnderstandState['sayDo'] {
  ensureMemoriesLoaded()
  const history = memoryState.chatHistory
  const intents = memoryState.memories.filter(m => /我要|我打算|我会|我准备|I will|I'm going to/i.test(m.content) && m.scope !== 'expired')
  const gaps: DeepUnderstandState['sayDo']['gaps'] = []
  for (const intent of intents.slice(-10)) {
    const c = intent.content.toLowerCase()
    if (/早睡|早点睡|sleep early/.test(c)) {
      const after = history.filter(h => h.ts > intent.ts)
      const late = after.filter(h => { const hr = new Date(h.ts).getHours(); return hr >= 0 && hr < 5 }).length
      if (after.length > 5 && late / after.length > 0.3)
        gaps.push({ stated: '早睡', actual: `${Math.round(late / after.length * 100)}%消息在凌晨`, frequency: late })
    }
    if (/少加班|多休息|放松|rest more|take break/.test(c)) {
      const wknd = history.filter(h => { const d = new Date(h.ts); return h.ts > intent.ts && (d.getDay() === 0 || d.getDay() === 6) }).length
      if (wknd > 10) gaps.push({ stated: '多休息', actual: `周末仍有${wknd}条消息`, frequency: wknd })
    }
  }
  return { gaps: gaps.slice(0, 5) }
}

// ── 3. Growth Trajectory ──
function analyzeGrowth(): DeepUnderstandState['growth'] {
  const history = memoryState.chatHistory
  if (history.length < 20) return { direction: 'plateauing', details: '数据不足' }
  const half = Math.floor(history.length / 2)
  const first = history.slice(0, half), second = history.slice(half)
  const avgLen = (a: typeof history) => a.reduce((s, h) => s + h.user.length, 0) / a.length
  const l1 = avgLen(first), l2 = avgLen(second)
  const techRe = /async|await|deploy|refactor|pipeline|架构|重构|微服务|并发|索引|缓存/gi
  const techCount = (a: typeof history) => { const s = new Set<string>(); for (const h of a) { const m = h.user.match(techRe); if (m) m.forEach(w => s.add(w.toLowerCase())) } return s.size }
  const t1 = techCount(first), t2 = techCount(second)
  if (l2 > l1 * 1.3 && t2 > t1) return { direction: 'growing', details: `长度+${Math.round((l2/l1-1)*100)}%，词汇${t1}→${t2}` }
  if (l2 < l1 * 0.7 || t2 < t1 * 0.5) return { direction: 'struggling', details: '消息变短或词汇减少' }
  return { direction: 'plateauing', details: '模式稳定' }
}

// ── 4. Unspoken Needs ──
function analyzeUnspokenNeeds(): DeepUnderstandState['unspoken'] {
  const recent = memoryState.chatHistory.filter(h => h.ts > Date.now() - 7 * 86400000)
  const domains: [string, RegExp][] = [
    ['编程', /代码|bug|error|函数|class|api|编程|开发|调试|debug/i],
    ['职场', /工作|老板|同事|面试|加班|薪|绩效|晋升/i],
    ['健康', /睡眠|运动|头疼|累|健身|饮食|体检/i],
    ['情感', /感觉|心情|焦虑|压力|开心|难过|孤独/i],
    ['学习', /学习|考试|课程|教程|理解|掌握/i],
  ]
  const counts = new Map<string, number>()
  for (const h of recent) for (const [d, re] of domains) if (re.test(h.user)) counts.set(d, (counts.get(d) || 0) + 1)
  const needs = [...counts.entries()].filter(([, n]) => n >= 3)
    .map(([d, n]) => ({ domain: d, confidence: Math.min(1, n / 10), evidence: `本周${n}次` }))
    .sort((a, b) => b.confidence - a.confidence).slice(0, 5)
  return { needs }
}

// ── 5. Cognitive Load ──
function analyzeCognitiveLoad(): DeepUnderstandState['cognitive'] {
  const history = memoryState.chatHistory
  if (history.length < 5) return { load: 'normal', indicator: '' }
  const allAvg = history.reduce((s, h) => s + h.user.length, 0) / history.length
  const r5 = history.slice(-5)
  const rAvg = r5.reduce((s, h) => s + h.user.length, 0) / r5.length
  if (rAvg < allAvg * 0.4 && rAvg < 20) return { load: 'high', indicator: `均${Math.round(rAvg)}字(历史${Math.round(allAvg)})` }
  if (rAvg > allAvg * 1.5 && rAvg > 80) return { load: 'low', indicator: `详细模式${Math.round(rAvg)}字` }
  return { load: 'normal', indicator: '' }
}

// ── 6. Stress Fingerprint ──
function analyzeStress(): DeepUnderstandState['stress'] {
  const history = memoryState.chatHistory
  if (history.length < 5) return { stressLevel: 0, signals: [] }
  const recent = history.slice(-10), signals: string[] = []
  let score = 0
  const rAvg = recent.reduce((s, h) => s + h.user.length, 0) / recent.length
  const hAvg = history.reduce((s, h) => s + h.user.length, 0) / history.length
  if (rAvg < hAvg * 0.5 && rAvg < 15) { score += 0.3; signals.push('碎片化') }
  if (recent.reduce((s, h) => s + (h.user.match(/[?？!！.。…]{2,}/g) || []).length, 0) >= 3) { score += 0.2; signals.push('标点激增') }
  if (recent.filter(h => /算了|随便|fuck|shit|烦|累|不管了|懒得|无所谓|操|靠|妈的/.test(h.user)).length >= 2) { score += 0.3; signals.push('压力词') }
  if (recent.filter(h => { const hr = new Date(h.ts).getHours(); return hr >= 1 && hr < 5 }).length >= 2) { score += 0.2; signals.push('深夜') }
  return { stressLevel: Math.min(1, score), signals }
}

// ── 7. Dynamic Profile ──
function synthesizeProfile(): string {
  const pm = getPersonModel(), parts: string[] = []
  const { temporal: t, growth: g, stress: s, cognitive: c, sayDo: sd, unspoken: u } = state
  if (t.peakHours.length > 0) parts.push(`活跃${t.peakHours.join('/')}时`)
  if (t.lateNightFrequency > 0.3) parts.push('夜猫子')
  if (g.direction === 'growing') parts.push('上升期')
  else if (g.direction === 'struggling') parts.push('瓶颈期')
  if (s.stressLevel > 0.5) parts.push(`压力高(${s.signals.join('+')})`)
  if (c.load === 'high') parts.push('负荷高→简洁')
  else if (c.load === 'low') parts.push('专注→可深入')
  if (sd.gaps.length > 0) parts.push(`言行不一:${sd.gaps[0].stated}`)
  if (u.needs[0]?.confidence > 0.5) parts.push(`潜在需求:${u.needs[0].domain}`)
  if (pm.identity) parts.push(pm.identity.slice(0, 60))
  return parts.join('；')
}

// ── Public API ──
/** heartbeat 调用 — 刷新全部分析 */
export function updateDeepUnderstand(): void {
  ensureMemoriesLoaded()
  if (memoryState.chatHistory.length < 10) return
  state.temporal = analyzeTemporalPatterns()
  state.sayDo = analyzeSayDoGap()
  state.growth = analyzeGrowth()
  state.unspoken = analyzeUnspokenNeeds()
  state.cognitive = analyzeCognitiveLoad()
  state.stress = analyzeStress()
  state.dynamicProfile = synthesizeProfile()
  state.updatedAt = Date.now()
  debouncedSave(DU_PATH, state)
}

/** handler-augments 调用 — 返回紧凑洞察字符串 */
export function getDeepUnderstandContext(): string {
  if (!state.updatedAt) return ''
  const parts: string[] = []
  const { stress: s, cognitive: c, growth: g, unspoken: u, sayDo: sd, temporal: t } = state
  if (s.stressLevel > 0.4) parts.push(`压力${(s.stressLevel*10).toFixed(0)}/10(${s.signals.join(',')})`)
  if (c.load !== 'normal') parts.push(c.load === 'high' ? '认知负荷高→简洁回复' : '专注模式→可深入')
  if (g.direction !== 'plateauing') parts.push(g.direction === 'growing' ? '成长期→适当提高难度' : '瓶颈期→多鼓励')
  if (u.needs[0]?.confidence > 0.5) parts.push(`可能需要${u.needs[0].domain}方面的帮助`)
  if (sd.gaps[0]) parts.push(`说"${sd.gaps[0].stated}"但${sd.gaps[0].actual}→温和引导`)
  if (t.lateNightFrequency > 0.4) parts.push('经常深夜活跃')
  if (parts.length === 0) return ''
  return '[深层理解] ' + parts.join('；')
}
