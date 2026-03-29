#!/bin/bash
# cc-soul 向量搜索一键安装
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
MODEL_DIR="$DIR/data/models/minilm"

echo "📦 安装向量搜索..."
mkdir -p "$MODEL_DIR"
echo "  下载模型..."
curl -sL -o "$MODEL_DIR/model.onnx" "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx"
curl -sL -o "$MODEL_DIR/vocab.json" "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json"
echo "  安装运行时..."
cd "$DIR" && npm i --save onnxruntime-node --silent 2>/dev/null
echo "✅ 完成！重启 gateway 即可生效"
