# cc-soul 待做清单（2026-04-07 整理）

## 当前基线
- Hit@10: **66.1%**（LOCOMO-MC10 全量 1986 题）
- LLM MC: **~73.5%**（200 题样本，DeepSeek-chat）
- 延迟 p50: **110ms**

## 断头路（已生成但未消费）

### _gist（Fuzzy Trace Theory 要旨痕迹）
- **位置**: benchmark-locomo.ts L167-196 生成 polarity + abstractTags
- **状态**: 生成了但 activation-field.ts 不读
- **原因**: s9 gist 信号实测 -0.6% Hit@10（abstractTags 映射表覆盖面太窄）
- **待做**: 扩展 ABSTRACT_MAP 到 200+ 词映射后重试，或改为产品端情绪标签用途

### _eventDate（原始事件时间戳）
- **位置**: benchmark-locomo.ts L120/147/169 生成，types.ts L177 定义
- **状态**: 生成了但无消费端
- **原因**: temporal tie-break 实测 -5.2%（全局 boost 伤排名），改 tie-break only 模式也 -0.6%
- **待做**: 等 temporal reasoning 子系统设计完成后，用 _eventDate 做事件时间对齐

## 已验证失败的方案（不再重试）

| 方案 | 退步 | 根因 |
|------|------|------|
| CRD Hopfield 竞争检索 | -24% | 抑制级联杀正确答案 |
| Document Expansion 全量 | -0.4% | 概念标签加噪声 |
| fact-store summary 提取 | -1.4% | 30-70 facts/conv 挤占 top-10 |
| DeepSeek-reasoner | 比 chat 更差 | 过度推理偏差 |
| LLM top-5 去噪 | -3.5% MC | 正确答案在 6-10 位 |
| 时间戳注入 LLM prompt | -7.5% MC | adversarial -23% |
| SM/LLM Fusion | -17.5% MC | SM 覆盖 adversarial 正确答案 |
| Slot-based global boost | -5.9% | 触发面太宽 |
| Temporal global rerank | -5.2% | 改主排序 |
| Episode Chain Activation | -0.6% | session 邻居不一定相关 |
| Gist Trace s9 | -0.6% | abstractTags 覆盖面窄 |
| Graph→AAM Bridge | -0.5% | entity pair 注入稀释 AAM 精度 |
| minCoverage 分母改原始词数 | -1.0% | 低质量匹配通过 |
| MMR lambda 动态调整 | -0.5% | temporal 需要多样性 |
| AAM expansion 减量 | -1.2% | multi_hop 需要广词汇 |
| Answer matching 阈值放宽 | -1.6% | false positive |
| Summary bonus 动态降低 | -0.3% | summary 有效信号被削弱 |
| AAM feedback 权重 0.8 | -0.3% | 过度学习 |

## 待做优先级

### P0（答案选择层 — 最大增量，不动召回引擎）
1. **C1 投票制** — 每条记忆独立投票×activation加权，替代拼接打分。改 selectAnswer。预估 SM +2~5%
2. **C3 Negative Evidence** — topicPresence && !detailPresence → 倾向 "Not answerable"。改 selectAnswer。预估 adversarial SM +5~10%
3. **B4 IDF-Weighted Coverage** — token coverage 加 IDF 权重，"the"≠"ukulele"。改 selectAnswer。预估 SM +2~3%
4. **B5 QA Type 匹配** — Who→人名boost, When→日期boost, Where→地名boost, How many→数字boost。20行规则。预估 SM +2~4%

### P0（架构升级）
5. **话题分池召回（Topic-Partitioned Recall）** — ✅ 已实现硬编码版（15 个话题 hard-partition + fallback）。待做：动态话题发现（AAM PMI > 3.0 词簇自动聚类为新话题）。
6. **微蒸馏（Real-time Micro-Distillation）** — addMemory 后检查最近 10 条 trigram > 0.3 的记忆，合并更新。轻活实时干（+5ms），重活定时干（6h 深度蒸馏）。解决 online 缺 merged windows。与深度蒸馏互补不冲突。
6. **PSA（Parallel Signal Agents）** — 子 agent 并行召回 + RRF 总成。参考 /Users/z/Downloads/claude-code-main 的 agent 架构做原创设计。预期：打破乘法融合的天花板
6. **API 全系统 benchmark** — 用 soul-api.ts 接口，让 AAM/蒸馏/utility 全部运行。对标竞品的真实测试方式

### P1（召回层改进）
7. **A3 SIMPLE 时间干扰** — log(age) 接近的记忆互相干扰更强，抑制同期冗余。改 activation-field 信号⑤。预估 temporal +2~3%
8. **B1 SDM 词序感知** — 0.85*unigram + 0.10*ordered_bigram + 0.05*proximity。改 contextMatch。预估 +1~2%
9. **B3 PRF 二轮检索** — round1 top5 提取 TF-IDF 新词扩展 query → round2。改 activationRecall。预估 +2~3%
10. **A7 Cue Overload 惩罚** — AAM 扩展词权重除以 log(2+hitCount)。减少扩展噪声。预估 +1~2%
11. **A1 MINERVA 非线性放大** — finalRaw^1.5 拉大 top 分差。MRR↑ → LLM 受益。预估 MRR +2~3%

### P1（产品体验）
12. **Duty Room Cache（值房缓存）** — 高频记忆免检通道，<5ms 延迟
13. **temporal reasoning 子系统** — 基于 _eventDate 的结构化时间对齐（需要重新设计，不做全局 rerank）
14. **fact-store 精确注入** — 限制每次最多 3 条 facts，matchScore > 5 才融合

### P2（长期）
15. **A2 TCM 时间上下文漂移** — 最近 K 条消息 token 频率向量连续漂移，替代硬编码 recallContexts。改信号⑥。预估 single_hop +1~2%
16. **A4 SAM 恢复重试** — coverage rerank 后检验证据覆盖度，不够则丢弃弱项补入新候选。预估 multi_hop +2~3%
17. **A5 Optimal Foraging** — 检测 top-K 是否 >60% 来自同 session，条件性 boost 其他 session。预估 multi_hop +1~2%
18. **B2 BM25F 字段加权** — TF saturation 前合并 weighted_tf(3×tags + 2×prospective + 1×content)。改 contextMatch。预估 +1~2%
19. **A6 Encoding Variability** — log(1+unique_recall_contexts)/log(5) bonus。消费已有 recallContexts。预估 +1%
20. **Gist Trace 扩展** — ABSTRACT_MAP 扩展到 200+ 词后重试 s9
21. **FSRS v6 升级** — 纯公式替换
22. **涌现标签→distill 反馈** — microLinks 自动话题发现

### P3
23. **C2 Choice-as-Query 反向验证** — 用选项关键词反查记忆库 top-3，看证据链强度。改 selectAnswer。预估 SM +1~3%

## 核心约束
- **零向量零 LLM**：召回层永远不依赖外部 API
- **动态不硬编码**：所有检测用正则/统计，不用题型标签
- **写了就要接上**：每个新功能必须在消费端有调用
- **改了就测**：每次改动跑全量 1986 题验证

## 团队方案 v1.0（2026-04-07 收到）

### Phase 1: FOK 元记忆框架
- FOK = cueFamiliarity + accessibility + competition + targetPresence + qpp_variance
- 升级 Dynamic Abstain，adversarial 预计 +45~67 题
- 参考：Metamemory, SIGIR 2024 QPP Tutorial

### Phase 2: SeCom 话题分段 + SDM 词序感知 + PRF + NegEvidence
- SeCom (ICLR 2025): 话题连贯段落替代 per-turn
- SDM (SIGIR 2005): 0.85*unigram + 0.10*ordered_bigram + 0.05*proximity
- BM25F: 结构化字段加权（content/tags/prospective）
- PRF 两轮 + Negative Evidence 信号

### Phase 3: 双轨召回 + Schema Recall
- Fast path: fact-store O(1) lookup → 精确命中直接注入
- Slow path: 完整 activation field
- person-model schema keywords 作为隐式 query expansion

## MemFactory 启发（2026-04-07）

### 值得做：增量 L2 融合
- **来源**: MemFactory 的 CRUD Updater（ADD/DEL/UPDATE/NONE）
- **当前**: distill.ts 批量聚类（6 小时周期），L1 堆积等蒸馏
- **改进**: 新 L1 写入时，如果跟现有 TopicNode SimHash 相似度超阈值，直接更新该节点 summary + sourceCount
- **好处**: 解决"L1 堆积等蒸馏"延迟，同时实现语义级 UPDATE
- **佐证**: LightThinker 数据表明 70% token 可丢弃准确率只降 1%，蒸馏后可大胆清 L1

### 不值得做
- gist token 压缩（需微调模型，我们调 API）
- GRPO 离线训练（在线 bandit 已够用，无标注数据）
- 完整复刻 MemFactory 模块化架构（太 naive）

## 关键方法论洞察（论文核心论点）
- **LOCOMO 是阅读理解测试不是记忆测试** — Hindsight 自己说 "not a reliable indicator of memory system quality"
- **Online vs Offline 才是真差距** — LongMemEval: GPT-4o offline 91% → online 57%（-34%）
- **cc-soul 论点**: 别家 offline 强 online 弱，我们为 online 优化（AAM+蒸馏+utility 越用越准）

## 竞品论文可偷的算法（2026-04-08 收到）

### P0（白捡分）
- **PMI 阈值参数化** — aam.ts:2346 硬编码 3.0 改 getParam()
- **light_sleep 跑 L1→L2** — handler-heartbeat.ts 浅睡加调 distillL1toL2()
- **事实衰老** — fact-store.ts 工作地点 auto-expire 1 年
- **entity 时间衰减** — graph.ts 1 年前关联 0.5×

### P1（中等改动）
- **Event-based 衰减** — FOREVER 论文：ACT-R 用"之后发生了多少事件"替代 wall-clock（activation-field.ts s1）
- **Complexity-aware routing** — TiMem 论文：简单查询直读 L3 心智模型，复杂查询走 activationRecall
- **五因子准入控制** — A-MAC 论文：替代单一 surprise 阈值（utility×confidence×novelty×recency×contentType）
- **因果图谱** — MAGMA 论文：检测"因为/所以/导致/because"建 causal edge，multi_hop 直接解

### P2（论文级原创）
- **RRF NAM Coordinator** — 把 6 worker 并集改成 Reciprocal Rank Fusion: score = Σ 1/(k+rank_i)。RwF 论文(arxiv 2603.09576)启发的能量最小化路由思路。★★★★☆
- **认知负荷感知路由 (CLAR)** — CGAF + TiMem 融合 ★★★★★
- **自适应概率门控** — FluxMem 论文：Beta Mixture Model 替代硬阈值 ★★★★☆
- **Hopfield 联想召回通道** — SuperLocalMemory 论文：记忆级模式补全 ★★★★☆
- **个人 FSRS 参数学习** — 从用户遗忘历史反演 FSRS weights ★★★★☆

### 参考文献清单（论文用）
- Hindsight: arxiv.org/abs/2512.12818
- ENGRAM: arxiv.org/abs/2511.12960
- SeCom: arxiv.org/abs/2502.05589
- Fuzzy Trace: Reyna & Brainerd, PMC4815269
- FOK: PubMed 37732967
- SDM: Metzler & Croft, SIGIR 2005
- QPP: SIGIR 2024 Tutorial
- Memory Survey 2026: arxiv.org/html/2604.01707
- MINERVA 2: Hintzman 1984
- TCM: Howard & Kahana 2002
- SIMPLE: Brown, Neath & Chater 2007
- SAM: Raaijmakers & Shiffrin 1981
- Optimal Foraging: Hills, Jones & Todd 2012
- Encoding Variability: Memory & Cognition 2024-2025
- BM25F: Robertson et al.
- PRF/RM3: Rocchio
- A-MAC: arxiv.org/abs/2603.04549
- TiMem: arxiv.org/abs/2601.02845
- FOREVER: arxiv.org/abs/2601.03938
- FluxMem: arxiv.org/abs/2602.14038
- MAGMA: arxiv.org/abs/2601.03236
- CraniMem: arxiv.org/abs/2603.15642
- SuperLocalMemory: arxiv.org/abs/2604.04514
