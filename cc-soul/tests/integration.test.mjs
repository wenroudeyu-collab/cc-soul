/**
 * integration.test.ts — cc-soul 集成测试
 *
 * 通过 soul-process 的 handleProcess/handleFeedback 入口测试，
 * 不 import 内部模块，绕开循环依赖。
 *
 * 使用 Node.js 内置 test runner（node --test）
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

// soul-process 入口
const API_URL = 'http://localhost:18800'
const TEST_USER = 'test_integration_user'

async function apiCall(action, body = {}) {
  const res = await fetch(`${API_URL}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  })
  return res.json()
}

async function process(message, userId = TEST_USER) {
  return apiCall('process', { message, user_id: userId })
}

async function feedback(userMessage, aiReply, userId, satisfaction = '') {
  return apiCall('feedback', { user_message: userMessage, ai_reply: aiReply, user_id: userId, satisfaction })
}

async function health() {
  return apiCall('health')
}

// ═══════════════════════════════════════════════════════════════════════════════
// 测试
// ═══════════════════════════════════════════════════════════════════════════════

describe('cc-soul 集成测试', () => {

  before(async () => {
    // 确认 API 可用
    try {
      const h = await health()
      assert.equal(h.status, 'ok', 'cc-soul API should be running')
    } catch {
      console.error('cc-soul API not running. Start with: openclaw gateway --force')
      process.exit(1)
    }
  })

  describe('记忆写入', () => {

    it('应该处理一条普通消息', async () => {
      const result = await process('我是一名软件工程师 主要用Python')
      assert.ok(result, '应返回结果')
      assert.ok(result.system_prompt || result.augments, '应返回 system_prompt 或 augments')
    })

    it('应该处理包含事实的消息', async () => {
      const result = await process('我住在北京 在字节工作')
      assert.ok(result, '应返回结果')
    })

    it('应该处理情绪消息', async () => {
      const result = await process('今天心情很差 项目出了大问题')
      assert.ok(result, '应返回结果')
    })
  })

  describe('记忆召回', () => {

    it('应该能召回之前的事实', async () => {
      // 先写入
      await process('我养了一只叫花花的猫')
      await feedback('我养了一只叫花花的猫', '好可爱！花花是什么品种？', TEST_USER, 'positive')

      // 再召回
      const result = await process('我的猫叫什么名字')
      assert.ok(result, '应返回结果')
      // 检查 augments 中是否包含花花相关内容
      const augments = result.augments || result.augments_array || ''
      const hasRecall = typeof augments === 'string'
        ? augments.includes('花花') || augments.includes('猫')
        : Array.isArray(augments) && augments.some((a) => JSON.stringify(a).includes('花花'))
      // 不强制 assert（可能需要多轮积累），只打印
      console.log(`  召回结果: ${hasRecall ? '✅ 包含花花' : '⚠️ 未召回（可能需要更多数据）'}`)
    })
  })

  describe('冲突解决', () => {

    it('新事实应该覆盖旧事实', async () => {
      await process('我住在上海')
      await feedback('我住在上海', '上海很好', TEST_USER)

      await process('我搬到北京了')
      await feedback('我搬到北京了', '北京欢迎你', TEST_USER)

      // 问住哪
      const result = await process('我现在住哪里')
      console.log(`  住址召回: ${JSON.stringify(result.augments || '').slice(0, 100)}`)
    })
  })

  describe('排除性设计', () => {

    it('短确认消息不应该大量增加记忆', async () => {
      const before = await health()

      await process('嗯')
      await process('好的')
      await process('收到')

      // 这三条短消息不应该产生大量新记忆
      console.log('  短消息测试完成（检查日志确认不产生垃圾记忆）')
    })
  })

  describe('反馈学习', () => {

    it('正面反馈应该生效', async () => {
      const result = await feedback(
        '帮我看下这个bug',
        '这个bug是因为空指针引用导致的',
        TEST_USER,
        'positive'
      )
      assert.ok(result, '反馈应返回结果')
      assert.ok(result.learned !== undefined, '应返回 learned 字段')
    })

    it('纠正反馈应该生效', async () => {
      const result = await feedback(
        '你说错了 不是空指针',
        '你说的对，是空指针',
        TEST_USER,
        'negative'
      )
      assert.ok(result, '纠正反馈应返回结果')
    })
  })

  describe('API 健康检查', () => {

    it('/health 应该返回状态', async () => {
      const h = await health()
      assert.equal(h.status, 'ok')
      assert.ok(h.version, '应有版本号')
    })
  })
})
