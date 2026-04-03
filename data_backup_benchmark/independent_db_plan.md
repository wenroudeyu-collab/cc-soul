# cc-soul 独立数据库方案

## 背景
cc-soul 当前数据存储依赖 OpenClaw 的共享 memory.db。
学习 Mem0/Zep/Letta：全部使用自己独立的数据库。
讨论日期：2026-04-02

## 目标
cc-soul 有自己的 SQLite 数据库，不依赖 OpenClaw 的任何数据文件。
任何平台（OpenClaw/飞书/API）都走同一个数据库。

## 当前数据分布
| 数据 | 当前位置 | 应迁移到 |
|------|---------|---------|
| 记忆 (memories) | OpenClaw memory.db | cc-soul/data/soul.db |
| 结构化事实 (structured_facts) | OpenClaw memory.db | cc-soul/data/soul.db |
| 聊天历史 (chat_history) | OpenClaw memory.db | cc-soul/data/soul.db |
| 决策日志 (decision_log) | OpenClaw memory.db | cc-soul/data/soul.db |
| 主题节点 (topic_nodes) | OpenClaw memory.db | cc-soul/data/soul.db |
| AAM 网络 | cc-soul/data/aam_associations.json | cc-soul/data/soul.db (可选) |
| 用户档案 | cc-soul/data/ JSON 文件 | cc-soul/data/soul.db |
| KV 存储 | cc-soul/data/soul_kv.db | 保留（已独立） |

## 方案：全新独立数据库（不迁移旧数据）
1. 在 cc-soul/data/soul.db 创建所有表（schema 从 sqlite-store.ts 复制）
2. 修改 sqlite-store.ts 的 DB_PATH 指向 soul.db（不读 OpenClaw memory.db）
3. 旧记忆不迁移——用户聊天时自然积累新记忆
4. facts 从零开始——用户说话时动态提取
5. API 模式和 OpenClaw 模式都读写同一个 soul.db

## 今晚修复的 bug 清单（待验证）

### 已修复
1. WAL 疑问句误提取 → 动态句法检测（不硬编码）
2. fact supersede 质量过滤 → 新 object 信息量 < 旧的 50% 时拒绝
3. System 1 单 pattern 匹配 → 改为所有 pattern 合并
4. System 1 facts 被 crystallize 挤掉 → S1 facts 独立 priority=9 augment
5. facts 始终注入 buildSoulPrompt → 学 ChatGPT 模式
6. context-engine sync recall → 每次 assemble 同步 recall

### 发现但未修
1. deep-soul LLM 分析结果污染 fact-store → 需要在 fact 写入时过滤 LLM 分析内容
2. fact-store 里大量垃圾数据（LLM 幻觉写入）→ 需要批量清理
3. occupation fact 被污染 → 需要恢复正确值
4. 飞书路径 augments 一轮延迟 → facts 注入 soul prompt 可部分解决
5. 举一反三 + 联想链仍在关闭状态 → 需要恢复
6. behavioral-phase-space.ts:307 patterns.find is not a function
7. dbGetDueReminders is not a function
