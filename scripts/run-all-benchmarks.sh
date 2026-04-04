#!/bin/bash
# cc-soul NAM 全量 Benchmark
# 用法: bash scripts/run-all-benchmarks.sh
# 预计时间: 3-4 小时

set -e
cd /Users/z/.openclaw/plugins/cc-soul

REPORT_DIR="/Users/z/Documents/下一步计划"
TIMESTAMP=$(date +%Y%m%d_%H%M)

echo "═══════════════════════════════════════════"
echo "  cc-soul NAM Full Benchmark Suite"
echo "  $(date)"
echo "═══════════════════════════════════════════"
echo

# 1. 系统健康检查
echo "[1/6] 系统健康检查..."
npx tsx /tmp/audit_emotion_personality.ts 2>&1 | grep -E '^  [✅❌⚠️]' > /tmp/health_check.txt
cat /tmp/health_check.txt
echo

# 2. 中文 80 题
echo "[2/6] 中文 Benchmark (40 mem × 80 query)..."
npx tsx cc-soul/benchmark-recall.ts 2>&1 | grep -E '结果汇总|召回|Top-1|总体' > /tmp/bench_cn.txt
cat /tmp/bench_cn.txt
echo

# 3. 英文 80 题
echo "[3/6] 英文 Benchmark (40 mem × 80 query)..."
npx tsx cc-soul/benchmark-recall-en.ts 2>&1 | grep -E 'Results|recall|Top-1|Overall' > /tmp/bench_en.txt
cat /tmp/bench_en.txt
echo

# 4. 学习曲线
echo "[4/6] 学习曲线 (1200 条, 10 checkpoints)..."
npx tsx cc-soul/benchmark-learning-curve.ts 2>&1 | grep -E 'Checkpoint|RESULTS|Messages|improvement' > /tmp/bench_curve.txt
cat /tmp/bench_curve.txt
echo

# 5. LOCOMO recall-only
echo "[5/6] LOCOMO recall-only (conv-0, 50q)..."
npx tsx cc-soul/benchmark-locomo.ts --recall-only --conv 0 --limit 50 2>&1 | grep -E 'Layer|Hit|MRR|Type|TOTAL|Time' > /tmp/bench_locomo_recall.txt
cat /tmp/bench_locomo_recall.txt
echo

# 6. LOCOMO + LLM
echo "[6/6] LOCOMO + Kimi k2.5 (conv-0, 50q)..."
npx tsx cc-soul/benchmark-locomo.ts --llm --conv 0 --limit 50 2>&1 | grep -E 'Layer|Hit|MRR|Acc|Type|TOTAL|SM|LLM|Time' > /tmp/bench_locomo_llm.txt
cat /tmp/bench_locomo_llm.txt
echo

echo "═══════════════════════════════════════════"
echo "  All benchmarks complete: $(date)"
echo "═══════════════════════════════════════════"
