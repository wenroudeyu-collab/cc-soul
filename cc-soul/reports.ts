/**
 * reports.ts — 晨报 / 周报生成器
 *
 * generateMorningReport(): 每日晨报
 * generateWeeklyReport(): 每周周报
 *
 * 数据来源: SQLite (chat_history, reminders, goals, memories) + body state + evolution rules
 */

import { getDb } from './sqlite-store.ts'
import { body, emotionVector, getEmotionSummary, getMoodTrend, generateMoodReport } from './body.ts'
import { getCapabilityScore } from './epistemic.ts'
import { rules } from './evolution.ts'
import { stats } from './handler-state.ts'
import { DATA_DIR, loadJson } from './persistence.ts'
import { resolve } from 'path'

// ── Helpers ──

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function fmtDay(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', weekday: 'short' })
}

// Track last report fire times to avoid duplicates within the same hour
let lastMorningReportDate = ''
let lastWeeklyReportDate = ''

// ═══════════════════════════════════════════════════════════════════════════════
// MORNING REPORT — 每日晨报
// ═══════════════════════════════════════════════════════════════════════════════

export function generateMorningReport(): string {
  const db = getDb()
  if (!db) return '☀️ 每日晨报\n═══════════════════════════════\n数据库初始化中，请稍后重试。'
  const now = Date.now()
  const lines: string[] = [
    '☀️ 每日晨报',
    `═══════════════════════════════`,
    `${new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}`,
    '',
  ]

  // 1. 昨日对话摘要 (最近 24h)
  lines.push('━━ 昨日对话 ━━')
  if (db) {
    try {
      const cutoff24h = now - 24 * 3600000
      const chatRows = db.prepare('SELECT user_msg, assistant_msg, ts FROM chat_history WHERE ts > ? ORDER BY ts ASC').all(cutoff24h) as any[]
      if (chatRows.length > 0) {
        lines.push(`共 ${chatRows.length} 轮对话`)
        // 取前 5 条摘要
        const samples = chatRows.slice(0, 5)
        for (const r of samples) {
          const userSnippet = (r.user_msg || '').slice(0, 40).replace(/\n/g, ' ')
          lines.push(`  • [${fmtDate(r.ts)}] ${userSnippet}${r.user_msg.length > 40 ? '...' : ''}`)
        }
        if (chatRows.length > 5) {
          lines.push(`  ...及其他 ${chatRows.length - 5} 轮`)
        }
      } else {
        lines.push('  昨日无对话')
      }
    } catch {
      lines.push('  对话数据不可用')
    }
  } else {
    lines.push('  数据库未就绪')
  }
  lines.push('')

  // 2. 今日待办提醒
  lines.push('━━ 今日提醒 ━━')
  if (db) {
    try {
      const reminders = db.prepare("SELECT * FROM reminders WHERE status = 'pending' ORDER BY remind_at ASC").all() as any[]
      if (reminders.length > 0) {
        for (const r of reminders) {
          lines.push(`  • ${r.remind_at || '??:??'} — ${r.content}`)
        }
      } else {
        lines.push('  无待办提醒')
      }
    } catch {
      lines.push('  提醒数据不可用')
    }
  }
  lines.push('')

  // 3. 活跃目标进度
  lines.push('━━ 活跃目标 ━━')
  if (db) {
    try {
      const goals = db.prepare("SELECT id, title, progress, created_at FROM goals WHERE status != 'completed' ORDER BY created_at DESC").all() as any[]
      if (goals.length > 0) {
        for (const g of goals) {
          const bar = progressBar(g.progress || 0)
          lines.push(`  • ${g.title}  ${bar} ${g.progress || 0}%`)
        }
      } else {
        lines.push('  无活跃目标')
      }
    } catch {
      lines.push('  目标数据不可用')
    }
  }
  lines.push('')

  // 4. 情绪趋势 (最近 3 天 mood_history)
  lines.push('━━ 情绪趋势（3日） ━━')
  const moodHistoryPath = resolve(DATA_DIR, 'mood_history.json')
  try {
    const moodHistory = loadJson<any[]>(moodHistoryPath, [])
    const cutoff3d = now - 3 * 86400000
    const recent = (moodHistory || []).filter((s: any) => s.ts > cutoff3d)
    if (recent.length >= 2) {
      const moods = recent.map((s: any) => s.mood as number)
      const avg = moods.reduce((a: number, b: number) => a + b, 0) / moods.length
      const trend = getMoodTrend(72)
      const trendEmoji = trend === 'improving' ? '📈' : trend === 'declining' ? '📉' : '➡️'
      lines.push(`  平均心情: ${avg.toFixed(2)}  趋势: ${trendEmoji} ${trend}`)
      lines.push(`  当前: 心情=${body.mood.toFixed(2)} 精力=${(body.energy * 100).toFixed(0)}% 情绪=${getEmotionSummary()}`)
    } else {
      lines.push('  数据不足（需更多快照）')
    }
  } catch {
    lines.push('  情绪数据不可用')
  }
  lines.push('')

  // 5. 未解决话题 (最近 correction 类型记忆)
  lines.push('━━ 待关注（近期纠正） ━━')
  if (db) {
    try {
      const cutoff3d = now - 3 * 86400000
      const corrections = db.prepare("SELECT content, ts FROM memories WHERE scope = 'correction' AND ts > ? ORDER BY ts DESC LIMIT 5").all(cutoff3d) as any[]
      if (corrections.length > 0) {
        for (const c of corrections) {
          const snippet = (c.content || '').slice(0, 60).replace(/\n/g, ' ')
          lines.push(`  • [${fmtDate(c.ts)}] ${snippet}${c.content.length > 60 ? '...' : ''}`)
        }
      } else {
        lines.push('  近 3 日无纠正，表现良好 ✓')
      }
    } catch {
      lines.push('  记忆数据不可用')
    }
  }

  return lines.join('\n')
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEEKLY REPORT — 每周周报
// ═══════════════════════════════════════════════════════════════════════════════

export function generateWeeklyReport(): string {
  const db = getDb()
  if (!db) return '📋 每周周报\n═══════════════════════════════\n数据库初始化中，请稍后重试。'
  const now = Date.now()
  const weekAgo = now - 7 * 86400000
  const lines: string[] = [
    '📋 每周周报',
    `═══════════════════════════════`,
    `${fmtDay(weekAgo)} — ${fmtDay(now)}`,
    '',
  ]

  // 1. 本周对话统计
  lines.push('━━ 对话统计 ━━')
  if (db) {
    try {
      const chatCount = (db.prepare('SELECT COUNT(*) as c FROM chat_history WHERE ts > ?').get(weekAgo) as any)?.c || 0
      const correctionCount = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE scope = 'correction' AND ts > ?").get(weekAgo) as any)?.c || 0
      lines.push(`  对话轮数: ${chatCount}`)
      lines.push(`  纠正次数: ${correctionCount}`)
      if (chatCount > 0) {
        const corrRate = ((correctionCount / chatCount) * 100).toFixed(1)
        lines.push(`  纠正率: ${corrRate}%`)
      }
    } catch {
      lines.push('  对话数据不可用')
    }
  }
  lines.push('')

  // 2. 记忆增长
  lines.push('━━ 记忆变化 ━━')
  if (db) {
    try {
      const newMem = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE scope != 'expired' AND ts > ?").get(weekAgo) as any)?.c || 0
      const expiredMem = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE scope = 'expired' AND ts > ?").get(weekAgo) as any)?.c || 0
      const pinnedMem = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE scope = 'pinned'").get() as any)?.c || 0
      const totalMem = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE scope != 'expired'").get() as any)?.c || 0
      lines.push(`  新增: +${newMem}  过期: -${expiredMem}  钉选: ${pinnedMem}`)
      lines.push(`  总记忆: ${totalMem}`)

      // 按 scope 分布
      const scopes = db.prepare("SELECT scope, COUNT(*) as c FROM memories WHERE scope != 'expired' GROUP BY scope ORDER BY c DESC LIMIT 5").all() as any[]
      if (scopes.length > 0) {
        const scopeStr = scopes.map((s: any) => `${s.scope}:${s.c}`).join(' ')
        lines.push(`  分布: ${scopeStr}`)
      }
    } catch {
      lines.push('  记忆数据不可用')
    }
  }
  lines.push('')

  // 3. 目标进度变化
  lines.push('━━ 目标进度 ━━')
  if (db) {
    try {
      const goals = db.prepare("SELECT id, title, progress, status FROM goals WHERE status != 'completed' ORDER BY created_at DESC").all() as any[]
      const completedThisWeek = db.prepare("SELECT COUNT(*) as c FROM goals WHERE status = 'completed' AND created_at > ?").get(new Date(weekAgo).toISOString()) as any
      if (goals.length > 0) {
        for (const g of goals) {
          const bar = progressBar(g.progress || 0)
          lines.push(`  • ${g.title}  ${bar} ${g.progress || 0}%`)
        }
      }
      if (completedThisWeek?.c > 0) {
        lines.push(`  本周完成: ${completedThisWeek.c} 个目标 ✓`)
      }
      if (goals.length === 0 && (!completedThisWeek?.c)) {
        lines.push('  无活跃目标')
      }
    } catch {
      lines.push('  目标数据不可用')
    }
  }
  lines.push('')

  // 4. 情绪周趋势 (复用现有 generateMoodReport 的核心数据)
  lines.push('━━ 情绪周趋势 ━━')
  const moodHistoryPath = resolve(DATA_DIR, 'mood_history.json')
  try {
    const moodHistory = loadJson<any[]>(moodHistoryPath, [])
    const recent = (moodHistory || []).filter((s: any) => s.ts > weekAgo)
    if (recent.length >= 2) {
      const moods = recent.map((s: any) => s.mood as number)
      const energies = recent.map((s: any) => s.energy as number)
      const avgMood = moods.reduce((a: number, b: number) => a + b, 0) / moods.length
      const avgEnergy = energies.reduce((a: number, b: number) => a + b, 0) / energies.length
      const maxMood = Math.max(...moods)
      const minMood = Math.min(...moods)
      const trend = getMoodTrend(168)
      const trendEmoji = trend === 'improving' ? '📈' : trend === 'declining' ? '📉' : '➡️'
      lines.push(`  快照数: ${recent.length}`)
      lines.push(`  平均心情: ${avgMood.toFixed(2)}  平均精力: ${(avgEnergy * 100).toFixed(0)}%`)
      lines.push(`  心情范围: ${minMood.toFixed(2)} ~ ${maxMood.toFixed(2)}`)
      lines.push(`  趋势: ${trendEmoji} ${trend}`)
    } else {
      lines.push('  数据不足')
    }
  } catch {
    lines.push('  情绪数据不可用')
  }
  lines.push('')

  // 5. 能力评分变化
  lines.push('━━ 能力评分 ━━')
  try {
    const capScore = getCapabilityScore()
    // capScore is a formatted string, indent it
    const capLines = capScore.split('\n').slice(1) // skip title line
    for (const cl of capLines) {
      if (cl.trim()) lines.push(`  ${cl}`)
    }
    if (capLines.filter(l => l.trim()).length === 0) {
      lines.push('  暂无能力数据')
    }
  } catch {
    lines.push('  能力评分不可用')
  }
  lines.push('')

  // 6. 本周学到的规则
  lines.push('━━ 本周学到的规则 ━━')
  try {
    const weekRules = rules.filter(r => r.ts > weekAgo)
    if (weekRules.length > 0) {
      for (const r of weekRules.slice(0, 8)) {
        const snippet = r.rule.slice(0, 50).replace(/\n/g, ' ')
        lines.push(`  • [命中${r.hits}次] ${snippet}${r.rule.length > 50 ? '...' : ''}`)
      }
      if (weekRules.length > 8) {
        lines.push(`  ...及其他 ${weekRules.length - 8} 条`)
      }
    } else {
      lines.push('  本周无新规则')
    }
  } catch {
    lines.push('  规则数据不可用')
  }

  // 附加：总体统计
  lines.push('')
  lines.push('━━ 总览 ━━')
  lines.push(`  累计对话: ${stats.totalMessages}  累计纠正: ${stats.corrections}  正面反馈: ${stats.positiveFeedback}`)

  return lines.join('\n')
}

// ═══════════════════════════════════════════════════════════════════════════════
// HEARTBEAT TRIGGER — 定时检查是否该发晨报/周报
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Called from handler-heartbeat.ts on every heartbeat.
 * Fires morning report (daily 8:00-9:00) and weekly report (Monday 8:00-9:00).
 * Returns the report text if fired, or null.
 */
export function checkScheduledReports(): string | null {
  const now = new Date()
  const hour = now.getHours()
  const day = now.getDay() // 0=Sun, 1=Mon
  const todayStr = now.toISOString().slice(0, 10)

  // Only fire during 8:00 - 8:59
  if (hour < 8 || hour > 8) return null

  // Weekly report: Monday 8:00-9:00
  if (day === 1 && lastWeeklyReportDate !== todayStr) {
    lastWeeklyReportDate = todayStr
    lastMorningReportDate = todayStr // weekly includes morning, skip duplicate
    return generateWeeklyReport()
  }

  // Morning report: every day 8:00-9:00 (except Monday which fires weekly)
  if (lastMorningReportDate !== todayStr) {
    lastMorningReportDate = todayStr
    return generateMorningReport()
  }

  return null
}

// ── Progress bar helper ──

function progressBar(percent: number): string {
  const filled = Math.round(percent / 10)
  const empty = 10 - filled
  return '▓'.repeat(filled) + '░'.repeat(empty)
}
