/**
 * plugin-commands.ts — Register cc-soul slash commands via OpenClaw's registerCommand API
 *
 * These commands return ReplyPayload directly, bypassing the LLM entirely.
 * Command names use cc_ prefix to avoid conflicts with OpenClaw built-in commands
 * (new, reset, stats, tts, help, model, image, voice, web, search, code, clear).
 *
 * Users type /cc_help, /cc_stats, /cc_search 芒果, etc.
 * Chinese aliases are registered via nativeNames where possible.
 */

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

import { DATA_DIR, REMINDERS_PATH } from './persistence.ts'
import { saveMemories } from './memory.ts'
import { formatMetrics } from './handler-state.ts'
import { generateMoodReport, body } from './body.ts'
import { getCapabilityScore } from './epistemic.ts'
import { getActivePersona } from './persona.ts'
import { executeSearch, executeMyMemories, executeStats, executeHealth, executeFeatures, executeTimeline } from './command-core.ts'

// ── Optional modules ──
let getCostSummary: () => string = () => '成本追踪模块未加载'
import('./cost-tracker.ts').then(m => { getCostSummary = m.getCostSummary }).catch(() => {})

// ── Command registration ──

export function registerPluginCommands(api: any) {
  if (typeof api.registerCommand !== 'function') {
    console.log('[cc-soul][commands] registerCommand not available, skipping slash commands')
    return
  }

  // ═══ cc_help ═══
  api.registerCommand({
    name: 'cc_help',
    nativeNames: { default: '帮助' },
    description: 'cc-soul 命令指南',
    handler: () => ({
      text: `cc-soul 命令指南

━━ 自动运行（无需操作） ━━
• 记忆：每条对话自动记录、去重、衰减、矛盾检测
• 人格：11种人格根据对话内容自动切换
• 情绪：实时追踪你的情绪，自动调整回应风格
• 学习：从你的纠正中学习规则
• 举一反三：回答问题时自动补充相关信息

━━ 斜杠命令 ━━
/cc_search <关键词>  — 搜索记忆
/cc_memories         — 查看最近记忆
/cc_delete <关键词>  — 删除匹配记忆
/cc_pin <关键词>     — 钉选记忆
/cc_unpin <关键词>   — 取消钉选
/cc_timeline <关键词> — 记忆变化历史
/cc_health           — 记忆健康报告
/cc_stats            — 个人仪表盘
/cc_soul             — AI 能量/心情/情绪
/cc_mood             — 7天情绪趋势
/cc_score            — 能力评分
/cc_cost             — Token 使用统计
/cc_features         — 功能开关状态
/cc_enable <功能>    — 开启功能
/cc_disable <功能>   — 关闭功能
/cc_train <偏好>     — 主动训练偏好（存为最高优先级规则）
/cc_checkin <习惯>   — 习惯打卡
/cc_habits           — 查看打卡记录
/cc_goal <描述>      — 创建目标
/cc_goals            — 查看目标
/cc_remind HH:MM <消息> — 设置提醒
/cc_reminders        — 查看提醒
/cc_export           — 导出记忆
/cc_audit            — 审计日志
/cc_metrics          — 系统运行指标

━━ 触发词（直接说） ━━
• "别记了" / "隐私模式" → 暂停记忆
• "可以了" / "关闭隐私" → 恢复记忆
• "帮我理解" → 苏格拉底模式`
    }),
  })

  // ═══ cc_search ═══
  api.registerCommand({
    name: 'cc_search',
    nativeNames: { default: '搜索记忆' },
    description: '搜索 cc-soul 记忆',
    acceptsArgs: true,
    handler: (ctx: any) => {
      const keyword = (ctx.args || '').trim()
      return { text: executeSearch(keyword, ctx.senderId) }
    },
  })

  // ═══ cc_memories ═══
  api.registerCommand({
    name: 'cc_memories',
    nativeNames: { default: '我的记忆' },
    description: '查看最近记忆',
    handler: (ctx: any) => ({ text: executeMyMemories(ctx.senderId) }),
  })

  // ═══ cc_delete ═══
  api.registerCommand({
    name: 'cc_delete',
    nativeNames: { default: '删除记忆' },
    description: '删除匹配关键词的记忆',
    acceptsArgs: true,
    handler: (ctx: any) => {
      const keyword = (ctx.args || '').trim()
      if (!keyword) return { text: '用法: /cc_delete <关键词>' }
      const mems = readMemoriesFromDisk()
      const kw = keyword.toLowerCase()
      let count = 0
      for (const m of mems) {
        if (count >= 5) break
        if (m.content.toLowerCase().includes(kw) && m.scope !== 'expired') {
          m.scope = 'expired'
          count++
        }
      }
      if (count === 0) return { text: `没有找到匹配「${keyword}」的记忆。` }
      try { saveMemories() } catch (_) {}
      return { text: `已标记 ${count} 条匹配「${keyword}」的记忆为过期。` }
    },
  })

  // ═══ cc_pin / cc_unpin ═══
  api.registerCommand({
    name: 'cc_pin',
    nativeNames: { default: 'pin记忆' },
    description: '钉选记忆（永不衰减）',
    acceptsArgs: true,
    handler: (ctx: any) => {
      const keyword = (ctx.args || '').trim()
      if (!keyword) return { text: '用法: /cc_pin <关键词>' }
      const mems = readMemoriesFromDisk()
      const kw = keyword.toLowerCase()
      let count = 0
      for (const m of mems) {
        if (m.content.toLowerCase().includes(kw) && m.scope !== 'expired' && m.scope !== 'pinned') {
          m.scope = 'pinned'
          count++
          if (count >= 3) break
        }
      }
      if (count === 0) return { text: `没有找到匹配「${keyword}」的记忆。` }
      try { saveMemories() } catch (_) {}
      return { text: `已钉选 ${count} 条匹配「${keyword}」的记忆。` }
    },
  })

  api.registerCommand({
    name: 'cc_unpin',
    nativeNames: { default: 'unpin记忆' },
    description: '取消钉选记忆',
    acceptsArgs: true,
    handler: (ctx: any) => {
      const keyword = (ctx.args || '').trim()
      if (!keyword) return { text: '用法: /cc_unpin <关键词>' }
      const mems = readMemoriesFromDisk()
      const kw = keyword.toLowerCase()
      let count = 0
      for (const m of mems) {
        if (m.content.toLowerCase().includes(kw) && m.scope === 'pinned') {
          m.scope = 'fact'
          count++
        }
      }
      if (count === 0) return { text: `没有找到已钉选的「${keyword}」记忆。` }
      try { saveMemories() } catch (_) {}
      return { text: `已取消钉选 ${count} 条记忆。` }
    },
  })

  // ═══ cc_timeline ═══
  api.registerCommand({
    name: 'cc_timeline',
    nativeNames: { default: '记忆时间线' },
    description: '查看记忆变化历史',
    acceptsArgs: true,
    handler: (ctx: any) => {
      const keyword = (ctx.args || '').trim()
      return { text: executeTimeline(keyword) }
    },
  })

  // ═══ cc_health ═══
  api.registerCommand({
    name: 'cc_health',
    nativeNames: { default: '记忆健康' },
    description: '记忆系统健康报告',
    handler: () => ({ text: executeHealth() }),
  })

  // ═══ cc_stats ═══
  api.registerCommand({
    name: 'cc_stats',
    nativeNames: { default: 'cc状态' },
    description: 'cc-soul 个人仪表盘',
    handler: () => ({ text: executeStats() }),
  })

  // ═══ cc_soul ═══
  api.registerCommand({
    name: 'cc_soul',
    nativeNames: { default: '灵魂状态' },
    description: 'AI 能量/心情/情绪',
    handler: () => ({
      text: `灵魂状态
能量: ${(body.energy * 100).toFixed(0)}%
心情: ${(body.mood * 100).toFixed(0)}%
负载: ${(body.load * 100).toFixed(0)}%
警觉: ${(body.alertness * 100).toFixed(0)}%
人格: ${getActivePersona()?.name || 'default'}`
    }),
  })

  // ═══ cc_mood ═══
  api.registerCommand({
    name: 'cc_mood',
    nativeNames: { default: '情绪周报' },
    description: '7天情绪趋势',
    handler: () => {
      const report = generateMoodReport()
      return { text: report || '暂无足够数据生成情绪周报。' }
    },
  })

  // ═══ cc_score ═══
  api.registerCommand({
    name: 'cc_score',
    nativeNames: { default: '能力评分' },
    description: '各领域能力评分',
    handler: () => {
      const score = getCapabilityScore()
      return { text: score || '暂无评分数据。' }
    },
  })

  // ═══ cc_cost ═══
  api.registerCommand({
    name: 'cc_cost',
    nativeNames: { default: '成本' },
    description: 'Token 使用统计',
    handler: () => ({ text: getCostSummary() }),
  })

  // ═══ cc_features ═══
  api.registerCommand({
    name: 'cc_features',
    nativeNames: { default: '功能状态' },
    description: '查看功能开关状态',
    handler: () => ({ text: executeFeatures() }),
  })

  // ═══ cc_enable / cc_disable ═══
  api.registerCommand({
    name: 'cc_enable',
    nativeNames: { default: '开启' },
    description: '开启功能',
    acceptsArgs: true,
    handler: (ctx: any) => {
      const feat = (ctx.args || '').trim()
      if (!feat) return { text: '用法: /cc_enable <功能名>' }
      try {
        const featPath = resolve(DATA_DIR, 'features.json')
        const feats = existsSync(featPath) ? JSON.parse(readFileSync(featPath, 'utf-8')) : {}
        feats[feat] = true
        const { writeFileSync } = require('fs')
        writeFileSync(featPath, JSON.stringify(feats, null, 2), 'utf-8')
        return { text: `✅ ${feat} 已开启` }
      } catch (e: any) {
        return { text: `开启失败: ${e.message}` }
      }
    },
  })

  api.registerCommand({
    name: 'cc_disable',
    nativeNames: { default: '关闭' },
    description: '关闭功能',
    acceptsArgs: true,
    handler: (ctx: any) => {
      const feat = (ctx.args || '').trim()
      if (!feat) return { text: '用法: /cc_disable <功能名>' }
      try {
        const featPath = resolve(DATA_DIR, 'features.json')
        const feats = existsSync(featPath) ? JSON.parse(readFileSync(featPath, 'utf-8')) : {}
        feats[feat] = false
        const { writeFileSync } = require('fs')
        writeFileSync(featPath, JSON.stringify(feats, null, 2), 'utf-8')
        return { text: `❌ ${feat} 已关闭` }
      } catch (e: any) {
        return { text: `关闭失败: ${e.message}` }
      }
    },
  })

  // ═══ cc_checkin ═══
  api.registerCommand({
    name: 'cc_checkin',
    nativeNames: { default: '打卡' },
    description: '习惯打卡',
    acceptsArgs: true,
    handler: (ctx: any) => {
      const habit = (ctx.args || '').trim()
      if (!habit) return { text: '用法: /cc_checkin <习惯名>' }
      try {
        const habitsPath = resolve(DATA_DIR, 'habits.json')
        const habits: Record<string, { streak: number; total: number; lastDate: string }> =
          existsSync(habitsPath) ? JSON.parse(readFileSync(habitsPath, 'utf-8')) : {}
        const today = new Date().toISOString().slice(0, 10)
        const h = habits[habit] || { streak: 0, total: 0, lastDate: '' }
        if (h.lastDate === today) return { text: `今天已经打过「${habit}」的卡了！连续 ${h.streak} 天` }
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
        h.streak = h.lastDate === yesterday ? h.streak + 1 : 1
        h.total++
        h.lastDate = today
        habits[habit] = h
        const { writeFileSync } = require('fs')
        writeFileSync(habitsPath, JSON.stringify(habits, null, 2), 'utf-8')
        return { text: `打卡成功！🎯\n「${habit}」— 连续 ${h.streak} 天，总计 ${h.total} 次` }
      } catch (e: any) {
        return { text: `打卡失败: ${e.message}` }
      }
    },
  })

  // ═══ cc_habits ═══
  api.registerCommand({
    name: 'cc_habits',
    nativeNames: { default: '习惯状态' },
    description: '查看打卡记录',
    handler: () => {
      try {
        const habitsPath = resolve(DATA_DIR, 'habits.json')
        if (!existsSync(habitsPath)) return { text: '还没有打卡记录。' }
        const habits = JSON.parse(readFileSync(habitsPath, 'utf-8'))
        const lines = Object.entries(habits).map(([name, h]: [string, any]) =>
          `• ${name}: 连续${h.streak}天 / 总${h.total}次`
        )
        return { text: lines.length > 0 ? `习惯追踪：\n${lines.join('\n')}` : '还没有打卡记录。' }
      } catch (_) {
        return { text: '读取失败。' }
      }
    },
  })

  // ═══ cc_goal / cc_goals ═══
  api.registerCommand({
    name: 'cc_goal',
    nativeNames: { default: '新目标' },
    description: '创建目标',
    acceptsArgs: true,
    handler: (ctx: any) => {
      const desc = (ctx.args || '').trim()
      if (!desc) return { text: '用法: /cc_goal <目标描述>' }
      try {
        const goalsPath = resolve(DATA_DIR, 'goals.json')
        const goals: any[] = existsSync(goalsPath) ? JSON.parse(readFileSync(goalsPath, 'utf-8')) : []
        goals.push({ description: desc, progress: 0, created: Date.now(), updates: [] })
        const { writeFileSync } = require('fs')
        writeFileSync(goalsPath, JSON.stringify(goals, null, 2), 'utf-8')
        return { text: `目标已创建！🎯\n「${desc}」— 进度 0%` }
      } catch (e: any) {
        return { text: `创建失败: ${e.message}` }
      }
    },
  })

  api.registerCommand({
    name: 'cc_goals',
    nativeNames: { default: '我的目标' },
    description: '查看所有目标',
    handler: () => {
      try {
        const goalsPath = resolve(DATA_DIR, 'goals.json')
        if (!existsSync(goalsPath)) return { text: '还没有目标。' }
        const goals = JSON.parse(readFileSync(goalsPath, 'utf-8'))
        if (goals.length === 0) return { text: '还没有目标。' }
        const lines = goals.map((g: any, i: number) => `${i + 1}. ${g.description} — ${g.progress || 0}%`)
        return { text: `我的目标：\n${lines.join('\n')}` }
      } catch (_) {
        return { text: '读取失败。' }
      }
    },
  })

  // ═══ cc_remind / cc_reminders ═══
  api.registerCommand({
    name: 'cc_remind',
    nativeNames: { default: '提醒' },
    description: '设置提醒（HH:MM 消息）',
    acceptsArgs: true,
    handler: (ctx: any) => {
      const args = (ctx.args || '').trim()
      const match = args.match(/^(\d{1,2})[：:](\d{2})\s+(.+)$/)
      if (!match) return { text: '用法: /cc_remind HH:MM 消息' }
      const [, h, m, msg] = match
      const time = `${h.padStart(2, '0')}:${m}`
      try {
        const reminders: any[] = existsSync(REMINDERS_PATH) ? JSON.parse(readFileSync(REMINDERS_PATH, 'utf-8')) : []
        reminders.push({ time, message: msg, created: Date.now() })
        const { writeFileSync } = require('fs')
        writeFileSync(REMINDERS_PATH, JSON.stringify(reminders, null, 2), 'utf-8')
        return { text: `已添加提醒：每天 ${time} — ${msg} ⏰` }
      } catch (e: any) {
        return { text: `设置失败: ${e.message}` }
      }
    },
  })

  api.registerCommand({
    name: 'cc_reminders',
    nativeNames: { default: '我的提醒' },
    description: '查看提醒列表',
    handler: () => {
      try {
        if (!existsSync(REMINDERS_PATH)) return { text: '还没有提醒。' }
        const reminders = JSON.parse(readFileSync(REMINDERS_PATH, 'utf-8'))
        if (reminders.length === 0) return { text: '还没有提醒。' }
        const lines = reminders.map((r: any, i: number) => `${i + 1}. 每天 ${r.time} — ${r.message}`)
        return { text: `你的提醒（${reminders.length} 条）：\n${lines.join('\n')}` }
      } catch (_) {
        return { text: '读取失败。' }
      }
    },
  })

  // ═══ cc_metrics ═══
  api.registerCommand({
    name: 'cc_metrics',
    nativeNames: { default: '监控' },
    description: '系统运行指标',
    handler: () => ({ text: formatMetrics() }),
  })

  // ═══ cc_export ═══
  api.registerCommand({
    name: 'cc_export',
    nativeNames: { default: '导出记忆' },
    description: '导出记忆为 JSON',
    handler: (ctx: any) => {
      try {
        const mems = readMemoriesFromDisk()
        const active = mems.filter((m: any) => m.scope !== 'expired' && m.scope !== 'decayed')
        const exportPath = resolve(DATA_DIR, 'export', `memories_${Date.now()}.json`)
        const { writeFileSync, mkdirSync } = require('fs')
        mkdirSync(resolve(DATA_DIR, 'export'), { recursive: true })
        writeFileSync(exportPath, JSON.stringify(active, null, 2), 'utf-8')
        return { text: `已导出 ${active.length} 条记忆到 ${exportPath}` }
      } catch (e: any) {
        return { text: `导出失败: ${e.message}` }
      }
    },
  })

  // ═══ cc_audit ═══
  api.registerCommand({
    name: 'cc_audit',
    nativeNames: { default: '审计日志' },
    description: '查看操作审计链',
    handler: () => {
      try {
        const { formatAuditLog } = require('./audit.ts')
        const log = formatAuditLog(20)
        return { text: log || '暂无审计记录。' }
      } catch (_) {
        return { text: '审计模块未加载。' }
      }
    },
  })

  // ═══ cc_train ═══
  api.registerCommand({
    name: 'cc_train',
    nativeNames: { default: '训练' },
    description: '主动训练偏好（比被动学习更精准）',
    acceptsArgs: true,
    handler: (ctx: any) => {
      const input = (ctx.args || '').trim()

      // 无参数 → 进入训练引导
      if (!input) {
        return {
          text: `🎯 训练模式

告诉我你的偏好，我会精确记住。格式：

/cc_train 回答代码问题时直接给代码，不要解释
/cc_train 被纠正时不要道歉，直接改
/cc_train 我喜欢简洁的回答，不超过200字
/cc_train 技术问题用中文，代码注释用英文

每条偏好会作为高优先级规则存入记忆。`
        }
      }

      // 有内容 → 存为高优先级偏好
      try {
        const { addMemory } = require('./memory.ts')
        const { body } = require('./body.ts')

        // 存为 preference scope + important emotion → 自动晋升 core
        addMemory(
          `[用户训练] ${input}`,
          'preference',
          ctx.senderId,
          'global',
          ctx.channelId,
          { attention: 'training', mood: body.mood, energy: body.energy }
        )

        // 直接标记为 important（触发 core 晋升）
        const { memoryState } = require('./memory.ts')
        const last = memoryState.memories[memoryState.memories.length - 1]
        if (last && last.content.includes(input)) {
          last.emotion = 'important'
          last.confidence = 1.0
          last.tier = 'long_term'
        }

        // 也存一条 rule
        try {
          const { rules } = require('./evolution.ts')
          const { saveJson } = require('./persistence.ts')
          const { resolve } = require('path')
          const { DATA_DIR } = require('./persistence.ts')
          rules.push({ rule: input, source: 'user_training', ts: Date.now(), hits: 0 })
          saveJson(resolve(DATA_DIR, 'rules.json'), rules)
        } catch (_) {}

        return { text: `✅ 记住了：「${input}」\n\n这条偏好已存为最高优先级规则，所有回复都会遵守。` }
      } catch (e: any) {
        return { text: `训练失败: ${e.message}` }
      }
    },
  })

  // cc_avatar — removed, testing via town.ts simulator only

  const count = 26
  console.log(`[cc-soul][commands] registered ${count} slash commands via registerCommand`)
}
