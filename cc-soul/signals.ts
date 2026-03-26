/**
 * signals.ts — Shared keyword/signal lists
 *
 * Single source of truth for emotion, correction, tech, and casual keyword lists.
 * Used by cognition.ts, body.ts, and patterns.ts.
 */

export const EMOTION_POSITIVE = ['开心', '哈哈', '牛逼', '太棒', '感谢', '谢谢', '厉害', '完美']
export const EMOTION_NEGATIVE = ['烦', '累', '难过', '崩溃', '压力大', '焦虑']
export const EMOTION_ALL = [...EMOTION_NEGATIVE, ...EMOTION_POSITIVE]

export const CORRECTION_WORDS = ['不对', '错了', '搞错', '理解错', '不是这样', '说反了', '别瞎说', 'wrong', '重来']
export const CORRECTION_EXCLUDE = ['没错', '不错', '对不对', '错了吗', '是不是错', '不对称', '不对劲', '错了错了我的', '你说得对', '没有错']

export const TECH_WORDS = ['代码', '函数', '报错', 'error', 'bug', 'crash', '编译', '调试', 'debug', '实现', '怎么写', 'hook', 'frida', 'ida']
export const CASUAL_WORDS = ['嗯', '好', '哦', '行', '可以', 'ok', '明白']

// patterns.ts classification lists (superset of above for some categories)
export const TECH_CLASSIFY = ['代码', 'code', '函数', 'bug', 'error', '实现', '怎么写', 'function', 'class', '报错']
export const EMOTION_CLASSIFY = ['烦', '累', '难过', '开心', '焦虑', '压力', '郁闷', '崩溃']
