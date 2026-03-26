/**
 * handler-commands.ts — 命令路由（40+ 命令）
 *
 * 从 handler.ts 提取所有命令处理逻辑。
 * 导出 routeCommand()：返回 true 表示命令已处理（handler.ts 应 return）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { exec } from 'child_process'
import { homedir } from 'os'
import { resolve } from 'path'

import type { SessionState } from './handler-state.ts'
import {
  stats, formatMetrics, shortcuts,
  getPrivacyMode, setPrivacyMode, saveStats,
} from './handler-state.ts'
import { loadJson, debouncedSave, DATA_DIR, REMINDERS_PATH, soulConfig } from './persistence.ts'
import { isAuditCommand, formatAuditLog, appendAudit } from './audit.ts'
import { dbGetHabits, dbCheckin, dbGetGoals, dbAddGoal, dbUpdateGoalProgress, dbGetReminders, dbAddReminder, dbDeleteReminder } from './sqlite-store.ts'
import { handleFeatureCommand, isEnabled } from './features.ts'
import {
  memoryState, recall, addMemory, addMemoryWithEmotion, saveMemories,
  queryMemoryTimeline, ensureMemoriesLoaded,
} from './memory.ts'
import { generateMoodReport } from './body.ts'
import { generateMorningReport, generateWeeklyReport } from './reports.ts'
import { getCapabilityScore } from './epistemic.ts'
import { handleDashboardCommand, generateMemoryMapHTML, generateDashboardHTML } from './user-dashboard.ts'
// ── Optional modules (absent in public build) ──
let handleSyncCommand: (msg: string) => boolean = () => false
import('./sync.ts').then(m => { handleSyncCommand = m.handleSyncCommand }).catch(() => {})
let handleUpgradeCommand: (msg: string, stats: any) => boolean = () => false
import('./upgrade.ts').then(m => { handleUpgradeCommand = m.handleUpgradeCommand }).catch(() => {})
let handleRadarCommand: (msg: string) => boolean = () => false
import('./competitive-radar.ts').then(m => { handleRadarCommand = m.handleRadarCommand }).catch(() => {})
// ── End optional modules ──
import { startExperiment } from './experiment.ts'
import { handleTuneCommand } from './auto-tune.ts'
import { ingestFile } from './rag.ts'
import { innerState } from './inner-life.ts'
import { getAllValues } from './values.ts'
import { PERSONAS } from './persona.ts'
import { parseGroupChatCommand, triggerGroupChat } from './debate.ts'
import { checkTaskConfirmation } from './tasks.ts'
import { replySender } from './notify.ts'
// ── Optional modules ──
let getCostSummary: () => string = () => '成本追踪模块未加载'
import('./cost-tracker.ts').then(m => { getCostSummary = m.getCostSummary }).catch(() => {})

// ── Command dedup: prevent double replies from inbound_claim + hooks ──
let _lastDirectCmd = { content: '', ts: 0 }
export function wasHandledByDirect(msg: string): boolean {
  return _lastDirectCmd.content === msg.trim() && Date.now() - _lastDirectCmd.ts < 8000
}
function markHandledByDirect(msg: string) {
  _lastDirectCmd = { content: msg.trim(), ts: Date.now() }
}

// ── Command reply helper ──
// Uses OpenClaw SDK (replySender) to send command results directly.
// cfg is threaded through from inbound_claim hook or falls back to legacy path.
let _replyCfg: any = null   // set by handleCommandInbound / setReplyCfg
export function setReplyCfg(cfg: any) { _replyCfg = cfg }

function cmdReply(ctx: any, event: any, session: SessionState, text: string, userMsg: string) {
  session.lastPrompt = userMsg
  console.log(`[cc-soul][cmdReply] sending reply (${text.length} chars): ${text.slice(0, 50)}...`)
  // Determine recipient address
  const evCtx = event?.context || {}
  const to = event?._replyTo || evCtx.conversationId || evCtx.chatId || ''
  replySender(to, text, _replyCfg || event?._replyCfg)
    .then(() => console.log(`[cc-soul][cmdReply] sent OK`))
    .catch((e: any) => console.error(`[cc-soul][cmdReply] failed: ${e.message}`))
  // Minimal bodyForAgent to prevent AI from answering the command again
  ctx.bodyForAgent = '[系统] 命令已处理，结果已发送。'
}

/**
 * Route user commands. Returns true if the command was handled (caller should return early).
 */
export function routeCommand(
  userMsg: string,
  ctx: any,
  session: SessionState,
  senderId: string,
  channelId: string,
  event: any,
): boolean {
  console.log(`[cc-soul][routeCommand] v2 msg="${userMsg.slice(0,30)}"`)

  // ── Dedup: skip if already handled by routeCommandDirect (inbound_claim path) ──
  if (wasHandledByDirect(userMsg)) {
    console.log(`[cc-soul][routeCommand] skipped: already handled by routeCommandDirect`)
    ctx.bodyForAgent = '[系统] 命令已处理，结果已发送。'
    return true
  }

  // ── Help command ──
  if (/^(help|帮助|命令列表|commands)$/i.test(userMsg.trim())) {
    const helpText = `cc-soul 命令指南

━━ 自动运行（无需操作） ━━
• 记忆：每条对话自动记录、去重、衰减、矛盾检测
• 人格：11种人格根据对话内容自动切换（工程师/朋友/严师/分析师/安抚者/军师/探索者/执行者/导师/魔鬼代言人/苏格拉底）
• 情绪：实时追踪你的情绪，自动调整回应风格
• 学习：从你的纠正中学习规则，3次验证后永久生效
• 举一反三：回答问题时自动补充你可能需要的相关信息

━━ 触发词（说出即生效） ━━
• "帮我理解" / "引导我" / "别告诉我答案" → 苏格拉底模式（用提问引导你）
• "隐私模式" / "别记了" → 暂停记忆 | "可以了" → 恢复
• "上次聊..." / "接着聊..." → 自动回忆相关话题

━━ 记忆管理 ━━
• 我的记忆 / my memories          — 查看最近记忆
• 搜索记忆 <关键词>               — 搜索记忆
• 删除记忆 <关键词>               — 删除匹配记忆
• pin 记忆 <关键词>               — 钉选（永不衰减）
• unpin 记忆 <关键词>             — 取消钉选
• 记忆时间线 <关键词>             — 查看变化历史
• 记忆健康                        — 记忆统计报告
• 记忆审计                        — 检查重复/异常

━━ 导入导出 ━━
• 导出记忆 / export memories      — 导出为 JSON
• 导入记忆 <路径>                 — 导入（支持 cc-soul/Mem0/ChatGPT/Character Card 格式）
• 导出灵魂 / export soul          — 导出灵魂配置
• 导入灵魂 <路径>                 — 导入灵魂配置
• 导出lorebook                    — 导出知识库（去敏）
• 摄入文档 <路径> / ingest <path> — 导入文档到记忆

━━ 日常工具 ━━
• 打卡 <习惯名>                   — 习惯打卡（有连续天数里程碑）
• 习惯状态 / habits               — 查看打卡记录
• 新目标 <描述>                   — 创建目标
• 目标进度 <目标名> <更新>        — 更新进度
• 我的目标 / my goals             — 查看目标
• 提醒 HH:MM <消息>              — 设置每日提醒
• 我的提醒 / my reminders         — 查看提醒
• 删除提醒 <序号>                 — 删除提醒

━━ 状态查看 ━━
• stats                           — 个人仪表盘
• soul state                      — AI 能量/心情/情绪
• 晨报 / morning report          — 每日晨报
• 周报 / weekly report           — 每周周报
• 情绪周报 / mood report          — 7天情绪趋势
• 能力评分 / capability score     — 各领域能力评分
• metrics / 监控                  — 系统运行指标
• cost / 成本                     — Token 使用统计
• dashboard / 仪表盘              — 打开网页仪表盘
• 记忆图谱 html                   — 打开记忆可视化
• 对话摘要                        — 最近对话摘要

━━ 群聊讨论 ━━
• 群聊 <话题> / group chat <topic>  — 多角色群聊讨论（3-5 persona 多轮辩论+总结）

━━ 高级功能 ━━
• 功能状态 / features             — 查看所有功能开关
• 开启 <功能> / 关闭 <功能>       — 开关功能
• 审计日志 / audit log            — 查看操作审计链
• 开始实验 <描述>                 — 启动 A/B 实验

━━ 向量搜索（可选） ━━
下载模型后记忆搜索从关键词匹配升级为语义理解：
  mkdir -p ~/.openclaw/plugins/cc-soul/data/models/minilm
  cd ~/.openclaw/plugins/cc-soul/data/models/minilm
  curl -L -o model.onnx "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx"
  curl -L -o vocab.json "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json"
不下载也完全正常工作，只是用关键词匹配。`
    cmdReply(ctx, event, session, helpText, userMsg)
    return true
  }

  // ── Privacy mode toggle (Feature 2) ──
  if (userMsg.includes('别记了') || userMsg.includes('隐私模式') || userMsg.includes('privacy mode')) {
    setPrivacyMode(true)
    console.log('[cc-soul] privacy mode ON')
    cmdReply(ctx, event, session, '隐私模式已开启，对话内容不会被记忆。说"可以了"恢复。', userMsg)
    return true
  }
  if (getPrivacyMode() && (userMsg.includes('可以了') || userMsg.includes('关闭隐私') || userMsg.includes('恢复记忆'))) {
    setPrivacyMode(false)
    console.log('[cc-soul] privacy mode OFF')
    cmdReply(ctx, event, session, '隐私模式已关闭，恢复记忆。', userMsg)
    return true
  }

  // ── Visual memory: detect image/screenshot descriptions injected by OpenClaw vision ──
  if (!getPrivacyMode()) {
    const imageMatch = userMsg.match(/\[(?:Image|图片|Screenshot|截图)[:\s]([^\]]+)\]/i)
    if (imageMatch) {
      addMemory(`[视觉记忆] ${imageMatch[1].slice(0, 200)}`, 'visual', senderId, 'channel', channelId)
      console.log(`[cc-soul][visual] stored image memory: ${imageMatch[1].slice(0, 60)}`)
    }
  }

  // Audit log command
  if (isAuditCommand(userMsg)) {
    const log = formatAuditLog(20)
    cmdReply(ctx, event, session, log, userMsg)
    return true
  }

  // Feature toggle command check
  const featureResult = handleFeatureCommand(userMsg)
  if (featureResult) {
    cmdReply(ctx, event, session, typeof featureResult === 'string' ? featureResult : '功能开关已更新。', userMsg)
    return true
  }

  // ── Document ingest command: "摄入文档 <path>" / "ingest <path>" ──
  const ingestMatch = userMsg.match(/^(摄入文档|ingest)\s+(.+)$/i)
  if (ingestMatch) {
    const filePath = ingestMatch[2].trim()
    const resolvedPath = resolve(filePath.replace(/^~/, homedir()))
    const safeRoots = [homedir(), '/tmp']
    if (!safeRoots.some(root => resolvedPath.startsWith(root))) {
      cmdReply(ctx, event, session, '安全限制：只能导入家目录或 /tmp 下的文件。', userMsg)
      return true
    }
    const count = ingestFile(filePath, senderId, channelId)
    if (count >= 0) {
      cmdReply(ctx, event, session, `已摄入 ${count} 个片段，来源: "${filePath}"`, userMsg)
      return true
    } else {
      cmdReply(ctx, event, session, `文件读取失败: "${filePath}"，请检查路径和权限。`, userMsg)
      return true
    }
  }

  // ── Quick shortcuts (Feature 3) ──
  const shortcutCmd = shortcuts[userMsg.trim()]
  if (shortcutCmd) {
    if (shortcutCmd === '功能状态') {
      const result = handleFeatureCommand('功能状态')
      cmdReply(ctx, event, session, typeof result === 'string' ? result : '功能开关已更新。', userMsg)
      return true
    }
    if (shortcutCmd === '记忆图谱') {
      cmdReply(ctx, event, session, '记忆图谱功能已触发，请稍候。', userMsg)
      return true
    }
    if (shortcutCmd === '最近在聊什么') {
      const recentTopics = memoryState.chatHistory.slice(-5).map(h => h.user.slice(0, 30)).join(' → ')
      cmdReply(ctx, event, session, `最近话题轨迹: ${recentTopics || '暂无记录'}`, userMsg)
      return true
    }
    if (shortcutCmd === '紧急模式') {
      cmdReply(ctx, event, session, '紧急模式已开启，将提供快速精准的回答。', userMsg)
      return true
    }
  }

  // ── Metrics / 监控 command ──
  if (/^(metrics|监控|运行状态)$/i.test(userMsg.trim())) {
    const display = formatMetrics()
    cmdReply(ctx, event, session, display, userMsg)
    return true
  }

  // Web Dashboard
  if (/^(dashboard|仪表盘)$/i.test(userMsg.trim())) {
    const htmlPath = generateDashboardHTML()
    exec(`open "${htmlPath}"`)
    cmdReply(ctx, event, session, `Dashboard generated and opened: ${htmlPath}`, userMsg)
    return true
  }

  // P1-#7: 记忆图谱 HTML 可视化
  if (/^(记忆图谱\s*html|memory map\s*html)$/i.test(userMsg.trim())) {
    const htmlPath = generateMemoryMapHTML()
    exec(`open "${htmlPath}"`)
    cmdReply(ctx, event, session, `已生成记忆图谱 HTML 并打开: ${htmlPath}`, userMsg)
    return true
  }

  // P1-#10: 情绪周报
  if (/^(情绪周报|mood report)$/i.test(userMsg.trim())) {
    const report = generateMoodReport()
    cmdReply(ctx, event, session, report, userMsg)
    return true
  }

  // 晨报
  if (/^(晨报|morning report)$/i.test(userMsg.trim())) {
    try {
      const report = generateMorningReport()
      cmdReply(ctx, event, session, report, userMsg)
    } catch (e: any) { cmdReply(ctx, event, session, '晨报生成失败: ' + e.message, userMsg) }
    return true
  }

  // 周报
  if (/^(周报|weekly report)$/i.test(userMsg.trim())) {
    try {
      const report = generateWeeklyReport()
      cmdReply(ctx, event, session, report, userMsg)
    } catch (e: any) { cmdReply(ctx, event, session, '周报生成失败: ' + e.message, userMsg) }
    return true
  }

  // P1-#12: 对话能力评分公示
  if (/^(能力评分|capability score)$/i.test(userMsg.trim())) {
    const score = getCapabilityScore()
    cmdReply(ctx, event, session, score, userMsg)
    return true
  }

  // Cost / token usage command
  if (/^(cost|token cost|token使用|成本)$/i.test(userMsg.trim())) {
    cmdReply(ctx, event, session, getCostSummary(), userMsg)
    return true
  }

  // User dashboard commands
  const dashboardResult = handleDashboardCommand(userMsg, senderId, stats.totalMessages, stats.corrections)
  if (dashboardResult) {
    cmdReply(ctx, event, session, dashboardResult, userMsg)
    return true
  }

  // Sync command check
  if (isEnabled('sync') && handleSyncCommand(userMsg)) {
    cmdReply(ctx, event, session, '同步指令已执行。', userMsg)
    return true
  }

  // Manual experiment creation: "开始实验 <描述>"
  if (userMsg.includes('开始实验')) {
    const desc = userMsg.replace('开始实验', '').trim() || '手动实验'
    const expId = startExperiment(desc, desc, 3, 20)
    cmdReply(ctx, event, session, `已创建 A/B 实验 "${desc}" (id: ${expId})，20% 流量，3 天后自动结论。`, userMsg)
    return true
  }

  // ── Memory / export / soul commands (before upgrade check to avoid interception) ──
  const cmdMatch = userMsg.trim()
  if (/^(我的记忆|my memories)$/i.test(cmdMatch) || /^(导出记忆|export memories)$/i.test(cmdMatch) || /^(导出灵魂|export soul)$/i.test(cmdMatch) || /^(导入记忆|import memories)/i.test(cmdMatch) || /^(导入灵魂|import soul)/i.test(cmdMatch) || /^(导出lorebook|export lorebook)$/i.test(cmdMatch)) {
    // Let these fall through to their handlers below, skip upgrade check
  } else {
    // Upgrade command check
    if (handleUpgradeCommand(userMsg, stats)) {
      console.log(`[cc-soul] upgrade command matched: "${userMsg.slice(0, 30)}"`)
      session.lastPrompt = userMsg
      return true
    }
  }

  // Competitive radar commands
  if (handleRadarCommand(userMsg)) {
    cmdReply(ctx, event, session, '竞品雷达指令已执行，结果会私聊通知你。', userMsg)
    return true
  }

  // Auto-tune commands
  if (handleTuneCommand(userMsg)) {
    cmdReply(ctx, event, session, '调参指令已执行。', userMsg)
    return true
  }

  // ── Memory view / export commands ──
  if (/^(我的记忆|my memories)$/i.test(userMsg.trim())) {
    // Read from JSON file (memoryState.memories may not be loaded in lightweight init)
    try {
      const memPath = resolve(DATA_DIR, 'memories.json')
      const allMems = existsSync(memPath) ? JSON.parse(readFileSync(memPath, 'utf-8')) : []
      const active = allMems.filter((m: any) => m.scope !== 'expired' && m.scope !== 'decayed')
      const userMems = active
        .filter((m: any) => !senderId || !m.userId || m.userId === senderId)
        .sort((a: any, b: any) => (b.ts || 0) - (a.ts || 0))
        .slice(0, 20)
      const total = active.filter((m: any) => !senderId || !m.userId || m.userId === senderId).length
      const lines = userMems.map((m: any, i: number) => {
        const ago = Math.floor((Date.now() - (m.ts || 0)) / 86400000)
        const agoStr = ago === 0 ? '今天' : `${ago}天前`
        return `${i + 1}. [${m.scope}] ${m.content.slice(0, 60)}（${agoStr}）`
      })
      const display = `你的记忆（共 ${total} 条）：\n${lines.join('\n')}`
      cmdReply(ctx, event, session, display, userMsg)
    } catch (e: any) {
      cmdReply(ctx, event, session, `记忆读取失败: ${e.message}`, userMsg)
    }
    return true
  }

  // ── Memory search command ──
  const searchMatch = userMsg.match(/^(搜索记忆|search memory)\s+(.+)$/i)
  if (searchMatch) {
    const keyword = searchMatch[2].trim()
    console.log(`[cc-soul][cmd-search] searching for "${keyword}", memoryState.memories.length=${memoryState?.memories?.length || 'N/A'}`)
    let results = recall(keyword, 10, senderId)
    console.log(`[cc-soul][cmd-search] recall returned ${results.length} results`)
    // Fallback: if in-memory recall fails, search JSON file directly
    if (results.length === 0) {
      try {
        const memPath = resolve(DATA_DIR, 'memories.json')
        if (existsSync(memPath)) {
          const allMems = JSON.parse(readFileSync(memPath, 'utf-8'))
          const kw = keyword.toLowerCase()
          results = allMems.filter((m: any) =>
            m.scope !== 'expired' && m.scope !== 'decayed' &&
            (m.content.toLowerCase().includes(kw) ||
             (m.tags && m.tags.some((t: string) => t.toLowerCase().includes(kw))))
          ).slice(0, 10)
          if (results.length > 0) console.log(`[cc-soul][search] fallback found ${results.length} in JSON for "${keyword}"`)
        }
      } catch (e: any) {
        console.error(`[cc-soul][search] fallback error: ${e.message}`)
      }
    }
    if (results.length === 0) {
      cmdReply(ctx, event, session, `Memory search results for "${keyword}":\n\n没有找到相关记忆。`, userMsg)
      return true
    } else {
      const lines = results.map((m, i) => {
        const ago = Math.floor((Date.now() - m.ts) / 86400000)
        const agoStr = ago === 0 ? '今天' : `${ago}天前`
        const emotionStr = m.emotion && m.emotion !== 'neutral' ? ` (${m.emotion})` : ''
        return `${i + 1}. [${m.scope}] ${m.content.slice(0, 80)}${emotionStr}（${agoStr}）`
      })
      cmdReply(ctx, event, session, `搜索 "${keyword}" 的记忆结果（${results.length} 条）：\n${lines.join('\n')}`, userMsg)
      return true
    }
    session.lastPrompt = userMsg
    return true
  }

  // ── Memory delete command ──
  const deleteMatch = userMsg.match(/^(删除记忆|delete memory)\s+(.+)$/i)
  if (deleteMatch) {
    const keyword = deleteMatch[2].trim()
    const results = recall(keyword, 10, senderId)
    if (results.length === 0) {
      cmdReply(ctx, event, session, `没有找到匹配「${keyword}」的记忆可删除。`, userMsg)
      return true
    } else {
      ensureMemoriesLoaded()
      let expired = 0
      for (const r of results) {
        // NOTE: matching by ts+content; Memory has no unique id field, so millisecond-collision
        // could theoretically mis-match. Risk is low (same ts AND same content is near-impossible).
        const idx = memoryState.memories.findIndex(m => m.ts === r.ts && m.content === r.content)
        if (idx >= 0) {
          memoryState.memories[idx].scope = 'expired'
          expired++
        }
      }
      if (expired > 0) saveMemories()
      cmdReply(ctx, event, session, `已标记 ${expired} 条匹配 "${keyword}" 的记忆为过期。`, userMsg)
      return true
    }
  }

  if (/^(导出记忆|export memories)$/i.test(userMsg.trim())) {
    ensureMemoriesLoaded()
    const exportDir = DATA_DIR + '/export'
    if (!existsSync(exportDir)) mkdirSync(exportDir, { recursive: true })
    const userMems = memoryState.memories
      .filter(m => !senderId || !m.userId || m.userId === senderId)
      .map(m => ({ content: m.content, scope: m.scope, ts: m.ts, tags: m.tags || [] }))
    const today = new Date().toISOString().slice(0, 10)
    const exportPath = `${exportDir}/memories_${today}.json`
    writeFileSync(exportPath, JSON.stringify(userMems, null, 2), 'utf-8')
    cmdReply(ctx, event, session, `已导出 ${userMems.length} 条记忆到 ${exportPath}`, userMsg)
    return true
  }

  if (/^(导出灵魂|export soul)$/i.test(userMsg.trim())) {
    const exportDir = DATA_DIR + '/export'
    if (!existsSync(exportDir)) mkdirSync(exportDir, { recursive: true })
    const soulPrompt = innerState.evolvedSoul || '（尚未生成进化灵魂）'
    let featuresData = {}
    try { featuresData = existsSync(DATA_DIR + '/features.json')
      ? JSON.parse(readFileSync(DATA_DIR + '/features.json', 'utf-8')) : {} } catch { /* corrupted features.json */ }
    const soulConfig = {
      soul_prompt: soulPrompt,
      features: featuresData,
      personas: PERSONAS.map(p => ({ id: p.id, name: p.name, tone: p.tone, traits: p.traits })),
      values: getAllValues(),
    }
    const today = new Date().toISOString().slice(0, 10)
    const exportPath = `${exportDir}/soul_config_${today}.json`
    writeFileSync(exportPath, JSON.stringify(soulConfig, null, 2), 'utf-8')
    cmdReply(ctx, event, session, `已导出灵魂配置到 ${exportPath}（包含 soul_prompt / features / personas / values）`, userMsg)
    return true
  }

  // ── P2-#16: Export lorebook (sanitized for sharing) ──
  if (/^(导出lorebook|export lorebook)$/i.test(userMsg.trim())) {
    const exportDir = DATA_DIR + '/export'
    if (!existsSync(exportDir)) mkdirSync(exportDir, { recursive: true })
    const lorebookPath = resolve(DATA_DIR, 'lorebook.json')
    let raw: any[] = []
    try { raw = existsSync(lorebookPath) ? JSON.parse(readFileSync(lorebookPath, 'utf-8')) : [] } catch { /* corrupted lorebook.json */ }
    const sanitized = raw
      .filter((e: any) => e.enabled !== false)
      .map((e: any) => ({
        keywords: e.keywords || [],
        content: (e.content || '').replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[REDACTED]')
          .replace(/\b(?:sk-|api[_-]?key|token|secret|password)[=:]\s*\S+/gi, '[REDACTED]'),
        category: e.category || 'fact',
        priority: e.priority || 5,
      }))
    const exportPath = `${exportDir}/lorebook_share.json`
    writeFileSync(exportPath, JSON.stringify({ knowledge: sanitized, version: 1, exportedAt: new Date().toISOString() }, null, 2), 'utf-8')
    cmdReply(ctx, event, session, `已导出 ${sanitized.length} 条 lorebook 到 ${exportPath}（已去敏，兼容 ClawHub knowledge 格式）`, userMsg)
    return true
  }

  // ── Import memories command ──
  const importMemMatch = userMsg.match(/^(导入记忆|import memories)\s+(.+)$/i)
  if (importMemMatch) {
    const filePath = importMemMatch[2].trim().replace(/^~/, homedir())
    try {
      if (!existsSync(filePath)) {
        cmdReply(ctx, event, session, `文件不存在: ${filePath}`, userMsg)
        return true
      }
      const raw = readFileSync(filePath, 'utf-8')
      const imported = JSON.parse(raw) as any
      let added = 0
      let total = 0
      let format = 'cc-soul'
      if (Array.isArray(imported) && imported.length > 0 && imported[0]?.memory) {
        format = 'mem0'
        total = imported.length
        for (const m of imported) {
          if (m.memory && m.memory.length > 3) { addMemory(m.memory, 'fact', senderId); added++ }
        }
      } else if (!Array.isArray(imported) && imported?.data?.description) {
        format = 'character-card-v2'
        total = 0
        if (imported.data.description) { addMemory(imported.data.description, 'persona_import', senderId); added++; total++ }
        if (imported.data.personality) { addMemory(imported.data.personality, 'persona_import', senderId); added++; total++ }
        if (imported.data.first_mes) { addMemory(`[首条消息] ${imported.data.first_mes}`, 'persona_import', senderId); added++; total++ }
      } else if (Array.isArray(imported) && imported.length > 0 && imported[0]?.type === 'memory') {
        format = 'chatgpt'
        total = imported.length
        for (const m of imported) {
          if (m.content && m.content.length > 3) { addMemory(m.content, 'fact', senderId); added++ }
        }
      } else if (Array.isArray(imported)) {
        total = imported.length
        for (const m of imported) {
          if (m.content && m.content.length > 3) { addMemory(m.content, m.scope || 'fact', senderId); added++ }
        }
      } else {
        throw new Error('unrecognized format')
      }
      saveMemories()
      console.log(`[cc-soul][import] imported ${added}/${total} memories from ${filePath} (format: ${format})`)
      cmdReply(ctx, event, session, `已导入 ${added} 条记忆（格式: ${format}，共 ${total} 条，跳过重复和无效）`, userMsg)
      return true
    } catch (e: any) {
      cmdReply(ctx, event, session, `导入失败: ${e.message}`, userMsg)
      return true
    }
  }

  // ── Import soul command ──
  const importSoulMatch = userMsg.match(/^(导入灵魂|import soul)\s+(.+)$/i)
  if (importSoulMatch) {
    const filePath = importSoulMatch[2].trim().replace(/^~/, homedir())
    try {
      if (!existsSync(filePath)) {
        cmdReply(ctx, event, session, `文件不存在: ${filePath}`, userMsg)
        return true
      }
      const raw = readFileSync(filePath, 'utf-8')
      const config = JSON.parse(raw) as { features?: Record<string, boolean>; values?: any }
      let changes: string[] = []
      if (config.features && typeof config.features === 'object') {
        const featuresPath = resolve(DATA_DIR, 'features.json')
        writeFileSync(featuresPath, JSON.stringify(config.features, null, 2), 'utf-8')
        changes.push(`features: ${Object.keys(config.features).length} toggles`)
      }
      if (config.values && typeof config.values === 'object') {
        const valuesPath = resolve(DATA_DIR, 'values.json')
        writeFileSync(valuesPath, JSON.stringify(config.values, null, 2), 'utf-8')
        changes.push('values imported')
      }
      cmdReply(ctx, event, session, changes.length > 0
        ? `灵魂配置已导入: ${changes.join(', ')}。重启 gateway 后完全生效。`
        : '配置文件中没有可导入的内容（需要 features 或 values 字段）', userMsg)
      console.log(`[cc-soul][import-soul] imported from ${filePath}: ${changes.join(', ')}`)
      return true
    } catch (e: any) {
      cmdReply(ctx, event, session, `导入失败: ${e.message}`, userMsg)
      return true
    }
  }

  // ── 群聊命令 ──
  const groupChatTopic = parseGroupChatCommand(userMsg)
  if (groupChatTopic) {
    cmdReply(ctx, event, session, `🗣 群聊讨论启动中：${groupChatTopic}\n参与者选择中，请稍候…`, userMsg)
    const evCtx = event?.context || {}
    const to = event?._replyTo || evCtx.conversationId || evCtx.chatId || ''
    triggerGroupChat(groupChatTopic, (result) => {
      // Use notifyOwnerDM because original request context may be destroyed by the time callback fires
      import('./notify.ts').then(({ notifyOwnerDM }) => notifyOwnerDM(result))
        .catch((e: any) => console.error(`[cc-soul][group-chat] reply failed: ${e.message}`))
    })
    return true
  }

  // ── Conversation summary command ──
  if (/^(对话摘要|conversation summary)$/i.test(userMsg.trim())) {
    // Read from JSON file (memoryState.chatHistory may not be loaded in lightweight init)
    let allHistory = memoryState.chatHistory
    if (allHistory.length === 0) {
      try {
        const histPath = resolve(DATA_DIR, 'history.json')
        allHistory = existsSync(histPath) ? JSON.parse(readFileSync(histPath, 'utf-8')) : []
      } catch (_) {}
    }
    const recent = allHistory.slice(-25)
    const sessions: { start: number; turns: typeof recent; summary: string }[] = []
    let cur: typeof recent = []
    for (const turn of recent) {
      if (cur.length > 0 && turn.ts - cur[cur.length - 1].ts > 1800000) {
        sessions.push({ start: cur[0].ts, turns: cur, summary: '' })
        cur = []
      }
      cur.push(turn)
    }
    if (cur.length > 0) sessions.push({ start: cur[0].ts, turns: cur, summary: '' })

    const lines = sessions.slice(-5).map((s, i) => {
      const date = new Date(s.start).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      const topics = s.turns.slice(0, 3).map(t => t.user.slice(0, 30)).join(' → ')
      return `${i + 1}. [${date}] ${s.turns.length} 轮 | ${topics}...`
    })
    const display = `最近对话摘要（${sessions.length} 个会话）：\n${lines.join('\n') || '暂无记录'}`
    cmdReply(ctx, event, session, display, userMsg)
    return true
  }

  // ── Memory health command ──
  if (/^(记忆健康|memory health)$/i.test(userMsg.trim())) {
    // Read from JSON file (memoryState.memories may not be loaded in lightweight init)
    let mems: any[] = []
    try {
      const memPath = resolve(DATA_DIR, 'memories.json')
      mems = existsSync(memPath) ? JSON.parse(readFileSync(memPath, 'utf-8')).filter((m: any) => m.scope !== 'expired' && m.scope !== 'decayed') : []
    } catch (_) {}
    const total = mems.length
    const scopeDist: Record<string, number> = {}
    const confidenceBuckets = { high: 0, medium: 0, low: 0, unset: 0 }
    let decayedCount = 0
    const now = Date.now()

    for (const m of mems) {
      scopeDist[m.scope] = (scopeDist[m.scope] || 0) + 1
      const conf = (m as any).confidence ?? -1
      if (conf >= 0.7) confidenceBuckets.high++
      else if (conf >= 0.4) confidenceBuckets.medium++
      else if (conf >= 0) confidenceBuckets.low++
      else confidenceBuckets.unset++
      if (now - m.ts > 30 * 86400000 && m.hits === 0) decayedCount++
    }

    const scopeLines = Object.entries(scopeDist)
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `  ${s}: ${n}`)
      .join('\n')

    const display = [
      `记忆健康报告`,
      `总数: ${total}`,
      ``,
      `Scope 分布:`,
      scopeLines,
      ``,
      `置信度分布:`,
      `  高 (>=0.7): ${confidenceBuckets.high}`,
      `  中 (0.4-0.7): ${confidenceBuckets.medium}`,
      `  低 (<0.4): ${confidenceBuckets.low}`,
      `  未设置: ${confidenceBuckets.unset}`,
      ``,
      `衰减概况:`,
      `  30天以上零命中: ${decayedCount} 条 (${total > 0 ? (decayedCount / total * 100).toFixed(1) : 0}%)`,
      `  活跃记忆: ${total - decayedCount} 条`,
    ].join('\n')

    cmdReply(ctx, event, session, display, userMsg)
    return true
  }

  // ── #8 习惯追踪命令（使用官方 habits + habit_logs 表）──
  const checkinMatch = userMsg.match(/^(打卡|checkin)\s+(.+)$/i)
  if (checkinMatch) {
    const habitName = checkinMatch[2].trim()
    const { streak, total, isNew } = dbCheckin(habitName, senderId)
    const milestones: Record<number, string> = {
      7: '🔥 连续7天达成！节律已建立，可以开始关注配速和距离。',
      30: '🏅 连续30天！习惯已固化，注意别因偶尔断签就放弃——整体趋势比单次记录重要。',
      100: '🏆 连续100天！这已经是生活方式的一部分了。',
    }
    const milestone = milestones[streak]
    appendAudit('checkin', `${habitName} 连续${streak}天 总计${total}次`)
    cmdReply(ctx, event, session, `打卡成功！"${habitName}" 连续 ${streak} 天，总计 ${total} 次${milestone ? `\n${milestone}` : ''}`, userMsg)
    return true
  }
  if (/^(习惯状态|habits)$/i.test(userMsg.trim())) {
    const habits = dbGetHabits(senderId)
    if (habits.length === 0) { cmdReply(ctx, event, session, '暂无打卡记录，用"打卡 <习惯名>"开始', userMsg); return true }
    const lines = habits.map(h => `• ${h.name}: 连续${h.streak}天 / 总${h.total}次`)
    cmdReply(ctx, event, session, `习惯追踪：\n${lines.join('\n')}`, userMsg)
    return true
  }

  // ── #9 目标里程碑追踪命令（使用官方 goals + key_results 表）──
  const newGoalMatch = userMsg.match(/^(新目标|new goal)\s+(.+)$/i)
  if (newGoalMatch) {
    const name = newGoalMatch[2].trim()
    dbAddGoal(name, senderId)
    cmdReply(ctx, event, session, `目标已创建："${name}"（进度 0%）`, userMsg)
    return true
  }
  const goalProgressMatch = userMsg.match(/^(目标进度|goal progress)\s+(.+?)\s+(.+)$/i)
  if (goalProgressMatch) {
    try {
      const goals = dbGetGoals(senderId)
      const keyword = goalProgressMatch[2].trim()
      const target = goals.find(g => g.name.includes(keyword))
      if (!target) { cmdReply(ctx, event, session, `未找到目标："${keyword}"`, userMsg) }
      else {
        const update = goalProgressMatch[3].trim()
        const numMatch = update.match(/(\d+)%?/)
        const newProgress = numMatch ? Math.min(100, parseInt(numMatch[1])) : target.progress
        dbUpdateGoalProgress(target.id, newProgress, update)
        cmdReply(ctx, event, session, `目标"${target.name}"已更新：进度 ${newProgress}%，里程碑 +1`, userMsg)
      }
    } catch (e: any) { cmdReply(ctx, event, session, `目标更新失败: ${e.message}`, userMsg) }
    session.lastPrompt = userMsg; return true
  }
  if (/^(我的目标|my goals)$/i.test(userMsg.trim())) {
    const goals = dbGetGoals(senderId)
    if (goals.length === 0) { cmdReply(ctx, event, session, '暂无目标，用"新目标 <描述>"创建', userMsg); return true }
    const lines = goals.map(g => {
      const age = Math.floor((Date.now() - g.created) / 86400000)
      return `• ${g.name} — ${g.progress}% — ${g.milestones}个里程碑（${age}天前创建）`
    })
    cmdReply(ctx, event, session, `我的目标：\n${lines.join('\n')}`, userMsg)
    return true
  }

  // ── #10 记忆审计命令 ──
  if (/^(记忆审计|memory audit)$/i.test(userMsg.trim())) {
    const auditPath = resolve(DATA_DIR, 'memory_audit.json')
    const audit = loadJson<any>(auditPath, null)
    if (!audit) { cmdReply(ctx, event, session, '暂无审计报告，等待下次心跳自动生成', userMsg); return true }
    const lines = [
      `记忆审计报告（${new Date(audit.ts).toLocaleString()}）`,
      `重复记忆: ${audit.duplicates?.length ?? 0} 组`,
      `极短记忆(<10字): ${audit.tooShort?.length ?? 0} 条`,
      `无标签活跃记忆: ${audit.untagged ?? 0} 条`,
      audit.suggestions ? `建议: ${audit.suggestions}` : '',
    ].filter(Boolean)
    cmdReply(ctx, event, session, `记忆审计结果：\n${lines.join('\n')}`, userMsg)
    return true
  }

  // ── Pin / Unpin 记忆命令 ──
  const pinMatch = userMsg.match(/^(pin|unpin)\s*(记忆|memory)\s+(.+)$/i)
  if (pinMatch) {
    const action = pinMatch[1].toLowerCase() as 'pin' | 'unpin'
    const keyword = pinMatch[3].trim()
    const results = recall(keyword, 10, senderId)
    if (results.length === 0) {
      cmdReply(ctx, event, session, `没有找到匹配 "${keyword}" 的记忆。`, userMsg)
      return true
    } else {
      ensureMemoriesLoaded()
      let changed = 0
      const newScope = action === 'pin' ? 'pinned' : 'mid_term'
      for (const r of results) {
        const mem = memoryState.memories.find(m => m.content === r.content && m.ts === r.ts)
        if (mem && mem.scope !== newScope) { mem.scope = newScope; changed++ }
      }
      if (changed > 0) saveMemories()
      cmdReply(ctx, event, session, action === 'pin'
        ? `已钉选 ${changed} 条匹配 "${keyword}" 的记忆（不会被衰减淘汰）`
        : `已取消钉选 ${changed} 条匹配 "${keyword}" 的记忆（恢复为 mid_term）`, userMsg)
      return true
    }
  }

  // ── 提醒命令 ──
  const remindMatch = userMsg.match(/^(?:提醒|remind)\s+(?:每天)?\s*(\d{1,2})[:\uff1a](\d{2})\s+(.+)$/i)
  if (remindMatch) {
    const hour = parseInt(remindMatch[1], 10)
    const minute = parseInt(remindMatch[2], 10)
    const msg = remindMatch[3].trim()
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      dbAddReminder(msg, hour, minute, senderId)
      cmdReply(ctx, event, session, `已添加提醒：每天 ${hour}:${String(minute).padStart(2, '0')} — ${msg}。提醒已持久化保存，重启不丢失。`, userMsg)
      return true
    } else {
      cmdReply(ctx, event, session, '时间格式不正确，请用 0-23:00-59 格式', userMsg)
    }
    session.lastPrompt = userMsg; return true
  }
  if (/^(我的提醒|my reminders)$/i.test(userMsg.trim())) {
    const mine = dbGetReminders(senderId)
    if (mine.length === 0) {
      cmdReply(ctx, event, session, '你还没有设置任何提醒。', userMsg)
      return true
    } else {
      const lines = mine.map((r, i) => `${i + 1}. 每天 ${r.hour}:${String(r.minute).padStart(2, '0')} — ${r.msg}`)
      cmdReply(ctx, event, session, `你的提醒（${mine.length} 条）：\n${lines.join('\n')}`, userMsg)
    }
    session.lastPrompt = userMsg; return true
  }
  // ── 删除提醒命令（使用官方 reminders 表）──
  const delRemindMatch = userMsg.match(/^(?:删除提醒|delete reminder)\s+(\d+)$/i)
  if (delRemindMatch) {
    const idx = parseInt(delRemindMatch[1], 10) - 1
    const mine = dbGetReminders(senderId)
    if (idx >= 0 && idx < mine.length) {
      const target = mine[idx]
      dbDeleteReminder(target.id)
      cmdReply(ctx, event, session, `已删除提醒：${target.hour}:${String(target.minute).padStart(2, '0')} — ${target.msg}`, userMsg)
      return true
    } else {
      cmdReply(ctx, event, session, `提醒序号 ${idx + 1} 不存在，请用"我的提醒"查看列表。`, userMsg)
    }
    session.lastPrompt = userMsg; return true
  }

  // ── 记忆时间线命令 ──
  const timelineMatch = userMsg.match(/^(记忆时间线|时间线|memory timeline)\s+(.+)$/i)
  if (timelineMatch) {
    const keyword = timelineMatch[2].trim()
    const results = queryMemoryTimeline(keyword)
    if (results.length === 0) {
      cmdReply(ctx, event, session, `没有找到关键词 "${keyword}" 的记忆时间线。`, userMsg)
      return true
    } else {
      const lines = results.map(r => {
        const from = new Date(r.from).toLocaleString()
        const until = r.until ? new Date(r.until).toLocaleString() : '至今'
        return `- [${from} ~ ${until}] ${r.content.slice(0, 80)}`
      })
      cmdReply(ctx, event, session, `记忆时间线 "${keyword}"（${results.length} 条）：\n${lines.join('\n')}`, userMsg)
    }
    session.lastPrompt = userMsg; return true
  }

  // Task confirmation check
  const chatId = (ctx.conversationId || event.sessionKey || '') as string
  if (checkTaskConfirmation(userMsg, chatId)) {
    cmdReply(ctx, event, session, '任务已派发给执行引擎，正在处理中...', userMsg)
    return true
  }

  // Fallback: try routeCommandDirect for commands only handled there (人格列表, 审计, 价值观 etc.)
  // Wrap in try-catch since routeCommandDirect is async
  if (isCommand(userMsg)) {
    const evCtx = event?.context || {}
    const to = evCtx.conversationId || evCtx.chatId || ''
    routeCommandDirect(userMsg, { to, cfg: _replyCfg, event }).then(handled => {
      if (handled) {
        markHandledByDirect(userMsg)
        console.log(`[cc-soul][routeCommand] fallback to routeCommandDirect: handled`)
      }
    }).catch(() => {})
    ctx.bodyForAgent = '[系统] 命令已处理，结果已发送。'
    return true
  }

  // Not a command
  return false
}

// ═══════════════════════════════════════════════════════════════════════════════
// Direct command handler — called from context-engine assemble() as fallback
// when preprocessed hook doesn't fire. Sends replies directly via Feishu API.
// ═══════════════════════════════════════════════════════════════════════════════

export async function routeCommandDirect(userMsg: string, params: any): Promise<boolean> {
  if (!userMsg) return false
  const _to = params?.to || (soulConfig?.owner_open_id ? `user:${soulConfig.owner_open_id}` : '')
  const _cfg = params?.cfg || _replyCfg
  const reply = (text: string) => replySender(_to, text, _cfg).catch(() => {})

  // Only handle read-only commands (no state mutations)
  // Write commands (delete, pin, goal create, etc.) are only handled by routeCommand

  if (/^(help|帮助|命令列表|commands)$/i.test(userMsg.trim())) {
    const helpText = `cc-soul 命令指南

━━ 自动运行（无需操作） ━━
• 记忆/人格/情绪/学习/举一反三 全自动

━━ 命令 ━━
帮助 — 显示此指南
搜索记忆 <关键词> — 搜索记忆
我的记忆 — 查看最近记忆
stats — 个人仪表盘
soul state — AI 能量/心情
晨报 — 每日晨报
周报 — 每周周报
情绪周报 — 7天情绪趋势
能力评分 — 各领域评分
习惯状态 — 打卡记录
我的目标 — 查看目标
我的提醒 — 查看提醒
功能状态 — 功能开关
记忆健康 — 记忆统计

━━ 触发词 ━━
"别记了" → 暂停记忆 | "可以了" → 恢复
"帮我理解" → 苏格拉底模式`
    reply(helpText)
    return true
  }

  // 搜索记忆
  const searchMatch = userMsg.match(/^(搜索记忆|search memory)\s+(.+)$/i)
  if (searchMatch) {
    const keyword = searchMatch[2].trim()
    let results = recall(keyword, 10)
    // Fallback to JSON file
    if (results.length === 0) {
      try {
        const memPath = resolve(DATA_DIR, 'memories.json')
        if (existsSync(memPath)) {
          const allMems = JSON.parse(readFileSync(memPath, 'utf-8'))
          const kw = keyword.toLowerCase()
          results = allMems.filter((m: any) =>
            m.scope !== 'expired' && m.scope !== 'decayed' &&
            (m.content.toLowerCase().includes(kw) || (m.tags && m.tags.some((t: string) => t.toLowerCase().includes(kw))))
          ).slice(0, 10)
        }
      } catch (_) {}
    }
    const text = results.length === 0
      ? `没有找到关于「${keyword}」的记忆。`
      : `搜索「${keyword}」结果（${results.length} 条）：\n${results.map((m: any, i: number) => `${i + 1}. [${m.scope}] ${m.content.slice(0, 80)}`).join('\n')}`
    reply(text)
    return true
  }

  // 我的记忆
  if (/^(我的记忆|my memories)$/i.test(userMsg.trim())) {
    try {
      const memPath = resolve(DATA_DIR, 'memories.json')
      const mems = existsSync(memPath) ? JSON.parse(readFileSync(memPath, 'utf-8')) : []
      const active = mems.filter((m: any) => m.scope !== 'expired' && m.scope !== 'decayed')
      const recent = active.sort((a: any, b: any) => (b.ts || 0) - (a.ts || 0)).slice(0, 10)
      const lines = recent.map((m: any, i: number) => `${i + 1}. [${m.scope}] ${m.content.slice(0, 60)}`)
      reply(lines.length > 0 ? `最近记忆（共 ${active.length} 条）：\n${lines.join('\n')}` : '还没有记忆。')
    } catch (_) {}
    return true
  }

  // stats
  if (/^(stats)$/i.test(userMsg.trim())) {
    try {
      const memPath = resolve(DATA_DIR, 'memories.json')
      const mems = existsSync(memPath) ? JSON.parse(readFileSync(memPath, 'utf-8')) : []
      const active = mems.filter((m: any) => m.scope !== 'expired' && m.scope !== 'decayed').length
      reply(`cc-soul 仪表盘\n记忆: ${active} 条\n模块: 41 个`)
    } catch (_) {}
    return true
  }

  // 习惯状态（使用官方DB）
  if (/^(习惯状态|habits)$/i.test(userMsg.trim())) {
    const habits = dbGetHabits()
    if (habits.length === 0) { reply('暂无打卡记录。'); return true }
    const lines = habits.map(h => `• ${h.name}: 连续${h.streak}天 / 总${h.total}次`)
    reply(`习惯追踪：\n${lines.join('\n')}`)
    return true
  }

  // 功能状态
  if (/^(功能状态|features|feature status)$/i.test(userMsg.trim())) {
    const result = handleFeatureCommand(userMsg)
    reply(typeof result === 'string' ? result : '功能开关已更新。')
    return true
  }

  // 功能开关 toggle
  if (/^(?:开启|启用|enable|关闭|禁用|disable)\s+\S+$/i.test(userMsg.trim())) {
    const result = handleFeatureCommand(userMsg)
    if (result) {
      reply(typeof result === 'string' ? result : '功能开关已更新。')
      return true
    }
  }

  // 灵魂状态
  if (/^(soul state|灵魂状态|内心状态)$/i.test(userMsg.trim())) {
    try {
      const { body } = await import('./body.ts')
      reply(`灵魂状态\nEnergy: ${(body.energy * 100).toFixed(0)}%\nMood: ${body.mood.toFixed(2)}\nEmotion: ${body.emotion}`)
    } catch (_) { reply('灵魂状态暂不可用') }
    return true
  }

  // 情绪周报
  if (/^(情绪周报|mood report)$/i.test(userMsg.trim())) {
    try {
      const report = generateMoodReport()
      reply(report || '暂无足够数据生成情绪周报。')
    } catch (_) { reply('情绪周报暂不可用') }
    return true
  }

  // 晨报
  if (/^(晨报|morning report)$/i.test(userMsg.trim())) {
    try {
      reply(generateMorningReport())
    } catch (_) { reply('晨报暂不可用') }
    return true
  }

  // 周报
  if (/^(周报|weekly report)$/i.test(userMsg.trim())) {
    try {
      reply(generateWeeklyReport())
    } catch (_) { reply('周报暂不可用') }
    return true
  }

  // 能力评分
  if (/^(能力评分|capability)$/i.test(userMsg.trim())) {
    try {
      const score = getCapabilityScore()
      reply(typeof score === 'string' ? score : JSON.stringify(score, null, 2))
    } catch (_) { reply('能力评分暂不可用') }
    return true
  }

  // 记忆健康（使用官方DB）
  if (/^(记忆健康|memory health)$/i.test(userMsg.trim())) {
    try {
      const { sqliteCount, getDb } = await import('./sqlite-store.ts')
      const db = getDb()
      const total = db ? (db.prepare('SELECT COUNT(*) as c FROM memories').get() as any)?.c || 0 : 0
      const active = db ? (db.prepare("SELECT COUNT(*) as c FROM memories WHERE scope != 'expired' AND scope != 'decayed'").get() as any)?.c || 0 : 0
      const scopes = db ? (db.prepare("SELECT scope, COUNT(*) as c FROM memories WHERE scope != 'expired' AND scope != 'decayed' GROUP BY scope ORDER BY c DESC").all() as any[]) : []
      const scopeLines = scopes.map((r: any) => `  ${r.scope}: ${r.c}`).join('\n')
      reply(`记忆健康\n总数: ${total}\n活跃: ${active}\nScope 分布:\n${scopeLines}`)
    } catch (_) { reply('记忆健康检查失败') }
    return true
  }

  // 我的目标（使用官方DB）
  if (/^(我的目标|my goals)$/i.test(userMsg.trim())) {
    const goals = dbGetGoals()
    if (goals.length === 0) { reply('暂无目标，用"新目标 <描述>"创建'); return true }
    const lines = goals.map((g, i) => {
      const age = Math.floor((Date.now() - g.created) / 86400000)
      return `${i + 1}. ${g.name} — ${g.progress}% — ${g.milestones}个里程碑（${age}天前创建）`
    })
    reply(`我的目标：\n${lines.join('\n')}`)
    return true
  }

  // 我的提醒（使用官方DB）
  if (/^(我的提醒|my reminders)$/i.test(userMsg.trim())) {
    const mine = dbGetReminders()
    if (mine.length === 0) { reply('暂无提醒。'); return true }
    const lines = mine.map((r, i) => `${i + 1}. ${r.hour}:${String(r.minute).padStart(2, '0')} — ${r.msg}`)
    reply(`我的提醒：\n${lines.join('\n')}`)
    return true
  }

  // 审计日志
  if (/^(审计|audit)/i.test(userMsg.trim())) {
    try {
      const log = formatAuditLog(20)
      reply(log || '暂无审计日志。')
    } catch (_) { reply('审计日志不可用') }
    return true
  }

  // 人格列表
  if (/^(人格列表|personas?)$/i.test(userMsg.trim())) {
    try {
      const { PERSONAS } = await import('./persona.ts')
      const lines = PERSONAS.map((p: any) => `• ${p.name} — ${p.tone?.slice(0, 40) || ''}`)
      reply(`人格列表：\n${lines.join('\n')}`)
    } catch (_) { reply('人格列表不可用') }
    return true
  }

  // 价值观
  if (/^(价值观|values)$/i.test(userMsg.trim())) {
    try {
      const vals = getAllValues()
      reply(typeof vals === 'string' ? vals : JSON.stringify(vals, null, 2).slice(0, 500))
    } catch (_) { reply('价值观模块不可用') }
    return true
  }

  // 成本
  if (/^(cost|成本|token cost|token使用)$/i.test(userMsg.trim())) {
    reply(getCostSummary())
    return true
  }

  // ── 群聊命令 ──
  const groupTopic = parseGroupChatCommand(userMsg)
  if (groupTopic) {
    reply(`🗣 群聊讨论启动中：${groupTopic}\n参与者选择中，请稍候…`)
    triggerGroupChat(groupTopic, (result) => {
      import('./notify.ts').then(({ notifyOwnerDM }) => notifyOwnerDM(result)).catch(() => {})
    })
    return true
  }

  // 隐私模式
  if (userMsg.includes('别记了') || userMsg.includes('隐私模式') || userMsg.includes('privacy mode')) {
    setPrivacyMode(true)
    console.log('[cc-soul] privacy mode ON (via routeCommandDirect)')
    reply('隐私模式已开启，对话内容不会被记忆。说"可以了"恢复。')
    return true
  }
  if (userMsg.includes('可以了') || userMsg.includes('关闭隐私') || userMsg.includes('恢复记忆')) {
    setPrivacyMode(false)
    console.log('[cc-soul] privacy mode OFF (via routeCommandDirect)')
    reply('隐私模式已关闭，恢复记忆。')
    return true
  }

  // Not handled by routeCommandDirect — let inbound_claim pass it through
  return false
}

// ═══════════════════════════════════════════════════════════════════════════════
// INBOUND CLAIM — OpenClaw SDK integration (command detection + routing)
// ═══════════════════════════════════════════════════════════════════════════════

/** Command patterns — matches both routeCommand and routeCommandDirect triggers */
const CMD_PATTERNS = [
  /^(help|帮助|命令列表|commands)$/i,
  /^(搜索记忆|search memory)\s+/i,
  /^(我的记忆|my memories)$/i,
  /^(stats)$/i,
  /^(习惯状态|habits)$/i,
  /^(soul state|灵魂状态|内心状态)$/i,
  /^(情绪周报|mood report)$/i,
  /^(晨报|morning report)$/i,
  /^(周报|weekly report)$/i,
  /^(能力评分|capability)$/i,
  /^(功能状态|features)$/i,
  /^(记忆健康|memory health)$/i,
  /^(我的目标|my goals)$/i,
  /^(我的提醒|my reminders)$/i,
  /^(功能|feature)\s+/i,
  /^(审计|audit)/i,
  /^(人格列表|personas?)$/i,
  /^(导出|export)/i,
  /^(导入|import)/i,
  /^(实验|experiment)/i,
  /^(tune|调整)/i,
  /^(ingest|导入文件)/i,
  /^(价值观|values)$/i,
  /^(cost|成本)$/i,
  /^(sync|同步)/i,
  /^(upgrade|更新)/i,
  /^(radar|竞品)/i,
  /^(dashboard|仪表盘|记忆地图)/i,
  /^(群聊|group\s*chat)\s+/i,
]
const PRIVACY_TRIGGERS = ['别记了', '隐私模式', 'privacy mode', '可以了', '关闭隐私', '恢复记忆']

/**
 * Check if a message is a cc-soul command (for inbound_claim filtering).
 */
export function isCommand(msg: string): boolean {
  const trimmed = (msg || '').trim()
  if (!trimmed) return false
  if (CMD_PATTERNS.some(p => p.test(trimmed))) return true
  if (PRIVACY_TRIGGERS.some(t => trimmed.includes(t))) return true
  return false
}

/**
 * Handle a command from inbound_claim hook.
 * Called when isCommand() returns true — routes to routeCommandDirect
 * with SDK config for replySender.
 */
export async function handleCommandInbound(
  msg: string,
  to: string,
  cfg: any,
  event: any,
): Promise<boolean> {
  // Thread SDK config so cmdReply / replySender can use it
  setReplyCfg(cfg)
  try {
    const handled = await routeCommandDirect(msg.trim(), { to, cfg, event })
    if (handled) markHandledByDirect(msg)
    return handled
  } catch (e: any) {
    console.error(`[cc-soul][handleCommandInbound] error: ${e.message}`)
    return false
  }
}
