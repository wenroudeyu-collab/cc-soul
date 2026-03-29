#!/bin/bash
# feishu-chat.sh — 通过飞书客户端发送消息并等待 bot 回复
# Usage: ./scripts/feishu-chat.sh "消息内容"

set -e

CHAT_ID="oc_155ed38d406d3f2d08ff2d460605207a"
APP_ID="cli_a9274ea6a738dcb2"
APP_SECRET="VwnRudqyhsMcFBjvI2kfXbpOtstcguBC"
MSG="$1"

if [ -z "$MSG" ]; then
  echo "Usage: $0 \"消息内容\""
  exit 1
fi

# 发送消息
echo -n "$MSG" | pbcopy
open "lark://client/chat/open?chatId=$CHAT_ID"
sleep 1.5
osascript -e 'tell application "Feishu" to activate'
sleep 0.5
cliclick kd:cmd t:v ku:cmd w:500 kp:return
echo "[sent] $MSG"

# 等待 bot 回复
sleep 8

# 获取 token
TOKEN=$(curl -s -X POST 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' \
  -H 'Content-Type: application/json' \
  -d "{\"app_id\":\"$APP_ID\",\"app_secret\":\"$APP_SECRET\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['tenant_access_token'])")

# 拉最新 3 条消息
curl -s "https://open.feishu.cn/open-apis/im/v1/messages?container_id_type=chat&container_id=$CHAT_ID&page_size=3&sort_type=ByCreateTimeDesc" \
  -H "Authorization: Bearer $TOKEN" | python3 -c "
import sys, json, datetime
data = json.load(sys.stdin)
for item in reversed(data.get('data',{}).get('items',[])):
    stype = item['sender'].get('sender_type','?')
    ts = int(item['create_time']) // 1000
    t = datetime.datetime.fromtimestamp(ts).strftime('%H:%M:%S')
    role = 'BOT' if stype == 'app' else 'ME'
    if item['msg_type']=='text':
        c = json.loads(item['body']['content']).get('text','')[:200]
    elif item['msg_type']=='post':
        try:
            body = json.loads(item['body']['content'])
            # Extract text from post format
            texts = []
            for lang in body.values():
                if isinstance(lang, dict) and 'content' in lang:
                    for line in lang['content']:
                        for seg in line:
                            if seg.get('tag') == 'text':
                                texts.append(seg.get('text',''))
            c = ''.join(texts)[:200] if texts else '[富文本]'
        except:
            c = '[富文本]'
    elif item['msg_type']=='interactive':
        c = '[卡片消息]'
    else:
        c = f'[{item[\"msg_type\"]}]'
    print(f'{t} | {role:3s} | {c}')
"
