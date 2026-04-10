# cc-soul 架构决策记录

## 2026-04-10：话题分层 C1/C2/C3

**决策**：三层分类，单标签硬分区
**原因**：扁平多标签软分池等于没分，Hit@10 卡在 43%
**放弃的方案**：
- 多标签 soft-weighting（效果不足，池子没变小）
- 从 LOCOMO 提取词（作弊，学术不诚信）
- 只用种子词不用 LLM（覆盖率 40% 不够）
- 硬编码 15 个话题（英文覆盖率不足）
**成功标准**：Hit@10 > 80%，C2 池平均 30-50 条
**关键约束**：query 和记忆分类必须一致

## 2026-04-10：AAM 6 方向扩展

**决策**：跨 conv 持久化、负关联、时序链、情感、失败学习、画像
**原因**：AAM 只学正向共现不够，需要多维度学习
**关键**：蒸馏反哺 AAM（飞轮效应），LLM 教 AAM（越用越省 LLM）

## 2026-04-09：CNAS 原创算法体系

**决策**：分治调度 + 12 信号场 + 双路召回
**原因**：一套算法不能解决所有题型
**组件**：
- Query-Type Dispatch（4 种查询类型）
- Topic-Partitioned Recall（话题分池路由）
- Iterative Bridge Recall（多实体二轮召回）
- Temporal Tie-Break（时间查询日期 boost）
- LLM query rewrite / rerank / MemR3（LLM 增强管线）
- Consensus Learning（LLM → AAM 反馈闭环）

## 2026-04-08：API 模式调通

**决策**：benchmark 走 recall()（完整管道）不走 activationRecall()（直调）
**修复**：认知负荷 bypass、routeMemories 放宽、指代消解跳过、SQLite bypass
**结果**：API 65.6% vs 直调 68.9%（差距来自 recallCount 膨胀）

## 2026-04-07：核心改进（v7 基线 68.9%）

**改进**：B4 IDF、B5 QA Type、A3 SIMPLE、A7 Cue Overload、PRF 放宽
**AAM 修复**：resetLearnedData 不清长期知识、reinforceTrace +1.5
**Memory 修复**：surprise 阈值放宽、英文偏好识别
**新增**：Sliding Window Merged Memories、Gist Trace、Prospective Tags 放宽

## 验证失败的方案（不要重试）

| 方案 | 退步 | 根因 |
|------|------|------|
| CRD Hopfield | -24% | 抑制级联杀正确答案 |
| C1 投票制 | -5% | 低排名噪声 |
| BEA 贝叶斯 | -20% | log-posterior 尺度不稳 |
| PMES per-memory | -5% | softmax 权重过集中 |
| A1 MINERVA pow | 方向反 | x<1 时 pow 压缩 |
| SDM proximity | -0.8% | 假阳性 |
| CoT prompt | -5% | DeepSeek-chat 不适合 CoT |
| Bo1 PRF | -0.9% | 选词不稳定 |
| RRF NAM Coordinator | -3% | 等权融合伤综合排序 |
| fact-store 注入 | -1.4% | facts 挤占 top-10 |
| Entity 预筛 | -2.7% | LOCOMO 每条都有人名 |
| 参数微调（QA Type↑） | sample+1.9% 全量-1.6% | sample/全量不一致 |
| hard-partition v1-v2 | -6.4% | 英文关键词覆盖率不足 |
