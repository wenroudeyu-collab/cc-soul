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
