/**
 * handler-commands.ts — 命令路由（40+ 命令）
 *
 * 从 handler.ts 提取所有命令处理逻辑。
 * 导出 routeCommand()：返回 true 表示命令已处理（handler.ts 应 return）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { exec } from 'child_process'
import { homedir } from 'os'
import { resolve } from 'path'

import type { SessionState } from './handler-state.ts'
import {
  stats, formatMetrics, shortcuts,
  getPrivacyMode, setPrivacyMode, saveStats,
  getCompressionRate,
  getSoulMode, setSoulMode,
} from './handler-state.ts'
import { loadJson, debouncedSave, DATA_DIR } from './persistence.ts'
import { isAuditCommand, formatAuditLog } from './audit.ts'
import { dbAddContextReminder, dbGetContextReminders, getDb } from './sqlite-store.ts'
import { handleFeatureCommand } from './features.ts'
import { getVectorStatus, installVectorSearch } from './embedder.ts'
import {
  memoryState, recall, addMemory, addMemoryWithEmotion, saveMemories,
  queryMemoryTimeline, ensureMemoriesLoaded, restoreArchivedMemories,
  trigrams, trigramSimilarity,
} from './memory.ts'
import { generateMoodReport, formatEmotionAnchors } from './body.ts'
import { generateMemoryChain } from './reports.ts'
import { getCapabilityScore } from './epistemic.ts'
import { handleDashboardCommand, generateMemoryMapHTML, generateDashboardHTML } from './user-dashboard.ts'
// ── Optional modules (absent in public build) ──
let _exportEvolutionAssets: ((stats: any) => { data: any; path: string }) | null = null
let _importEvolutionAssets: ((filePath: string) => { rulesAdded: number; hypothesesAdded: number }) | null = null
import('./evolution.ts').then(m => { _exportEvolutionAssets = m.exportEvolutionAssets; _importEvolutionAssets = m.importEvolutionAssets }).catch((e: any) => { console.error(`[cc-soul] module load failed (evolution): ${e.message}`) })
// ── End optional modules ──
import { startExperiment } from './experiment.ts'
import { handleTuneCommand } from './auto-tune.ts'
import { ingestFile } from './rag.ts'
import { innerState } from './inner-life.ts'
import { getAllValues } from './values.ts'
import { PERSONAS, getActivePersona } from './persona.ts'
import { checkTaskConfirmation } from './tasks.ts'
import { replySender } from './notify.ts'
import { executeSearch, executeMyMemories, executeStats, executeHealth, executeFeatures, executeTimeline } from './command-core.ts'
// ── Optional modules ──
let getCostSummary: () => string = () => '成本追踪模块未加载'
import('./cost-tracker.ts').then(m => { getCostSummary = m.getCostSummary }).catch((e: any) => { console.error(`[cc-soul] module load failed (cost-tracker): ${e.message}`) })

// ── Command dedup: prevent double replies from inbound_claim + hooks ──
let _lastDirectCmd = { content: '', ts: 0 }
export function wasHandledByDirect(msg: string): boolean {
  return _lastDirectCmd.content === msg.trim() && Date.now() - _lastDirectCmd.ts < 8000
}
function markHandledByDirect(msg: string) {
  _lastDirectCmd = { content: msg.trim(), ts: Date.now() }
}

// ── Full backup / restore helpers ──
function _sanitize(obj: any): any {
  const s = JSON.stringify(obj)
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[REDACTED]')
    .replace(/\b(?:sk-|api[_-]?key|token|secret|password)[=:]\s*\S+/gi, '[REDACTED]')
  return JSON.parse(s)
}
function _readJson(p: string): any { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null } catch { return null } }
function _fullBackup(): { path: string; counts: Record<string, number> } {
  const d = DATA_DIR + '/export'; if (!existsSync(d)) mkdirSync(d, { recursive: true })
  const files: Record<string, string> = {
    memories: 'memories.json', rules: 'rules.json', hypotheses: 'hypotheses.json',
    personModel: 'user_model.json', values: 'values.json', features: 'features.json',
    coreMemories: 'core_memories.json', userProfiles: 'user_profiles.json',
    theoryOfMind: 'theory_of_mind.json', body: 'body_state.json',
    emotionAnchors: 'emotion_anchors.json', graph: 'graph.json',
    lorebook: 'lorebook.json', patterns: 'success_patterns.json',
    journal: 'journal.json', workflows: 'workflows.json', plans: 'plans.json',
  }
  const bundle: Record<string, any> = { _meta: { version: 1, exportedAt: new Date().toISOString(), source: 'cc-soul' } }
  const counts: Record<string, number> = {}
  for (const [key, file] of Object.entries(files)) {
    const raw = _readJson(resolve(DATA_DIR, file))
    if (raw != null) { bundle[key] = raw; counts[key] = Array.isArray(raw) ? raw.length : Object.keys(raw).length }
  }
  // avatar profiles (per-user directory)
  const apDir = resolve(DATA_DIR, 'avatar_profiles')
  if (existsSync(apDir)) {
    const ap: Record<string, any> = {}
    for (const f of readdirSync(apDir).filter(f => f.endsWith('.json'))) {
      const d2 = _readJson(resolve(apDir, f)); if (d2) ap[f.replace('.json', '')] = d2
    }
    if (Object.keys(ap).length) { bundle.avatarProfiles = ap; counts.avatarProfiles = Object.keys(ap).length }
  }
  const sanitized = _sanitize(bundle)
  const ts = new Date().toISOString().slice(0, 10)
  const outPath = `${d}/full_backup_${ts}.json`
  writeFileSync(outPath, JSON.stringify(sanitized, null, 2), 'utf-8')
  return { path: outPath, counts }
}
function _fullRestore(filePath: string): Record<string, number> {
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
  if (!raw._meta?.source) throw new Error('不是有效的 cc-soul 全量备份文件')
  const fileMap: Record<string, string> = {
    memories: 'memories.json', rules: 'rules.json', hypotheses: 'hypotheses.json',
    personModel: 'user_model.json', values: 'values.json', features: 'features.json',
    coreMemories: 'core_memories.json', userProfiles: 'user_profiles.json',
    theoryOfMind: 'theory_of_mind.json', body: 'body_state.json',
    emotionAnchors: 'emotion_anchors.json', graph: 'graph.json',
    lorebook: 'lorebook.json', patterns: 'success_patterns.json',
    journal: 'journal.json', workflows: 'workflows.json', plans: 'plans.json',
  }
  const counts: Record<string, number> = {}
  for (const [key, file] of Object.entries(fileMap)) {
    if (raw[key] != null) {
      writeFileSync(resolve(DATA_DIR, file), JSON.stringify(raw[key], null, 2), 'utf-8')
      counts[key] = Array.isArray(raw[key]) ? raw[key].length : Object.keys(raw[key]).length
    }
  }
  if (raw.avatarProfiles) {
    const apDir = resolve(DATA_DIR, 'avatar_profiles')
    if (!existsSync(apDir)) mkdirSync(apDir, { recursive: true })
    for (const [uid, data] of Object.entries(raw.avatarProfiles)) {
      writeFileSync(resolve(apDir, `${uid}.json`), JSON.stringify(data, null, 2), 'utf-8')
    }
    counts.avatarProfiles = Object.keys(raw.avatarProfiles).length
  }
  return counts
}

// ── Command reply helper ──
// Uses OpenClaw SDK (replySender) to send command results directly.
// cfg is threaded through from inbound_claim hook or falls back to legacy path.
let _replyCfg: any = null   // set by handleCommandInbound / setReplyCfg
export function setReplyCfg(cfg: any) { _replyCfg = cfg }

function cmdReply(ctx: any, event: any, session: SessionState, text: string, userMsg: string) {
  session.lastPrompt = userMsg
  console.log(`[cc-soul][cmdReply] sending reply (${text.length} chars): ${text.slice(0, 50)}...`)
  // Store reply text in ctx so API callers can retrieve it
  if (typeof ctx.reply === 'function') ctx.reply(text)
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
• 恢复记忆 <关键词>               — 恢复归档记忆

━━ 导入导出 ━━
• 导出全部 / export all / full backup — 全量备份（已去敏）
• 导入全部 <路径> / import all <path> — 从全量备份恢复
• 导出lorebook                    — 导出知识库（去敏）
• 导出进化 / export evolution      — 导出 GEP 格式进化资产
• 导入进化 <路径>                  — 导入 GEP 格式进化资产
• 摄入文档 <路径> / ingest <path> — 导入文档到记忆

━━ 状态查看 ━━
• stats                           — 个人仪表盘
• soul state                      — AI 能量/心情/情绪
• 情绪周报 / mood report          — 7天情绪趋势
• 能力评分 / capability score     — 各领域能力评分
• 我的技能 / my skills            — 自动生成的技能列表
• metrics / 监控                  — 系统运行指标
• cost / 成本                     — Token 使用统计
• dashboard / 仪表盘              — 打开网页仪表盘
• 记忆图谱 html                   — 打开记忆可视化
• 对话摘要                        — 最近对话摘要

━━ 记忆洞察 ━━
• 时间旅行 <关键词>               — 追踪某个话题的观点演变
• 推理链 / reasoning chain        — 查看上次回复用了哪些记忆
• 情绪锚点 / emotion anchors      — 查看话题与情绪的关联
• 记忆链路 <关键词>               — 搜索相关记忆并展示关联链

━━ 体验功能 ━━
• 保存话题 / save topic           — 保存当前对话上下文为话题分支
• 切换话题 <名称> / switch topic  — 恢复保存的话题分支
• 话题列表 / topic list           — 查看所有话题分支
• 共享记忆 <关键词>               — 将匹配记忆设为全局共享
• 私有记忆 <关键词>               — 将匹配记忆设为私有

━━ 高级功能 ━━
• 功能状态 / features             — 查看所有功能开关
• 开启 <功能> / 关闭 <功能>       — 开关功能
• 审计日志 / audit log            — 查看操作审计链
• 开始实验 <描述>                 — 启动 A/B 实验

━━ 向量搜索（可选） ━━
• 安装向量                         — 一键安装语义搜索（自动下载模型+运行时）
• 向量状态                         — 查看安装状态
不安装也完全正常工作，只是用关键词匹配。`
    cmdReply(ctx, event, session, helpText, userMsg)
    return true
  }

  // ── Privacy mode toggle (Feature 2) ──
  if (/^(别记了|隐私模式|privacy mode)$/i.test(userMsg.trim())) {
    setPrivacyMode(true)
    console.log('[cc-soul] privacy mode ON')
    cmdReply(ctx, event, session, '隐私模式已开启，对话内容不会被记忆。说"可以了"恢复。', userMsg)
    return true
  }
  if (getPrivacyMode() && /^(可以了|关闭隐私|恢复记忆)$/i.test(userMsg.trim())) {
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

  // Manual experiment creation: "开始实验 <描述>"
  if (userMsg.includes('开始实验')) {
    const desc = userMsg.replace('开始实验', '').trim() || '手动实验'
    const expId = startExperiment(desc, desc, 3, 20)
    cmdReply(ctx, event, session, `已创建 A/B 实验 "${desc}" (id: ${expId})，20% 流量，3 天后自动结论。`, userMsg)
    return true
  }

  // ── 向量搜索安装/状态命令 ──
  if (/^(安装向量|install vector|向量状态|vector status)$/i.test(userMsg.trim())) {
    try {
      const status = getVectorStatus()
      if (/^(向量状态|vector status)$/i.test(userMsg.trim())) {
        const readyLabel = status.ready ? '✅ 已启用' : (status.installed ? '⏳ 已安装，下次对话自动启用' : '❌ 未启用')
        const lines = [
          '向量搜索状态',
          `  模型: ${status.hasModel ? '✅ 已安装' : '❌ 未安装'}`,
          `  运行时: ${status.hasRuntime ? '✅ 已安装' : '❌ 未安装'}`,
          `  就绪: ${readyLabel}`,
        ]
        if (!status.installed) {
          lines.push('')
          lines.push('━━ 自动安装 ━━')
          lines.push('发送"安装向量"即可一键安装（需网络，约 2 分钟）')
          lines.push('')
          lines.push('━━ 手动安装 ━━')
          lines.push('1. 下载模型到 ~/.openclaw/plugins/cc-soul/data/models/minilm/')
          lines.push('   curl -L -o model.onnx "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx"')
          lines.push('   curl -L -o vocab.json "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json"')
          lines.push('2. 安装运行时')
          lines.push('   cd ~/.openclaw/plugins/cc-soul && npm i onnxruntime-node')
          lines.push('3. 重启 gateway 自动生效')
          lines.push('')
          lines.push('不安装也完全正常工作，只是搜索用关键词匹配而非语义匹配。')
        }
        cmdReply(ctx, event, session, lines.join('\n'), userMsg)
        return true
      }
      if (status.installed && status.ready) {
        cmdReply(ctx, event, session, '✅ 向量搜索已安装并启用，无需重复操作。', userMsg)
        return true
      }
      cmdReply(ctx, event, session, '📦 开始安装向量搜索，请稍候（约 2 分钟）...', userMsg)
      const messages: string[] = []
      installVectorSearch((msg: string) => messages.push(msg)).then(() => {
        import('./notify.ts').then(({ notifyOwnerDM }: any) => notifyOwnerDM(messages.join('\n'))).catch((e: any) => { console.error(`[cc-soul] module load failed (notify): ${e.message}`) })
      })
    } catch (e: any) { cmdReply(ctx, event, session, `向量安装失败: ${e.message}`, userMsg) }
    return true
  }

  // Auto-tune commands
  if (handleTuneCommand(userMsg)) {
    cmdReply(ctx, event, session, '调参指令已执行。', userMsg)
    return true
  }

  // My skills command
  if (/^(我的技能|my skills)$/i.test(userMsg.trim())) {
    try {
      const skillsPath = resolve(DATA_DIR, 'skills.json')
      const skills = existsSync(skillsPath) ? JSON.parse(readFileSync(skillsPath, 'utf-8')) : []
      if (skills.length === 0) {
        cmdReply(ctx, event, session, '还没有发现技能。多聊几轮后会自动生成。', userMsg)
      } else {
        const list = skills.slice(0, 10).map((s: any, i: number) => `${i + 1}. ${s.name || s.pattern || s.content?.slice(0, 40) || '未命名'}`).join('\n')
        cmdReply(ctx, event, session, `你的技能（${skills.length} 个）：\n${list}`, userMsg)
      }
    } catch {
      cmdReply(ctx, event, session, '技能列表暂不可用。', userMsg)
    }
    return true
  }

  // ── Soul Mode (灵魂模式) — all subsequent messages become soul replies ──
  {
    // getSoulMode and setSoulMode imported from handler-state.ts at top
    // Toggle on: /灵魂模式 (auto-detect speaker) or /灵魂模式 老孟 (manual specify)
    const soulOnMatch = userMsg.match(/^[\/]?灵魂模式\s*(.*)$/i)
    if (soulOnMatch) {
      const speaker = soulOnMatch[1]?.trim() || ''  // empty = auto-detect
      setSoulMode(true, speaker)
      const msg = speaker
        ? `灵魂模式已开启（身份：${speaker}）。发 /退出灵魂 可关闭。`
        : `灵魂模式已开启，会自动识别对方身份。发 /退出灵魂 可关闭，发 /我是 <名字> 可指定身份。`
      cmdReply(ctx, event, session, msg, userMsg)
      return true
    }
    // Toggle off
    if (/^[\/]?(退出灵魂|关闭灵魂|灵魂模式关|soul.mode.off)$/i.test(userMsg.trim())) {
      setSoulMode(false)
      cmdReply(ctx, event, session, `灵魂模式已关闭，恢复正常对话。`, userMsg)
      return true
    }
    // Change speaker: /我是 沈婉宁
    const switchMatch = userMsg.match(/^[\/]?我是\s+(.+)$/i)
    if (switchMatch && getSoulMode().active) {
      const newSpeaker = switchMatch[1].trim()
      setSoulMode(true, newSpeaker)
      cmdReply(ctx, event, session, `好的，现在你是「${newSpeaker}」。`, userMsg)
      return true
    }
  }


  // ── Memory view / export commands ──
  if (/^(我的记忆|my memories)$/i.test(userMsg.trim())) {
    cmdReply(ctx, event, session, executeMyMemories(senderId), userMsg)
    return true
  }

  // ── Memory search command ──
  const searchMatch = userMsg.match(/^(搜索记忆|search memory)\s+(.+)$/i)
  if (searchMatch) {
    const keyword = searchMatch[2].trim()
    cmdReply(ctx, event, session, executeSearch(keyword, senderId), userMsg)
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

  // 导出记忆 — removed (memories are managed by OpenClaw's memory.db directly)


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

  // 导入记忆 — removed (autoImportHistory handles migration from OpenClaw history)


  // ── GEP: 导出进化 / export evolution ──
  if (/^(导出进化|export evolution)$/i.test(userMsg.trim())) {
    try {
      if (!_exportEvolutionAssets) { cmdReply(ctx, event, session, '进化模块未加载', userMsg); return true }
      const { data, path } = _exportEvolutionAssets({ totalMessages: stats.totalMessages, firstSeen: stats.firstSeen, corrections: stats.corrections })
      cmdReply(ctx, event, session,
        `进化资产已导出 (GEP v${data.version})\n` +
        `  规则: ${data.assets.rules.length}\n` +
        `  假设: ${data.assets.hypotheses.length}\n` +
        `  技能: ${data.assets.skills.length}\n` +
        `  已固化: ${data.assets.metadata.rulesSolidified}\n` +
        `路径: ${path}`, userMsg)
    } catch (e: any) { cmdReply(ctx, event, session, `导出进化失败: ${e.message}`, userMsg) }
    return true
  }

  // ── GEP: 导入进化 / import evolution ──
  const importEvoMatch = userMsg.match(/^(导入进化|import evolution)\s+(.+)$/i)
  if (importEvoMatch) {
    const filePath = importEvoMatch[2].trim().replace(/^~/, homedir())
    try {
      if (!existsSync(filePath)) {
        cmdReply(ctx, event, session, `文件不存在: ${filePath}`, userMsg)
        return true
      }
      // Security: only allow home dir or /tmp
      if (!filePath.startsWith(homedir()) && !filePath.startsWith('/tmp')) {
        cmdReply(ctx, event, session, '安全限制：只能导入家目录或 /tmp 下的文件。', userMsg)
        return true
      }
      if (!_importEvolutionAssets) { cmdReply(ctx, event, session, '进化模块未加载', userMsg); return true }
      const { rulesAdded, hypothesesAdded } = _importEvolutionAssets(filePath)
      cmdReply(ctx, event, session,
        `进化资产已导入 (GEP)\n` +
        `  新增规则: ${rulesAdded}\n` +
        `  新增假设: ${hypothesesAdded}`, userMsg)
    } catch (e: any) { cmdReply(ctx, event, session, `导入进化失败: ${e.message}`, userMsg) }
    return true
  }

  // ── Full backup: 导出全部 / export all / full backup ──
  if (/^(导出全部|export all|full backup)$/i.test(userMsg.trim())) {
    try {
      const { path, counts } = _fullBackup()
      const lines = Object.entries(counts).map(([k, v]) => `  ${k}: ${v}`)
      cmdReply(ctx, event, session, `全量备份已导出（已去敏）\n${lines.join('\n')}\n路径: ${path}`, userMsg)
    } catch (e: any) { cmdReply(ctx, event, session, `全量备份失败: ${e.message}`, userMsg) }
    return true
  }
  // ── Full restore: 导入全部 <path> / import all <path> ──
  const importAllMatch = userMsg.match(/^(导入全部|import all)\s+(.+)$/i)
  if (importAllMatch) {
    const fp = importAllMatch[2].trim().replace(/^~/, homedir())
    try {
      if (!existsSync(fp)) { cmdReply(ctx, event, session, `文件不存在: ${fp}`, userMsg); return true }
      if (!fp.startsWith(homedir()) && !fp.startsWith('/tmp')) { cmdReply(ctx, event, session, '安全限制：只能导入家目录或 /tmp 下的文件。', userMsg); return true }
      const counts = _fullRestore(fp)
      const lines = Object.entries(counts).map(([k, v]) => `  ${k}: ${v}`)
      cmdReply(ctx, event, session, `全量恢复完成（需重启生效）\n${lines.join('\n')}`, userMsg)
    } catch (e: any) { cmdReply(ctx, event, session, `全量恢复失败: ${e.message}`, userMsg) }
    return true
  }

  // ── Feature 14: 记忆链路可视化 ──
  const chainMatch = userMsg.match(/^(记忆链路|memory chain)\s+(.+)$/i)
  if (chainMatch) {
    try {
      const chain = generateMemoryChain(chainMatch[2].trim())
      cmdReply(ctx, event, session, chain, userMsg)
    } catch (e: any) { cmdReply(ctx, event, session, '记忆链路生成失败: ' + e.message, userMsg) }
    return true
  }

  // ── Feature 15: 对话分支 ──
  if (/^(保存话题|save topic)$/i.test(userMsg.trim())) {
    try {
      const branchDir = resolve(DATA_DIR, 'branches')
      if (!existsSync(branchDir)) mkdirSync(branchDir, { recursive: true })
      // Infer topic label from recent messages
      const recentMsgs = memoryState.chatHistory.slice(-10)
      const topicWords = recentMsgs.flatMap(h => (h.user || '').match(/[\u4e00-\u9fff]{2,4}|[A-Za-z]{3,}/g) || [])
      const freq = new Map<string, number>()
      for (const w of topicWords) { const k = w.toLowerCase(); freq.set(k, (freq.get(k) || 0) + 1) }
      const topicLabel = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || `topic_${Date.now()}`
      const branchData = {
        topic: topicLabel,
        savedAt: Date.now(),
        chatHistory: recentMsgs,
        persona: getActivePersona().id,
      }
      const branchPath = resolve(branchDir, `${topicLabel}.json`)
      writeFileSync(branchPath, JSON.stringify(branchData, null, 2), 'utf-8')
      cmdReply(ctx, event, session, `话题已保存：「${topicLabel}」（${recentMsgs.length} 轮对话）\n路径: ${branchPath}`, userMsg)
    } catch (e: any) { cmdReply(ctx, event, session, '保存话题失败: ' + e.message, userMsg) }
    return true
  }
  const switchTopicMatch = userMsg.match(/^(切换话题|switch topic)\s+(.+)$/i)
  if (switchTopicMatch) {
    try {
      const topicName = switchTopicMatch[2].trim()
      const branchDir = resolve(DATA_DIR, 'branches')
      const branchPath = resolve(branchDir, `${topicName}.json`)
      if (!branchPath.startsWith(branchDir)) {
        cmdReply(ctx, event, session, '无效的话题名称。', userMsg)
        return true
      }
      // Save current conversation before switching
      if (memoryState.chatHistory.length > 0) {
        if (!existsSync(branchDir)) mkdirSync(branchDir, { recursive: true })
        const currentTopic = `_autosave_${Date.now()}`
        const currentBranch = { topic: currentTopic, savedAt: Date.now(), chatHistory: memoryState.chatHistory.slice(-50) }
        writeFileSync(resolve(branchDir, `${currentTopic}.json`), JSON.stringify(currentBranch, null, 2), 'utf-8')
      }
      if (!existsSync(branchPath)) {
        cmdReply(ctx, event, session, `话题「${topicName}」不存在，用"话题列表"查看可用话题。`, userMsg)
        return true
      }
      const branchData = JSON.parse(readFileSync(branchPath, 'utf-8'))
      // Restore chat history
      if (branchData.chatHistory && Array.isArray(branchData.chatHistory)) {
        memoryState.chatHistory.length = 0
        memoryState.chatHistory.push(...branchData.chatHistory)
      }
      const persona = branchData.persona || 'unknown'
      cmdReply(ctx, event, session, `已切换到话题「${topicName}」（恢复 ${branchData.chatHistory?.length || 0} 轮对话，人格: ${persona}）`, userMsg)
    } catch (e: any) { cmdReply(ctx, event, session, '切换话题失败: ' + e.message, userMsg) }
    return true
  }
  if (/^(话题列表|topic list)$/i.test(userMsg.trim())) {
    try {
      const branchDir = resolve(DATA_DIR, 'branches')
      if (!existsSync(branchDir)) { cmdReply(ctx, event, session, '暂无保存的话题。', userMsg); return true }
      const files = (readdirSync(branchDir) as string[]).filter((f: string) => f.endsWith('.json'))
      if (files.length === 0) { cmdReply(ctx, event, session, '暂无保存的话题。', userMsg); return true }
      const lines: string[] = [`话题列表（${files.length} 个）：`]
      for (const f of files) {
        try {
          const data = JSON.parse(readFileSync(resolve(branchDir, f), 'utf-8'))
          const age = Math.floor((Date.now() - (data.savedAt || 0)) / 86400000)
          const ageStr = age === 0 ? '今天' : `${age}天前`
          lines.push(`• ${data.topic || f.replace('.json', '')} — ${data.chatHistory?.length || 0} 轮对话（${ageStr}）`)
        } catch {
          lines.push(`• ${f.replace('.json', '')} — 数据损坏`)
        }
      }
      cmdReply(ctx, event, session, lines.join('\n'), userMsg)
    } catch (e: any) { cmdReply(ctx, event, session, '话题列表读取失败: ' + e.message, userMsg) }
    return true
  }

  // ── Feature 16: 团队记忆（共享/私有） ──
  const shareMemMatch = userMsg.match(/^(共享记忆|share memory)\s+(.+)$/i)
  if (shareMemMatch) {
    try {
      const keyword = shareMemMatch[2].trim()
      const _db = getDb()
      if (!_db) { cmdReply(ctx, event, session, '数据库未就绪。', userMsg); return true }
      const kw = `%${keyword.toLowerCase()}%`
      const stmt = _db.prepare("UPDATE memories SET visibility = 'global' WHERE scope != 'expired' AND scope != 'decayed' AND (LOWER(content) LIKE ? OR LOWER(tags) LIKE ?)")
      const result = stmt.run(kw, kw)
      const changed = result.changes || 0
      cmdReply(ctx, event, session, changed > 0
        ? `已将 ${changed} 条匹配「${keyword}」的记忆设为全局共享。`
        : `没有找到匹配「${keyword}」的记忆。`, userMsg)
    } catch (e: any) { cmdReply(ctx, event, session, '共享记忆失败: ' + e.message, userMsg) }
    return true
  }
  const privateMemMatch = userMsg.match(/^(私有记忆|private memory)\s+(.+)$/i)
  if (privateMemMatch) {
    try {
      const keyword = privateMemMatch[2].trim()
      const _db = getDb()
      if (!_db) { cmdReply(ctx, event, session, '数据库未就绪。', userMsg); return true }
      const kw = `%${keyword.toLowerCase()}%`
      const stmt = _db.prepare("UPDATE memories SET visibility = 'private' WHERE scope != 'expired' AND scope != 'decayed' AND (LOWER(content) LIKE ? OR LOWER(tags) LIKE ?)")
      const result = stmt.run(kw, kw)
      const changed = result.changes || 0
      cmdReply(ctx, event, session, changed > 0
        ? `已将 ${changed} 条匹配「${keyword}」的记忆设为私有。`
        : `没有找到匹配「${keyword}」的记忆。`, userMsg)
    } catch (e: any) { cmdReply(ctx, event, session, '私有记忆失败: ' + e.message, userMsg) }
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
    cmdReply(ctx, event, session, executeHealth(), userMsg)
    return true
  }

  // ── #11 上下文提醒命令 ──
  {
    const ctxMatch1 = userMsg.match(/^当聊到\s*(.+?)\s*时?提醒我\s+(.+)$/)
    const ctxMatch2 = userMsg.match(/^remind\s+me\s+(.+?)\s+when\s+(?:we\s+)?talk(?:ing)?\s+about\s+(.+)$/i)
    const ctxMatch3 = userMsg.match(/^when\s+(?:we\s+)?talk(?:ing)?\s+about\s+(.+?)\s+remind\s+me\s+(.+)$/i)
    if (ctxMatch1) {
      const keyword = ctxMatch1[1].trim()
      const reminderContent = ctxMatch1[2].trim()
      if (keyword.length >= 2 && reminderContent.length >= 2) {
        const id = dbAddContextReminder(keyword, reminderContent, senderId)
        cmdReply(ctx, event, session, `已添加上下文提醒：当聊到「${keyword}」时提醒你「${reminderContent}」(id=${id})`, userMsg)
        return true
      }
    } else if (ctxMatch2) {
      const reminderContent = ctxMatch2[1].trim()
      const keyword = ctxMatch2[2].trim()
      if (keyword.length >= 2 && reminderContent.length >= 2) {
        const id = dbAddContextReminder(keyword, reminderContent, senderId)
        cmdReply(ctx, event, session, `已添加上下文提醒：当聊到「${keyword}」时提醒你「${reminderContent}」(id=${id})`, userMsg)
        return true
      }
    } else if (ctxMatch3) {
      const keyword = ctxMatch3[1].trim()
      const reminderContent = ctxMatch3[2].trim()
      if (keyword.length >= 2 && reminderContent.length >= 2) {
        const id = dbAddContextReminder(keyword, reminderContent, senderId)
        cmdReply(ctx, event, session, `已添加上下文提醒：当聊到「${keyword}」时提醒你「${reminderContent}」(id=${id})`, userMsg)
        return true
      }
    }
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

  // ── 恢复记忆命令（DAG Archive） ──
  const restoreMatch = userMsg.match(/^(?:恢复记忆|restore memory)\s+(.+)$/i)
  if (restoreMatch) {
    try {
      const keyword = restoreMatch[1].trim()
      const count = restoreArchivedMemories(keyword)
      if (count > 0) {
        cmdReply(ctx, event, session, `已恢复 ${count} 条匹配 "${keyword}" 的归档记忆。`, userMsg)
      } else {
        cmdReply(ctx, event, session, `没有找到匹配 "${keyword}" 的归档记忆。`, userMsg)
      }
    } catch (e: any) { cmdReply(ctx, event, session, `恢复失败: ${e.message}`, userMsg) }
    return true
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

  // ── 功能: 时间旅行 — 观点演变追踪 ──
  const timeTravelMatch = userMsg.match(/^(?:时间旅行|time travel)\s+(.+)$/i)
  if (timeTravelMatch) {
    const keyword = timeTravelMatch[1].trim()
    try {
      const _db = getDb()
      if (_db) {
        const kw = `%${keyword.toLowerCase()}%`
        const rows = _db.prepare(
          "SELECT content, scope, ts FROM memories WHERE LOWER(content) LIKE ? AND scope != 'expired' AND scope != 'decayed' ORDER BY ts ASC LIMIT 30"
        ).all(kw) as any[]
        if (rows.length === 0) {
          cmdReply(ctx, event, session, `没有找到关于「${keyword}」的记忆演变。`, userMsg)
        } else {
          const lines = rows.map((r: any) => {
            const date = new Date(r.ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
            return `  [${date}] ${r.content.slice(0, 80)}`
          })
          // Derive trend
          let trend = '→ 持续关注中'
          if (rows.length >= 3) {
            const first = rows[0].content.toLowerCase()
            const last = rows[rows.length - 1].content.toLowerCase()
            if (first.includes('学') && last.includes('理解')) trend = '→ 从入门到深入，持续推进中'
            else if (last.includes('完成') || last.includes('done')) trend = '→ 已完成'
            else if (last.includes('放弃') || last.includes('算了')) trend = '→ 已放弃'
          }
          const display = `🕰 「${keyword}」观点演变（${rows.length} 条）\n${lines.join('\n')}\n\n${trend}`
          cmdReply(ctx, event, session, display, userMsg)
        }
      } else {
        cmdReply(ctx, event, session, '数据库未就绪，无法查询。', userMsg)
      }
    } catch (e: any) { cmdReply(ctx, event, session, `时间旅行查询失败: ${e.message}`, userMsg) }
    return true
  }

  // ── 功能: 推理链 — 显示最近一次回复用了哪些记忆 + 因果追溯 + 反事实 ──
  if (/^(推理链|reasoning chain)$/i.test(userMsg.trim())) {
    const recalled = session.lastRecalledContents
    if (recalled.length === 0) {
      cmdReply(ctx, event, session, '上一次回复没有召回任何记忆。', userMsg)
    } else {
      const lines = recalled.map((c, i) => `  ${i + 1}. ${c.slice(0, 100)}`)
      // ── 因果追溯: find correction/event memories among recalled, trace causes ──
      const causalLines: string[] = []
      const DAY_MS = 24 * 3600000
      const allMems = memoryState.memories
      const recalledMems = recalled.map(c => allMems.find(m => m.content === c)).filter(Boolean) as typeof allMems
      const correctionMems = recalledMems.filter(m => m.scope === 'correction' || m.scope === 'event')
      for (const mem of correctionMems.slice(0, 3)) {
        const memTrigrams = trigrams(mem.content)
        // Find memories within ±24h that share topic (potential causes)
        const nearby = allMems.filter(m =>
          m !== mem && Math.abs(m.ts - mem.ts) < DAY_MS &&
          trigramSimilarity(trigrams(m.content), memTrigrams) > 0.15
        ).sort((a, b) => a.ts - b.ts)
        if (nearby.length > 0) {
          const rootCause = nearby[0]
          const fmtD = (ts: number) => new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
          causalLines.push(`  结果: ${mem.content.slice(0, 60)} (${fmtD(mem.ts)})`)
          causalLines.push(`    ← 原因: ${nearby[nearby.length > 1 ? 1 : 0].content.slice(0, 60)} (${fmtD(nearby[0].ts)})`)
          causalLines.push(`    ← 根因: ${rootCause.content.slice(0, 60)}`)
          // Counterfactual: invert the root cause
          const rootSnippet = rootCause.content.slice(0, 40).replace(/[。.!！？?]$/, '')
          causalLines.push(`  💭 反事实: 如果当时没有「${rootSnippet}」，这个问题可能不会发生`)
          causalLines.push('')
        }
      }
      let display = `🧠 上次回复的推理链（召回 ${recalled.length} 条记忆）：\n${lines.join('\n')}`
      if (causalLines.length > 0) {
        display += `\n\n🔗 因果追溯：\n${causalLines.join('\n')}`
      }
      cmdReply(ctx, event, session, display, userMsg)
    }
    return true
  }

  // ── 功能: 情绪锚点 — 显示话题与情绪的关联 ──
  if (/^(情绪锚点|emotion anchors?)$/i.test(userMsg.trim())) {
    cmdReply(ctx, event, session, formatEmotionAnchors(), userMsg)
    return true
  }

  // ── "别记这个" — skip next memory ──
  if (/^(别记了?这[个条]?|别记住|don't remember|forget this|不要记)/i.test(userMsg.trim())) {
    // Set a flag so the NEXT addMemory call skips
    session._skipNextMemory = true
    cmdReply(ctx, event, session, '🔇 收到，这条对话不会被记忆。', userMsg)
    return true
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
    }).catch(() => {}) // intentionally silent — async command fallback
    ctx.bodyForAgent = '[系统] 命令已处理，结果已发送。'
    return true
  }

  // Not a command
  return false
}

// ═══════════════════════════════════════════════════════════════════════════════
// Direct command handler — called from context-engine assemble() as fallback.
// Sends replies via replySender (log + optional webhook).
// ═══════════════════════════════════════════════════════════════════════════════

export async function routeCommandDirect(userMsg: string, params: any): Promise<boolean> {
  if (!userMsg) return false
  const _to = params?.to || ''
  const _cfg = params?.cfg || _replyCfg
  const _replyCallback = params?.replyCallback
  const reply = (text: string) => {
    if (typeof _replyCallback === 'function') _replyCallback(text)
    return replySender(_to, text, _cfg).catch(() => {}) // intentionally silent — reply delivery
  }

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
情绪周报 — 7天情绪趋势
能力评分 — 各领域评分
功能状态 — 功能开关
记忆健康 — 记忆统计
导出全部 / export all — 全量备份
导入全部 <路径> / import all — 全量恢复
导出进化 — 导出 GEP 格式进化资产
导入进化 <路径> — 导入 GEP 格式

━━ 触发词 ━━
"别记了" → 暂停记忆 | "可以了" → 恢复
"帮我理解" → 苏格拉底模式`
    reply(helpText)
    return true
  }

  // 搜索记忆
  const searchMatch = userMsg.match(/^(搜索记忆|search memory)\s+(.+)$/i)
  if (searchMatch) {
    reply(executeSearch(searchMatch[2].trim()))
    return true
  }

  // 我的记忆
  if (/^(我的记忆|my memories)$/i.test(userMsg.trim())) {
    reply(executeMyMemories())
    return true
  }

  // stats
  if (/^(stats)$/i.test(userMsg.trim())) {
    reply(executeStats())
    return true
  }

  // 功能状态
  if (/^(功能状态|features|feature status)$/i.test(userMsg.trim())) {
    reply(executeFeatures())
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
    reply(executeHealth())
    return true
  }

  // 导出进化 (GEP)
  if (/^(导出进化|export evolution)$/i.test(userMsg.trim())) {
    try {
      const { exportEvolutionAssets } = await import('./evolution.ts')
      const { data, path } = exportEvolutionAssets({ totalMessages: stats.totalMessages, firstSeen: stats.firstSeen, corrections: stats.corrections })
      reply(
        `进化资产已导出 (GEP v${data.version})\n` +
        `  规则: ${data.assets.rules.length}\n` +
        `  假设: ${data.assets.hypotheses.length}\n` +
        `  已固化: ${data.assets.metadata.rulesSolidified}\n` +
        `路径: ${path}`)
    } catch (e: any) { reply(`导出进化失败: ${e.message}`) }
    return true
  }

  // 导入进化 (GEP)
  const importEvoMatchDirect = userMsg.match(/^(导入进化|import evolution)\s+(.+)$/i)
  if (importEvoMatchDirect) {
    const filePath = importEvoMatchDirect[2].trim().replace(/^~/, homedir())
    try {
      if (!existsSync(filePath)) { reply(`文件不存在: ${filePath}`); return true }
      const { importEvolutionAssets } = await import('./evolution.ts')
      const { rulesAdded, hypothesesAdded } = importEvolutionAssets(filePath)
      reply(`进化资产已导入 (GEP)\n  新增规则: ${rulesAdded}\n  新增假设: ${hypothesesAdded}`)
    } catch (e: any) { reply(`导入进化失败: ${e.message}`) }
    return true
  }

  // 导出全部 / export all / full backup (direct)
  if (/^(导出全部|export all|full backup)$/i.test(userMsg.trim())) {
    try {
      const { path, counts } = _fullBackup()
      const lines = Object.entries(counts).map(([k, v]) => `  ${k}: ${v}`)
      reply(`全量备份已导出（已去敏）\n${lines.join('\n')}\n路径: ${path}`)
    } catch (e: any) { reply(`全量备份失败: ${e.message}`) }
    return true
  }
  // 导入全部 <path> / import all <path> (direct)
  const importAllMatchD = userMsg.match(/^(导入全部|import all)\s+(.+)$/i)
  if (importAllMatchD) {
    const fp = importAllMatchD[2].trim().replace(/^~/, homedir())
    try {
      if (!existsSync(fp)) { reply(`文件不存在: ${fp}`); return true }
      if (!fp.startsWith(homedir()) && !fp.startsWith('/tmp')) { reply('安全限制：只能导入家目录或 /tmp 下的文件。'); return true }
      const counts = _fullRestore(fp)
      const lines = Object.entries(counts).map(([k, v]) => `  ${k}: ${v}`)
      reply(`全量恢复完成（需重启生效）\n${lines.join('\n')}`)
    } catch (e: any) { reply(`全量恢复失败: ${e.message}`) }
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

  // ── Feature 14: 记忆链路 (direct) ──
  const chainMatchDirect = userMsg.match(/^(记忆链路|memory chain)\s+(.+)$/i)
  if (chainMatchDirect) {
    try { reply(generateMemoryChain(chainMatchDirect[2].trim())) } catch (_) { reply('记忆链路暂不可用') }
    return true
  }

  // ── Feature 15: 话题列表 (direct, read-only) ──
  if (/^(话题列表|topic list)$/i.test(userMsg.trim())) {
    try {
      const branchDir = resolve(DATA_DIR, 'branches')
      if (!existsSync(branchDir)) { reply('暂无保存的话题。'); return true }
      const files = (readdirSync(branchDir) as string[]).filter((f: string) => f.endsWith('.json'))
      if (files.length === 0) { reply('暂无保存的话题。'); return true }
      const lines: string[] = [`话题列表（${files.length} 个）：`]
      for (const f of files) {
        try {
          const data = JSON.parse(readFileSync(resolve(branchDir, f), 'utf-8'))
          const age = Math.floor((Date.now() - (data.savedAt || 0)) / 86400000)
          const ageStr = age === 0 ? '今天' : `${age}天前`
          lines.push(`• ${data.topic || f.replace('.json', '')} — ${data.chatHistory?.length || 0} 轮对话（${ageStr}）`)
        } catch { lines.push(`• ${f.replace('.json', '')} — 数据损坏`) }
      }
      reply(lines.join('\n'))
    } catch (_) { reply('话题列表暂不可用') }
    return true
  }

  // 隐私模式
  if (/^(别记了|隐私模式|privacy mode)$/i.test(userMsg.trim())) {
    setPrivacyMode(true)
    console.log('[cc-soul] privacy mode ON (via routeCommandDirect)')
    reply('隐私模式已开启，对话内容不会被记忆。说"可以了"恢复。')
    return true
  }
  if (getPrivacyMode() && /^(可以了|关闭隐私|恢复记忆)$/i.test(userMsg.trim())) {
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
  /^(soul state|灵魂状态|内心状态)$/i,
  /^(情绪周报|mood report)$/i,
  /^(能力评分|capability)$/i,
  /^(功能状态|features)$/i,
  /^(记忆健康|memory health)$/i,
  /^(功能|feature)\s+/i,
  /^(审计|audit)/i,
  /^(人格列表|personas?)$/i,
  /^(导出|export)/i,
  /^(导入|import)/i,
  /^full backup$/i,
  /^(实验|experiment)/i,
  /^(tune|调整)/i,
  /^(ingest|导入文件)/i,
  /^(价值观|values)$/i,
  /^(cost|成本)$/i,
  /^(sync|同步)/i,
  /^(upgrade|更新)/i,
  /^(radar|竞品)/i,
  /^(dashboard|仪表盘|记忆地图|stats|soul state|灵魂状态|情绪周报|能力评分|metrics|cost)/i,
  /^(我的技能|my skills)$/i,
  /^(时间旅行|time travel)\s+/i,
  /^(推理链|reasoning chain)$/i,
  /^(情绪锚点|emotion anchors?)$/i,
  /^(记忆链路|memory chain)\s+/i,
  /^(保存话题|save topic)$/i,
  /^(切换话题|switch topic)\s+/i,
  /^(话题列表|topic list)$/i,
  /^(共享记忆|share memory)\s+/i,
  /^(私有记忆|private memory)\s+/i,
  /^(别记了?这[个条]?|别记住|don't remember|forget this|不要记)$/i,
]
const PRIVACY_TRIGGERS_RE = /^(别记了|隐私模式|privacy mode|可以了|关闭隐私|恢复记忆)$/i

/**
 * Check if a message is a cc-soul command (for inbound_claim filtering).
 */
export function isCommand(msg: string): boolean {
  const trimmed = (msg || '').trim()
  if (!trimmed) return false
  if (CMD_PATTERNS.some(p => p.test(trimmed))) return true
  if (PRIVACY_TRIGGERS_RE.test(trimmed)) return true
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
