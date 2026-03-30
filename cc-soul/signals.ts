/**
 * signals.ts — Shared keyword/signal lists
 *
 * Single source of truth for emotion, correction, tech, and casual keyword lists.
 * Used by cognition.ts, body.ts, and patterns.ts.
 */

export const EMOTION_POSITIVE = ['开心', '哈哈', '牛逼', '太棒', '感谢', '谢谢', '厉害', '完美', '爽', '赞', '舒服', '终于']
export const EMOTION_NEGATIVE = ['烦', '累', '难过', '崩溃', '压力大', '焦虑', '郁闷', '烦死', '受不了', '头疼', '无语', '吐了']
export const EMOTION_ALL = [...EMOTION_NEGATIVE, ...EMOTION_POSITIVE]

// ── 细粒度情绪分类（12 种） ──
export type EmotionLabel =
  | 'joy'         // 开心/兴奋/满足
  | 'gratitude'   // 感恩/感谢
  | 'pride'       // 骄傲/成就感
  | 'anticipation' // 期待/兴奋等待
  | 'relief'      // 释然/如释重负
  | 'anxiety'     // 焦虑/担心/紧张
  | 'frustration' // 烦躁/受挫/无奈
  | 'anger'       // 愤怒/生气
  | 'sadness'     // 难过/伤心/失落
  | 'disappointment' // 失望
  | 'confusion'   // 困惑/迷茫
  | 'neutral'     // 平静/无明显情绪

/** 从消息文本检测细粒度情绪（规则+上下文组合） */
export function detectEmotionLabel(msg: string): { label: EmotionLabel; confidence: number } {
  const m = msg.toLowerCase()
  const len = msg.length

  // ── 高置信度模式（组合词/语气判断）──

  // 愤怒：感叹+负面词，或明确愤怒词
  if (/[！!]{2,}/.test(msg) && EMOTION_NEGATIVE.some(w => m.includes(w))) return { label: 'anger', confidence: 0.9 }
  if (['气死', '生气', '怒了', '操', '妈的', '什么玩意', '脑残', '智障'].some(w => m.includes(w))) return { label: 'anger', confidence: 0.9 }

  // 焦虑：担心/紧张类
  if (['焦虑', '担心', '紧张', '害怕', '慌', '着急', '来不及', '怎么办', '完蛋', '压力大', '压力好大', '撑不住'].some(w => m.includes(w))) return { label: 'anxiety', confidence: 0.85 }
  if (/deadline|ddl|来不及|赶不上/.test(m)) return { label: 'anxiety', confidence: 0.8 }

  // 沮丧/受挫：反复失败类
  if (['烦死', '受不了', '无语', '服了', '废了', '头疼', '搞不定', '又出问题', '又挂了', '又崩了'].some(w => m.includes(w))) return { label: 'frustration', confidence: 0.85 }
  if (/又.*了|还是不行|试了.*次/.test(m)) return { label: 'frustration', confidence: 0.7 }

  // 失望
  if (['失望', '白费', '白忙', '没想到', '原来是这样', '早知道'].some(w => m.includes(w))) return { label: 'disappointment', confidence: 0.8 }

  // 悲伤
  if (['难过', '伤心', '心疼', '想哭', '哭了', '好难', '太难了', '心累', '无力'].some(w => m.includes(w))) return { label: 'sadness', confidence: 0.85 }

  // 困惑
  if (['困惑', '不明白', '搞不懂', '什么意思', '为什么会', '怎么回事', '看不懂', '迷茫'].some(w => m.includes(w))) return { label: 'confusion', confidence: 0.8 }
  if (/[？?]{2,}/.test(msg)) return { label: 'confusion', confidence: 0.6 }

  // 释然
  if (['终于', '搞定了', '解决了', '原来如此', '恍然大悟', '明白了', '通了'].some(w => m.includes(w))) return { label: 'relief', confidence: 0.8 }

  // 骄傲/成就感
  if (['搞定', '成功', '做到了', '完成了', '上线了', '过了', '拿到了'].some(w => m.includes(w)) && /[！!]|太/.test(msg)) return { label: 'pride', confidence: 0.75 }

  // 期待
  if (['期待', '好想', '等不及', '希望', '打算', '准备', '要开始'].some(w => m.includes(w))) return { label: 'anticipation', confidence: 0.7 }

  // 感恩
  if (['感谢', '谢谢', '多亏', '幸好', '还好有你', '帮了大忙'].some(w => m.includes(w))) return { label: 'gratitude', confidence: 0.85 }

  // 开心（通用正面）
  if (['开心', '哈哈', '太棒', '牛逼', '厉害', '完美', '爽', '舒服', '赞', '嘿嘿'].some(w => m.includes(w))) return { label: 'joy', confidence: 0.8 }
  if (/[哈嘻]{3,}/.test(msg)) return { label: 'joy', confidence: 0.7 }

  // ── 低置信度兜底 ──
  if (EMOTION_POSITIVE.some(w => m.includes(w))) return { label: 'joy', confidence: 0.4 }
  if (EMOTION_NEGATIVE.some(w => m.includes(w))) return { label: 'frustration', confidence: 0.4 }

  return { label: 'neutral', confidence: 0.3 }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 情绪光谱：输出连续多维情绪评分，多种情绪可以共存
// 和意图光谱对称的设计，形成 cc-soul 的"光谱哲学"
//
// 不是 "这条消息是 anger" 而是 "anger: 0.6, anxiety: 0.3, joy: 0.0"
// 人的情绪本来就不是单一的——可以同时又气又急又委屈
// ═══════════════════════════════════════════════════════════════════════════════

export interface EmotionSpectrum {
  anger: number       // 愤怒 [0, 1]
  anxiety: number     // 焦虑
  frustration: number // 挫败
  sadness: number     // 悲伤
  joy: number         // 开心
  pride: number       // 自豪
  relief: number      // 释然
  curiosity: number   // 好奇
}

export function computeEmotionSpectrum(msg: string): EmotionSpectrum {
  const m = msg.toLowerCase()
  const spectrum: EmotionSpectrum = {
    anger: 0, anxiety: 0, frustration: 0, sadness: 0,
    joy: 0, pride: 0, relief: 0, curiosity: 0,
  }

  // 愤怒信号
  const angerSignals = (m.match(/生气|愤怒|气死|混蛋|什么鬼|太过分|凭什么|受够/g) || []).length
  if (/[！!]{2,}/.test(msg) && angerSignals > 0) spectrum.anger = Math.min(1, 0.5 + angerSignals * 0.2)
  else spectrum.anger = Math.min(1, angerSignals * 0.3)

  // 焦虑信号
  const anxietySignals = (m.match(/焦虑|担心|害怕|紧张|不安|怎么办|来不及|deadline|ddl|赶不上/g) || []).length
  spectrum.anxiety = Math.min(1, anxietySignals * 0.3)

  // 挫败信号
  const frustSignals = (m.match(/又.*了|还是不行|试了.*次|搞不定|放弃|算了|不想|太难/g) || []).length
  spectrum.frustration = Math.min(1, frustSignals * 0.3)

  // 悲伤信号
  const sadSignals = (m.match(/难过|伤心|失望|遗憾|可惜|唉|哭|委屈|孤独|想念/g) || []).length
  spectrum.sadness = Math.min(1, sadSignals * 0.35)

  // 开心信号
  const joySignals = (m.match(/开心|高兴|太好了|哈哈|[🎉😊😄🥳]|棒|赞|厉害|成功/g) || []).length
  spectrum.joy = Math.min(1, joySignals * 0.3)

  // 自豪信号
  const prideSignals = (m.match(/搞定|做到了|完成|上线了|通过了|拿到了|终于/g) || []).length
  spectrum.pride = Math.min(1, prideSignals * 0.35)

  // 释然信号
  const reliefSignals = (m.match(/终于|解决了|松了口气|还好|幸好|好在|没事了/g) || []).length
  spectrum.relief = Math.min(1, reliefSignals * 0.35)

  // 好奇信号
  const curSignals = (m.match(/怎么.*的|为什么|好奇|想知道|有意思|原来|没想到|居然/g) || []).length
  spectrum.curiosity = Math.min(1, curSignals * 0.25)

  // 归一化：确保不超过 1
  for (const key of Object.keys(spectrum) as (keyof EmotionSpectrum)[]) {
    spectrum[key] = Math.min(1, Math.max(0, spectrum[key]))
  }

  return spectrum
}

/** 从情绪光谱中提取主导情绪（兼容旧的单标签系统） */
export function spectrumToDominant(spectrum: EmotionSpectrum): { label: string; confidence: number } | null {
  let maxVal = 0.15  // 最低阈值
  let maxKey = ''
  for (const [key, val] of Object.entries(spectrum)) {
    if (val > maxVal) { maxVal = val; maxKey = key }
  }
  return maxKey ? { label: maxKey, confidence: maxVal } : null
}

/** 情绪标签转旧版标签（兼容已有代码） */
export function emotionLabelToLegacy(label: EmotionLabel): 'neutral' | 'warm' | 'painful' | 'important' {
  switch (label) {
    case 'joy': case 'gratitude': case 'relief': return 'warm'
    case 'anxiety': case 'frustration': case 'anger': case 'sadness': case 'disappointment': return 'painful'
    case 'pride': case 'anticipation': return 'important'
    default: return 'neutral'
  }
}

/** 情绪标签转 PADCN 向量增量 */
export function emotionLabelToPADCN(label: EmotionLabel): { pleasure: number; arousal: number; dominance: number; certainty: number; novelty: number } {
  switch (label) {
    case 'joy':            return { pleasure: 0.6,  arousal: 0.4,  dominance: 0.2,  certainty: 0.3,  novelty: 0.1 }
    case 'gratitude':      return { pleasure: 0.5,  arousal: 0.1,  dominance: -0.1, certainty: 0.3,  novelty: 0.0 }
    case 'pride':          return { pleasure: 0.5,  arousal: 0.3,  dominance: 0.5,  certainty: 0.4,  novelty: 0.1 }
    case 'anticipation':   return { pleasure: 0.3,  arousal: 0.5,  dominance: 0.1,  certainty: -0.2, novelty: 0.5 }
    case 'relief':         return { pleasure: 0.4,  arousal: -0.3, dominance: 0.2,  certainty: 0.5,  novelty: -0.1 }
    case 'anxiety':        return { pleasure: -0.5, arousal: 0.6,  dominance: -0.4, certainty: -0.6, novelty: 0.2 }
    case 'frustration':    return { pleasure: -0.5, arousal: 0.4,  dominance: -0.2, certainty: -0.1, novelty: -0.2 }
    case 'anger':          return { pleasure: -0.7, arousal: 0.8,  dominance: 0.3,  certainty: 0.2,  novelty: -0.1 }
    case 'sadness':        return { pleasure: -0.6, arousal: -0.4, dominance: -0.5, certainty: -0.2, novelty: -0.3 }
    case 'disappointment': return { pleasure: -0.5, arousal: -0.2, dominance: -0.3, certainty: -0.3, novelty: -0.2 }
    case 'confusion':      return { pleasure: -0.1, arousal: 0.2,  dominance: -0.4, certainty: -0.7, novelty: 0.3 }
    default:               return { pleasure: 0,    arousal: 0,    dominance: 0,    certainty: 0,    novelty: 0 }
  }
}

export const CORRECTION_WORDS = ['不对', '错了', '搞错', '理解错', '不是这样', '说反了', '别瞎说', 'wrong', '重来']
export const CORRECTION_EXCLUDE = ['没错', '不错', '对不对', '错了吗', '是不是错', '不对称', '不对劲', '错了错了我的', '你说得对', '没有错']

export const TECH_WORDS = ['代码', '函数', '报错', 'error', 'bug', 'crash', '编译', '调试', 'debug', '实现', '怎么写', 'hook', 'frida', 'ida']
export const CASUAL_WORDS = ['嗯', '好', '哦', '行', '可以', 'ok', '明白']

// patterns.ts classification lists (superset of above for some categories)
export const TECH_CLASSIFY = ['代码', 'code', '函数', 'bug', 'error', '实现', '怎么写', 'function', 'class', '报错']
export const EMOTION_CLASSIFY = ['烦', '累', '难过', '开心', '焦虑', '压力', '郁闷', '崩溃']
