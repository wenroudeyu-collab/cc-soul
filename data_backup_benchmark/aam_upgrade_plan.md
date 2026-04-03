# AAM 升级方案：六个力 + ActivationTrace

## 背景
移除向量搜索后，AAM 需要补上冷启动、重要度、反馈闭环的缺口。
讨论日期：2026-04-01

## 核心数据结构变更

### ActivationTrace（所有批次的前置）
```typescript
interface ActivationTrace {
  memory: Memory
  score: number
  path: {
    stage: 'candidate_selection' | 'signal_boost' | 'signal_suppress'
    via: string  // 'bm25' | 'aam_hop1' | 'aam_hop2' | 'graph' | 'cin' | 'system1_fact' | 'priming' | 'emotion' | 'recency' | 'interference' | 'mmr' | ...
    word?: string
    rawScore: number  // 正=加分，负=减分（不算比例，Shapley太贵）
  }[]
}
```

### Rejection Log（debug 召回失败用）
```typescript
interface RejectionRecord {
  content: string          // 被拒记忆的前 30 字
  originalRank: number     // scoring 阶段的排名
  finalRank: number        // rerank/dedup 后的排名（-1 = 被移除）
  reason: 'interference' | 'mmr_dedup' | 'below_threshold' | 'priming_miss' | 'budget_cut'
}
```
对 score top-20 但没进 top-N 的记忆，记录 rejection 原因 + 原始排名。

### Trace 生命周期
```typescript
// 内存缓存，用 Date.now() 作 key，不用精确 turnId
const _traceBuffer = new Map<number, { traces: ActivationTrace[]; rejections: RejectionRecord[] }>()

// feedback 到达时，按时间窗口匹配（30秒内最近的 trace），不要求精确 turnId
const recentTraces = [..._traceBuffer.entries()]
  .filter(([ts]) => now - ts < 30_000)
  .sort(([a], [b]) => b - a)
const matchedTrace = recentTraces[0]?.[1]
```
内存保留最近 3 轮，不持久化。进程重启丢了无所谓，下次重新积累。

---

## 六个力

### 力1：种子注入（批次1）
- 位置：aam.ts 初始化
- 做法：把 COLD_START_SYNONYMS 写入 network.cooccur，初始 count=2
- 删掉 expandQuery 里的 Phase 1 独立查询，统一走 cooccur
- getCooccurrence 自动覆盖（种子在 cooccur 里了）

### 力2：消息学习 + 情绪加权（批次1）
- 位置：aam.ts feedMemory()
- 做法：emotionMultiplier = intensity >= 0.7 ? 3 : intensity >= 0.5 ? 2 : 1
- 共现计数 += emotionMultiplier（不是 +1）
- 不做双轨（PMI 被抬高是期望行为，不是污染）

### 力3：时间衰减（批次1）
- 位置：aam.ts，heartbeat 触发
- 做法：分层衰减
  - 强关联（cooccur > 10）：×0.995/h
  - 弱关联（cooccur <= 10）：×0.98/h
  - 衰减到 < 0.5 时删边（pruning）
- 种子关联如果用户没聊过，几周后自然消失
- 种子关联如果用户聊了，count 远 > 衰减速度，不受影响

### 力4：activationDamping — 话题切换短期压制（批次2）
- 位置：aam.ts + cognition.ts
- 数据结构：独立的 Map<string, number>（word → damping factor，默认1.0）
- 不碰 cooccur（长期知识），只碰激活阈值（短期状态）
- 触发：cognition.ts 的 intentMomentum reset 信号
- 恢复：时间衰减回 1.0（damping = damping * 0.9 + 1.0 * 0.1），5-10轮恢复
- 不持久化（重启后全 1.0，合理）

### 力5：正反馈 — 强化好的扩展路径（批次3）
- 依赖：ActivationTrace
- 触发：feedbackMemoryEngagement 判定 engaged
- 做法：沿 trace 的 aam_hop1/aam_hop2 路径，强化边权重
  - hop1 边：cooccur += 0.5
  - hop2 边：cooccur += 0.3（信号弱一些）
- queryWord → expandedWord 记录在 trace 中

### 力6：负反馈 — 抑制坏的扩展（批次3）
- 依赖：ActivationTrace
- 触发：injectionMiss
- 做法：不减边权重（信用分配问题），减扩展跳数
  - miss 来自 hop2 → 下次同类查询只做 1-hop
  - miss 来自 hop1 → 下次不扩展
  - 恢复：1-hop 产出被 engaged → 恢复 2-hop
- 跳数状态：per-query-pattern 存内存（Map<string, number>），不持久化

---

## 三批交付计划

### 批次1：独立的四个改动
1. ActivationTrace 结构定义 + activation-field.ts 计算时记录 path
2. 种子注入：COLD_START_SYNONYMS → cooccur，删 Phase 1 独立查询
3. 时间衰减：heartbeat 触发分层衰减
4. 情绪加权：feedMemory 的 emotionMultiplier
5. Rejection Log：top-20 未入选记忆的原因记录

交付后：重启 OpenClaw + 飞书逐条测试验证

### 批次2：cognition 信号驱动
1. activationDamping Map + spreading activation 乘法
2. onTopicSwitch 函数 + cognition.ts intentMomentum reset 接入
3. damping 时间恢复逻辑

交付后：飞书测试话题切换场景

### 批次3：反馈闭环
1. 正反馈：trace 路径回溯 + 边权重强化
2. 负反馈：跳数降级 + 恢复条件
3. decision-log 集成 trace 数据
4. A/B 实验用 trace.source 做归因

交付后：飞书测试多轮对话验证反馈循环

---

## 已确认的设计决策
- 不加回向量搜索（方向是移除向量后用 AAM 替代）
- 不做双轨 cooccur（过度工程，PMI 被抬高是期望行为）
- 负反馈不减边权重（信用分配问题），减扩展跳数
- trace 不持久化，内存保留 3 轮
- contribution 用 rawScore 不用比例（Shapley 太贵）
- source 按阶段归因（candidate_selection / signal_boost / signal_suppress），不按通道

## 需要改的文件
- aam.ts：种子注入、情绪加权、时间衰减、damping、正负反馈
- activation-field.ts：ActivationTrace 记录、rejection log
- handler-augments.ts：trace 传递给 feedback
- soul-process.ts：feedback 回溯 trace
- cognition.ts：intentMomentum reset → onTopicSwitch
- handler-heartbeat.ts：时间衰减触发
- decision-log.ts：trace 数据记录
