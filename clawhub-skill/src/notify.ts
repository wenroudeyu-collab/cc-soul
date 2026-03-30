/**
 * cc-soul — Notification layer
 *
 * If Feishu credentials are configured: sends to Feishu (group + owner DM).
 * If not configured: falls back to console.log (works for all users).
 */

import { soulConfig } from './persistence.ts'

// ═══════════════════════════════════════════════════════════════════════════════
// FEISHU AUTH (only if configured)
// ═══════════════════════════════════════════════════════════════════════════════

const FEISHU_APP_ID = soulConfig.feishu_app_id
const FEISHU_APP_SECRET = soulConfig.feishu_app_secret
const REPORT_CHAT_ID = soulConfig.report_chat_id
const HAS_FEISHU = Boolean(FEISHU_APP_ID && FEISHU_APP_SECRET && REPORT_CHAT_ID)

let feishuToken = ''
let feishuTokenExpiry = 0
let tokenPromise: Promise<string> | null = null

async function getFeishuToken(): Promise<string> {
  if (!HAS_FEISHU) return ''
  if (feishuToken && Date.now() < feishuTokenExpiry) return feishuToken
  if (tokenPromise) return tokenPromise

  tokenPromise = (async () => {
    try {
      const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
      })
      const data = (await resp.json()) as any
      if (data.tenant_access_token) {
        feishuToken = data.tenant_access_token
        feishuTokenExpiry = Date.now() + 7000000
        return feishuToken
      }
    } catch (e: any) {
      console.error(`[cc-soul][feishu-token] ${e.message}`)
    } finally {
      tokenPromise = null
    }
    return ''
  })()

  return tokenPromise
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP NOTIFICATION — Feishu if configured, otherwise console.log
// ═══════════════════════════════════════════════════════════════════════════════

export async function notifySoulActivity(message: string) {
  // Block system detection alerts (not user content)
  if (message.includes('检测到') && message.includes('进程') && (message.includes('并发运行') || message.includes('实例'))) {
    console.log(`[cc-soul][notify] BLOCKED system alert: ${message.slice(0, 80)}`)
    return
  }
  // Always log locally
  console.log(`[cc-soul][notify] ${message}`)

  // Send to Feishu only if configured
  if (!HAS_FEISHU) return

  try {
    const token = await getFeishuToken()
    if (!token) return

    await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: REPORT_CHAT_ID,
        msg_type: 'text',
        content: JSON.stringify({ text: `\u{1F9E0} ${message}` }),
      }),
    })
  } catch (e: any) {
    // Silent fail — notification should never break core functionality
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// OWNER DM — Feishu DM if configured, otherwise console.log
// ═══════════════════════════════════════════════════════════════════════════════

export async function notifyOwnerDM(message: string) {
  // Block system detection alerts (not user content)
  if (message.includes('检测到') && message.includes('进程') && (message.includes('并发运行') || message.includes('实例'))) {
    console.log(`[cc-soul][owner] BLOCKED system alert: ${message.slice(0, 80)}`)
    return
  }
  // Always log locally
  console.log(`[cc-soul][owner] ${message}`)

  // Send Feishu DM only if configured
  const openId = soulConfig.owner_open_id
  if (!HAS_FEISHU || !openId) return

  try {
    const token = await getFeishuToken()
    if (!token) return

    await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: openId,
        msg_type: 'text',
        content: JSON.stringify({ text: `\u{1F9E0} ${message}` }),
      }),
    })
  } catch (e: any) {
    // Silent fail
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPLY VIA OPENCLAW SDK — replaces legacy replyToChat / replyToSender
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Reply to a user/group via OpenClaw plugin SDK.
 *
 * @param to   OpenClaw address, e.g. `user:ou_xxx` or `group:oc_xxx`
 * @param text Plain text to send
 * @param cfg  OpenClaw config object (from api.config in plugin hooks)
 */
export async function replySender(to: string, text: string, cfg?: any) {
  if (!cfg) {
    // No SDK config available — fallback to owner DM (legacy path / CLI mode)
    return notifyOwnerDM(text)
  }
  try {
    const { sendMessageFeishu } = await import('openclaw/plugin-sdk/feishu')
    await sendMessageFeishu({ cfg, to, text })
  } catch (e: any) {
    console.error(`[cc-soul][reply] sendMessageFeishu failed: ${e.message}`)
    // fallback to legacy owner DM so the message is not lost
    notifyOwnerDM(text).catch(() => {})
  }
}
