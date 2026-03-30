/**
 * sdk-example.ts — cc-soul SDK 使用示例
 *
 * 展示如何用三行代码接入 cc-soul，为你的 AI 注入记忆、情感和人格。
 * 本文件不会被执行，仅作参考。
 */

// import { CCSoul, CCSoulError } from 'cc-soul/sdk'
//
// // ═══════════════════════════════════════════════════════════════════════════════
// // 1. 初始化
// // ═══════════════════════════════════════════════════════════════════════════════
//
// const soul = new CCSoul('http://localhost:18800')
//
// // ═══════════════════════════════════════════════════════════════════════════════
// // 2. 健康检查 — 确认 soul engine 在线
// // ═══════════════════════════════════════════════════════════════════════════════
//
// const status = await soul.health()
// console.log(status)
// // → { status: 'ok', port: 18800, version: '2.5.0' }
//
// // ═══════════════════════════════════════════════════════════════════════════════
// // 3. 处理消息 — 核心用法
// // ═══════════════════════════════════════════════════════════════════════════════
//
// const ctx = await soul.process('最近在看什么书？', 'user_abc')
//
// // ctx.systemPrompt  → 完整的 system prompt，注入到你的 LLM
// // ctx.augments      → 增强上下文（记忆、规则、情绪等合并后的文本）
// // ctx.augmentsArray → 结构化增强数组 [{ content, priority, tokens }]
// // ctx.memories      → 相关记忆 [{ content, scope, emotion }]
// // ctx.mood          → 当前情绪 (-1 到 1)
// // ctx.energy        → 当前精力 (0 到 1)
// // ctx.emotion       → 情绪标签: 'positive' | 'negative' | 'neutral'
// // ctx.cognition     → 认知分析 { attention, intent, strategy, complexity }
//
// // 用法：把 systemPrompt + augments 注入到你的 LLM 调用
// // const response = await openai.chat.completions.create({
// //   model: 'gpt-4o',
// //   messages: [
// //     { role: 'system', content: ctx.systemPrompt + '\n\n' + ctx.augments },
// //     { role: 'user', content: '最近在看什么书？' },
// //   ],
// // })
//
// // ═══════════════════════════════════════════════════════════════════════════════
// // 4. 反馈学习 — 让 soul 从对话中学习
// // ═══════════════════════════════════════════════════════════════════════════════
//
// await soul.feedback(
//   '最近在看什么书？',           // 用户消息
//   '我最近在读《百年孤独》...',   // AI 回复
//   'user_abc',                   // 用户 ID
//   'positive',                   // 可选：'positive' | 'negative'
// )
// // → { learned: true }
//
// // ═══════════════════════════════════════════════════════════════════════════════
// // 5. 用户画像
// // ═══════════════════════════════════════════════════════════════════════════════
//
// const profile = await soul.profile('user_abc')
// console.log(profile.identity)      // 用户身份标签
// console.log(profile.thinkingStyle) // 思维模式
// console.log(profile.values)        // 价值观
// console.log(profile.mood)          // 当前心情
// console.log(profile.social)        // 社交关系图
//
// // ═══════════════════════════════════════════════════════════════════════════════
// // 6. 查询事实
// // ═══════════════════════════════════════════════════════════════════════════════
//
// const facts = await soul.facts('编程语言')
// console.log(facts.reply) // 返回与"编程语言"相关的结构化事实
//
// // ═══════════════════════════════════════════════════════════════════════════════
// // 7. 时间范围记忆查询
// // ═══════════════════════════════════════════════════════════════════════════════
//
// const memories = await soul.recallByTime(
//   { from: Date.now() - 7 * 86400000 }, // 最近 7 天
//   { scope: 'fact', limit: 10 },
// )
// console.log(memories.reply)
//
// // ═══════════════════════════════════════════════════════════════════════════════
// // 8. 功能列表
// // ═══════════════════════════════════════════════════════════════════════════════
//
// const features = await soul.features()
// console.log(features)
// // → { memory: true, emotion: true, cognition: true, ... }
//
// // ═══════════════════════════════════════════════════════════════════════════════
// // 9. 发送原始命令
// // ═══════════════════════════════════════════════════════════════════════════════
//
// const diag = await soul.command('诊断')
// console.log(diag.reply) // 系统诊断信息
//
// // ═══════════════════════════════════════════════════════════════════════════════
// // 10. 错误处理
// // ═══════════════════════════════════════════════════════════════════════════════
//
// // try {
// //   const ctx = await soul.process('你好', 'user_abc')
// // } catch (e) {
// //   if (e instanceof CCSoulError) {
// //     console.error(`Soul API error: ${e.message} (status: ${e.status})`)
// //   }
// // }
//
// // ═══════════════════════════════════════════════════════════════════════════════
// // 11. 完整对话循环示例
// // ═══════════════════════════════════════════════════════════════════════════════
//
// // async function chat(userMsg: string, userId: string) {
// //   // Step 1: 获取 soul 增强上下文
// //   const ctx = await soul.process(userMsg, userId)
// //
// //   // Step 2: 调用你的 LLM
// //   const aiReply = await callYourLLM(ctx.systemPrompt, ctx.augments, userMsg)
// //
// //   // Step 3: 反馈给 soul（异步，不阻塞）
// //   soul.feedback(userMsg, aiReply, userId).catch(() => {})
// //
// //   return aiReply
// // }
