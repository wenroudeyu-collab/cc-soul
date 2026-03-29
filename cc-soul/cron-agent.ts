/**
 * cron-agent.ts — Cron 自主调度
 *
 * 用户可定义定时任务，agent 在后台无人值守执行。
 * 由 heartbeat 每 30 分钟调用 tickCron() 检查到期任务。
 *
 * Schedule 格式：
 *   "daily HH:MM"        — 每天指定时刻
 *   "weekly DAY HH:MM"   — 每周指定日指定时刻 (DAY = mon/tue/wed/thu/fri/sat/sun)
 *   "every Nm"            — 每 N 分钟
 */

import type { SoulModule } from './brain.ts'
import { DATA_DIR, loadJson, debouncedSave } from './persistence.ts'
import { spawnCLI } from './cli.ts'
import { resolve } from 'path'

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface CronTask {
  id: string
  schedule: string          // "daily HH:MM" | "weekly DAY HH:MM" | "every Nm"
  prompt: string            // 要执行的 prompt
  label: string             // 人类可读标签
  createdAt: number
  lastRun: number           // 上次执行时间戳 (0 = 从未执行)
  runCount: number
  enabled: boolean
}

interface CronStore {
  tasks: CronTask[]
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

const CRON_PATH = resolve(DATA_DIR, 'cron_tasks.json')
let store: CronStore = { tasks: [] }

function persist() {
  debouncedSave(CRON_PATH, store)
}

function genId(): string {
  return `cron_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEDULE PARSER
// ═══════════════════════════════════════════════════════════════════════════════

const DAY_MAP: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  // Chinese aliases
  '日': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6,
}

interface ParsedSchedule {
  type: 'daily' | 'weekly' | 'interval'
  hour?: number
  minute?: number
  dayOfWeek?: number       // 0=Sun
  intervalMinutes?: number
}

function parseSchedule(schedule: string): ParsedSchedule | null {
  const s = schedule.trim().toLowerCase()

  // "every Nm" — interval
  const intervalMatch = s.match(/^every\s+(\d+)\s*m$/)
  if (intervalMatch) {
    const minutes = parseInt(intervalMatch[1], 10)
    if (minutes <= 0 || minutes > 10080) return null // max 1 week
    return { type: 'interval', intervalMinutes: minutes }
  }

  // "daily HH:MM"
  const dailyMatch = s.match(/^daily\s+(\d{1,2}):(\d{2})$/)
  if (dailyMatch) {
    const hour = parseInt(dailyMatch[1], 10)
    const minute = parseInt(dailyMatch[2], 10)
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
    return { type: 'daily', hour, minute }
  }

  // "weekly DAY HH:MM"
  const weeklyMatch = s.match(/^weekly\s+(\S+)\s+(\d{1,2}):(\d{2})$/)
  if (weeklyMatch) {
    const dayStr = weeklyMatch[1]
    const hour = parseInt(weeklyMatch[2], 10)
    const minute = parseInt(weeklyMatch[3], 10)
    const dayOfWeek = DAY_MAP[dayStr]
    if (dayOfWeek === undefined || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
    return { type: 'weekly', dayOfWeek, hour, minute }
  }

  return null
}

/**
 * Check if a task is due for execution given the current time.
 */
function isDue(task: CronTask, now: number): boolean {
  if (!task.enabled) return false

  const parsed = parseSchedule(task.schedule)
  if (!parsed) return false

  if (parsed.type === 'interval') {
    const interval = parsed.intervalMinutes! * 60000
    return (now - task.lastRun) >= interval
  }

  const date = new Date(now)

  if (parsed.type === 'daily') {
    // Check if we're within the window (task hour:minute) and haven't run today
    const todayTarget = new Date(now)
    todayTarget.setHours(parsed.hour!, parsed.minute!, 0, 0)
    const targetTs = todayTarget.getTime()
    // Due if: target time has passed, and last run was before target
    return now >= targetTs && task.lastRun < targetTs
  }

  if (parsed.type === 'weekly') {
    const currentDay = date.getDay()
    if (currentDay !== parsed.dayOfWeek) return false
    const todayTarget = new Date(now)
    todayTarget.setHours(parsed.hour!, parsed.minute!, 0, 0)
    const targetTs = todayTarget.getTime()
    return now >= targetTs && task.lastRun < targetTs
  }

  return false
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

export function addCronTask(task: { schedule: string; prompt: string; label: string }): string {
  const parsed = parseSchedule(task.schedule)
  if (!parsed) {
    throw new Error(`Invalid schedule format: "${task.schedule}". Use "daily HH:MM", "weekly DAY HH:MM", or "every Nm".`)
  }

  const id = genId()
  const cronTask: CronTask = {
    id,
    schedule: task.schedule,
    prompt: task.prompt,
    label: task.label,
    createdAt: Date.now(),
    lastRun: 0,
    runCount: 0,
    enabled: true,
  }
  store.tasks.push(cronTask)
  persist()
  console.log(`[cc-soul][cron] added task: ${id} — ${task.label} (${task.schedule})`)
  return id
}

export function removeCronTask(taskId: string): boolean {
  const idx = store.tasks.findIndex(t => t.id === taskId)
  if (idx === -1) return false
  const removed = store.tasks.splice(idx, 1)[0]
  persist()
  console.log(`[cc-soul][cron] removed task: ${taskId} — ${removed.label}`)
  return true
}

export function listCronTasks(): CronTask[] {
  return [...store.tasks]
}

export function tickCron(): void {
  const now = Date.now()
  let triggered = 0

  for (const task of store.tasks) {
    if (!isDue(task, now)) continue
    triggered++
    task.lastRun = now
    task.runCount++
    persist()

    console.log(`[cc-soul][cron] executing: ${task.label} (${task.id})`)
    spawnCLI(
      `[定时任务: ${task.label}] ${task.prompt}`,
      (output) => {
        console.log(`[cc-soul][cron] task ${task.id} completed (${output.length} chars)`)
      },
      300000, // 5 min timeout for cron tasks
      `cron:${task.label}`,
    )
  }

  if (triggered > 0) {
    console.log(`[cc-soul][cron] tick: ${triggered} task(s) executed`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND HANDLER — natural language interface
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse user commands like:
 *   "定时任务 每天8:00 总结代码"
 *   "定时任务 每周一9:00 检查PR"
 *   "定时任务 每30分钟 检查服务状态"
 *   "定时任务 列表"
 *   "定时任务 删除 <id>"
 */
export function handleCronCommand(msg: string): string | false {
  const trimmed = msg.trim()

  // Match prefix
  if (!/^(定时任务|cron)\b/i.test(trimmed)) return false
  const body = trimmed.replace(/^(定时任务|cron)\s*/i, '').trim()

  // List
  if (/^(列表|list)$/i.test(body)) {
    const tasks = listCronTasks()
    if (tasks.length === 0) return '当前没有定时任务。'
    const lines = tasks.map((t, i) =>
      `${i + 1}. [${t.enabled ? '✓' : '✗'}] ${t.label} — ${t.schedule} (已执行 ${t.runCount} 次) id:${t.id}`
    )
    return `定时任务列表 (${tasks.length}):\n${lines.join('\n')}`
  }

  // Remove
  const removeMatch = body.match(/^(删除|remove|del)\s+(\S+)/i)
  if (removeMatch) {
    const taskId = removeMatch[2]
    const ok = removeCronTask(taskId)
    return ok ? `已删除定时任务: ${taskId}` : `未找到任务: ${taskId}`
  }

  // Add — parse schedule + prompt
  // "每天HH:MM prompt" or "每N分钟 prompt" or "每周X HH:MM prompt"
  let schedule: string | null = null
  let prompt: string | null = null
  let label: string | null = null

  // "每天 HH:MM ..." or "每天HH:MM ..."
  const dailyMatch = body.match(/^每天\s*(\d{1,2}[:：]\d{2})\s+(.+)/)
  if (dailyMatch) {
    const time = dailyMatch[1].replace('：', ':')
    schedule = `daily ${time}`
    prompt = dailyMatch[2].trim()
  }

  // "每周X HH:MM ..."
  if (!schedule) {
    const weeklyMatch = body.match(/^每周([一二三四五六日])\s*(\d{1,2}[:：]\d{2})\s+(.+)/)
    if (weeklyMatch) {
      const dayChar = weeklyMatch[1]
      const time = weeklyMatch[2].replace('：', ':')
      const dayKey = DAY_MAP[dayChar]
      // Reverse-map to English day
      const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
      schedule = `weekly ${dayNames[dayKey]} ${time}`
      prompt = weeklyMatch[3].trim()
    }
  }

  // "每N分钟 ..."
  if (!schedule) {
    const intervalMatch = body.match(/^每(\d+)分钟\s+(.+)/)
    if (intervalMatch) {
      schedule = `every ${intervalMatch[1]}m`
      prompt = intervalMatch[2].trim()
    }
  }

  // English fallback: "daily HH:MM ...", "weekly DAY HH:MM ...", "every Nm ..."
  if (!schedule) {
    const engDailyMatch = body.match(/^(daily\s+\d{1,2}:\d{2})\s+(.+)/i)
    if (engDailyMatch) {
      schedule = engDailyMatch[1]
      prompt = engDailyMatch[2].trim()
    }
  }
  if (!schedule) {
    const engWeeklyMatch = body.match(/^(weekly\s+\S+\s+\d{1,2}:\d{2})\s+(.+)/i)
    if (engWeeklyMatch) {
      schedule = engWeeklyMatch[1]
      prompt = engWeeklyMatch[2].trim()
    }
  }
  if (!schedule) {
    const engIntervalMatch = body.match(/^(every\s+\d+m)\s+(.+)/i)
    if (engIntervalMatch) {
      schedule = engIntervalMatch[1]
      prompt = engIntervalMatch[2].trim()
    }
  }

  if (!schedule || !prompt) {
    return '格式错误。用法：\n  定时任务 每天8:00 总结代码\n  定时任务 每周一9:00 检查PR\n  定时任务 每30分钟 检查服务状态\n  定时任务 列表\n  定时任务 删除 <id>'
  }

  // Use first 20 chars of prompt as label
  label = prompt.length > 20 ? prompt.slice(0, 20) + '...' : prompt

  try {
    const id = addCronTask({ schedule, prompt, label })
    return `已创建定时任务:\n  ID: ${id}\n  调度: ${schedule}\n  内容: ${prompt}`
  } catch (e: any) {
    return `创建失败: ${e.message}`
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOUL MODULE
// ═══════════════════════════════════════════════════════════════════════════════

export const cronAgentModule: SoulModule = {
  id: 'cron-agent',
  name: 'Cron 自主调度',
  features: ['cron_agent'],
  dependencies: [],
  priority: 40,
  enabled: true,

  init() {
    store = loadJson<CronStore>(CRON_PATH, { tasks: [] })
    // Migrate: if stored as array (old format), wrap it
    if (Array.isArray(store)) {
      store = { tasks: store as any as CronTask[] }
    }
    console.log(`[cc-soul][cron] loaded ${store.tasks.length} task(s)`)
  },

  onHeartbeat() {
    tickCron()
  },

  onCommand(event: any) {
    // Integration with handler-commands if needed
    const msg = event?.message ?? event?.msg ?? ''
    const result = handleCronCommand(msg)
    if (result !== false && event) {
      event.handled = true
      event.reply = result
    }
  },
}
