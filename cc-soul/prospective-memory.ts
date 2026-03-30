/**
 * prospective-memory.ts — "Remember to do X when Y happens"
 *
 * Unlike retrospective memory (searching the past), prospective memory
 * is about FUTURE intentions. No competitor has this.
 *
 * Examples:
 *   User says "下周要面试" → trigger: "面试|紧张|准备" → remind: "上次面试你说薪资报低了"
 *   User says "明天要出差" → trigger: "出差|机场|酒店" → remind: "你上次出差忘带充电器"
 *   User says "提醒我下次..." → explicit prospective memory creation
 */

import type { Memory } from './types.ts'
import { DATA_DIR, loadJson, debouncedSave } from './persistence.ts'
import { resolve } from 'path'

const PM_PATH = resolve(DATA_DIR, 'prospective_memory.json')

export interface ProspectiveMemory {
  id: string
  trigger: string        // regex-friendly keywords to match against future messages
  remind: string         // what to surface when trigger matches
  createdAt: number
  expiresAt: number      // auto-expire (0 = never)
  firedAt?: number       // when it was triggered (null if not yet)
  source: 'auto' | 'user_explicit'  // auto-detected vs user said "提醒我..."
  userId?: string
}

let pmStore: ProspectiveMemory[] = loadJson<ProspectiveMemory[]>(PM_PATH, [])
function savePM() { debouncedSave(PM_PATH, pmStore) }

let _counter = 0
function makeId(): string { return `pm_${Date.now()}_${_counter++}` }

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO-DETECTION — detect future intentions in user messages
// ═══════════════════════════════════════════════════════════════════════════════

interface FuturePattern {
  detect: RegExp                          // match user message
  triggerKeywords: string                 // what to listen for later
  remindTemplate: (match: RegExpMatchArray, msg: string) => string
  expiryDays: number                     // auto-expire after N days
}

const FUTURE_PATTERNS: FuturePattern[] = [
  {
    detect: /(?:下周|明天|后天|周[一二三四五六日天]).*(?:面试|interview)/,
    triggerKeywords: '面试|interview|紧张|准备|offer',
    remindTemplate: (_m, msg) => `用户之前提到有面试计划：${msg.slice(0, 60)}`,
    expiryDays: 14,
  },
  {
    detect: /(?:下周|明天|后天|周[一二三四五六日天]).*(?:出差|出行|旅行|飞)/,
    triggerKeywords: '出差|出行|机场|酒店|行李|航班',
    remindTemplate: (_m, msg) => `用户之前提到有出行计划：${msg.slice(0, 60)}`,
    expiryDays: 14,
  },
  {
    detect: /(?:准备|打算|计划|想).*(?:换工作|跳槽|离职|辞职)/,
    triggerKeywords: '简历|面试|offer|跳槽|离职|新工作',
    remindTemplate: (_m, msg) => `用户之前提到有跳槽意向：${msg.slice(0, 60)}`,
    expiryDays: 30,
  },
  {
    detect: /(?:准备|打算|计划|想).*(?:买房|买车|装修|搬家)/,
    triggerKeywords: '房|车|装修|搬家|贷款|首付|看房',
    remindTemplate: (_m, msg) => `用户之前提到有购买/搬迁计划：${msg.slice(0, 60)}`,
    expiryDays: 60,
  },
  {
    detect: /(?:下次|以后|记得).*(?:提醒|别忘|注意)/,
    triggerKeywords: '', // will be extracted from message
    remindTemplate: (_m, msg) => `用户要求记住：${msg.slice(0, 80)}`,
    expiryDays: 30,
  },
  {
    detect: /(?:deadline|ddl|截止|交付).*(?:下周|月底|号|日)/,
    triggerKeywords: 'deadline|ddl|截止|交付|来不及|进度',
    remindTemplate: (_m, msg) => `用户之前提到有截止日期：${msg.slice(0, 60)}`,
    expiryDays: 14,
  },
]

/**
 * Scan a user message for future intentions, auto-create prospective memories.
 */
export function detectProspectiveMemory(userMsg: string, userId?: string) {
  for (const pattern of FUTURE_PATTERNS) {
    const match = userMsg.match(pattern.detect)
    if (!match) continue

    // Check if we already have a similar PM
    const existing = pmStore.find(pm =>
      !pm.firedAt && pm.trigger === pattern.triggerKeywords && pm.userId === userId
    )
    if (existing) continue

    const pm: ProspectiveMemory = {
      id: makeId(),
      trigger: pattern.triggerKeywords || userMsg.slice(0, 30),
      remind: pattern.remindTemplate(match, userMsg),
      createdAt: Date.now(),
      expiresAt: pattern.expiryDays > 0 ? Date.now() + pattern.expiryDays * 86400000 : 0,
      source: /提醒|记得|别忘/.test(userMsg) ? 'user_explicit' : 'auto',
      userId,
    }
    pmStore.push(pm)
    savePM()
    console.log(`[cc-soul][prospective] created: "${pm.trigger}" → "${pm.remind.slice(0, 40)}"`)
  }
}

/**
 * Check if any prospective memory should fire for the current message.
 * Returns reminder text if triggered, null otherwise.
 */
export function checkProspectiveMemory(userMsg: string, userId?: string): string | null {
  const now = Date.now()
  const msgLower = userMsg.toLowerCase()
  const reminders: string[] = []

  for (const pm of pmStore) {
    if (pm.firedAt) continue  // already fired
    if (pm.expiresAt > 0 && now > pm.expiresAt) continue  // expired
    if (pm.userId && pm.userId !== userId) continue  // wrong user

    // Check trigger keywords
    const keywords = pm.trigger.split('|').filter(k => k.length >= 2)
    const matched = keywords.some(kw => msgLower.includes(kw.toLowerCase()))
    if (!matched) continue

    // Fire!
    pm.firedAt = now
    reminders.push(pm.remind)
    console.log(`[cc-soul][prospective] FIRED: "${pm.trigger}" → "${pm.remind.slice(0, 40)}"`)
  }

  if (reminders.length > 0) {
    savePM()
    return `[前瞻记忆] ${reminders.join('；')}`
  }
  return null
}

/**
 * Cleanup: remove expired and long-fired prospective memories.
 */
export function cleanupProspectiveMemories() {
  const now = Date.now()
  const FIRED_RETENTION = 7 * 86400000  // keep fired PMs for 7 days
  const before = pmStore.length
  pmStore = pmStore.filter(pm => {
    if (pm.expiresAt > 0 && now > pm.expiresAt && !pm.firedAt) return false  // expired, never fired
    if (pm.firedAt && now - pm.firedAt > FIRED_RETENTION) return false  // fired long ago
    return true
  })
  if (pmStore.length < before) {
    savePM()
    console.log(`[cc-soul][prospective] cleanup: removed ${before - pmStore.length} expired PMs`)
  }
}

export function getProspectiveMemoryCount(): number {
  return pmStore.filter(pm => !pm.firedAt && (!pm.expiresAt || pm.expiresAt > Date.now())).length
}
