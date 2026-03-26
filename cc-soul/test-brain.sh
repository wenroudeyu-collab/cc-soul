#!/bin/bash
# 批量发送测试消息到飞书，验证 cc-soul 各模块功能
# 每条消息间隔 8 秒，给 bot 足够时间处理

send() {
  local msg="$1"
  local desc="$2"
  echo "📤 [$desc] $msg"
  osascript -e "
    tell application \"Feishu\" to activate
    delay 0.5
    tell application \"System Events\"
      keystroke \"$msg\"
      delay 0.3
      key code 36
    end tell
  " 2>/dev/null
  sleep 8
}

echo "=== cc-soul brain 模块测试 ==="
echo ""

# ── 基础交互（memory, cognition, body, persona） ──
send "你好啊" "基础交互-记忆/人格"
send "你还记得我吗" "记忆召回"
send "我最近在学 Rust" "记忆存储-fact"
send "帮我总结一下我们聊过什么" "记忆-会话摘要"

# ── evolution 规则学习 ──
send "你刚才的回复太长了，简洁一点" "纠错-规则学习"
send "这次好多了，谢谢" "正面反馈-假设验证"

# ── values 价值观 ──
send "直接给我代码就行，不用解释" "价值观-效率偏好"

# ── epistemic 知识边界 ──
send "你对量子计算了解多少" "知识边界-领域置信度"

# ── quality 质量 ──
send "你觉得你刚才回答得怎么样" "质量-自检"

# ── tasks 任务委托 ──
send "帮我写一个 Python 冒泡排序" "任务委托"

# ── flow 对话流 ──
send "继续" "对话流-深度追踪"
send "算了，换个话题" "对话流-话题切换"

# ── persona 人格切换 ──
send "你觉得我应该选 React 还是 Vue" "人格-军师模式"
send "教我怎么用 Docker" "人格-教练模式"

# ── lorebook 知识词典 ──
send "什么是 cc-soul" "知识词典查询"

# ── user-profiles ──
send "我是做 iOS 逆向的" "用户画像更新"

# ── fingerprint 灵魂指纹 ──
send "你最近有没有变" "灵魂指纹-一致性"

# ── inner-life 内心世界 ──
send "你现在心情怎么样" "内心世界-情绪状态"
send "你最近有什么想法" "内心世界-日记"

# ── graph 知识图谱 ──
send "Python 和 Rust 有什么关系" "知识图谱-实体关系"

# ── patterns 行为模式 ──
send "帮我分析一下这段代码的性能" "行为模式匹配"

# ── metacognition 元认知 ──
send "你说的和上次不一样啊" "元认知-冲突检测"

# ── experiment 实验 ──
send "功能状态" "功能开关查询"

# ── commands 命令 ──
send "记忆统计" "命令-记忆统计"
send "健康检查" "命令-健康检查"
send "灵魂导出" "命令-灵魂导出"

echo ""
echo "=== 测试完成，共发送 24 条消息 ==="
echo "请检查 gateway.log 确认各模块响应"
