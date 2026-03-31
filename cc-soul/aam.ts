/**
 * aam.ts — Adaptive Associative Memory (AAM)
 *
 * cc-soul 原创核心算法。纯 TypeScript，零依赖，不需要任何 embedding 模型。
 * 在个人记忆召回场景下达到甚至超越向量搜索的效果。
 *
 * 三层架构：
 *   Layer 1: 词关联网络 — 从用户数据自动学习语义关系
 *   Layer 2: 多键非线性召回 — Noisy-OR 多维度组合
 *   Layer 3: 赫布学习 — 从反馈中自动强化有效关联
 *
 * 认知科学基础：
 *   - Hebbian Learning: "neurons that fire together wire together"
 *   - Associative Memory: 记忆通过多维度关联访问，不是线性搜索
 *   - Noisy-OR: 多个独立线索的非线性组合
 */

import type { Memory } from './types.ts'
import { trigrams, trigramSimilarity } from './memory-utils.ts'
import { DATA_DIR, loadJson, debouncedSave } from './persistence.ts'
import { resolve } from 'path'
import { existsSync } from 'fs'

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 1: WORD ASSOCIATION NETWORK
// 从用户记忆中自动学习词语之间的语义关联
// "吃"和"减肥"共现 3 次 → 关联强度 3.2
// ═══════════════════════════════════════════════════════════════════════════════

const ASSOC_PATH = resolve(DATA_DIR, 'aam_associations.json')

interface AssociationNetwork {
  // word → { related_word → co-occurrence count }
  cooccur: Record<string, Record<string, number>>
  // word → total document frequency
  df: Record<string, number>
  totalDocs: number
  lastRebuild: number
}

let network: AssociationNetwork = loadJson<AssociationNetwork>(ASSOC_PATH, {
  cooccur: {}, df: {}, totalDocs: 0, lastRebuild: 0,
})

// ── Built-in synonyms for cold start (before enough user data accumulates) ──
const SYNONYMS_PATH = resolve(DATA_DIR, 'aam_synonyms.json')
const _defaultSynonyms: Record<string, string[]> = {
  '开心': ['高兴', '快乐', '愉快', '心情好', 'happy'],
  '高兴': ['开心', '快乐', '愉快'],
  '难过': ['伤心', '难受', '不开心', '心情差', 'sad'],
  '生气': ['愤怒', '发火', '恼火', 'angry'],
  '害怕': ['恐惧', '担心', '焦虑', '紧张'],
  '喜欢': ['爱', '偏好', '中意', '喜爱'],
  '讨厌': ['不喜欢', '烦', '受不了', '反感'],
  '吃': ['饮食', '食物', '餐', '菜', '美食', '零食'],
  '减肥': ['瘦身', '健身', '体重', '卡路里', '节食'],
  '工作': ['上班', '办公', '职场', '公司', '加班'],
  '学习': ['读书', '学', '课程', '教程', '知识'],
  '代码': ['编程', '开发', '写代码', '程序'],
  '睡觉': ['睡眠', '失眠', '休息', '早睡', '熬夜'],
  '运动': ['锻炼', '健身', '跑步', '游泳'],
  '旅行': ['旅游', '出行', '出差', '度假'],
  '电影': ['影片', '看电影', '影院'],
  '音乐': ['歌', '听歌', '唱歌'],
  '买': ['购买', '选购', '入手', '下单'],
  '贵': ['价格高', '不便宜', '昂贵'],
  '便宜': ['实惠', '性价比', '划算'],
  '好': ['不错', '棒', '优秀', '牛'],
  '差': ['烂', '垃圾', '不行', '糟糕'],
  '快': ['迅速', '效率高', '速度快'],
  '慢': ['缓慢', '效率低', '卡顿'],
  '大': ['庞大', '巨大', '很多'],
  '小': ['微小', '很少', '不多'],
  'Python': ['python', 'py', 'pip'],
  'JavaScript': ['js', 'node', 'npm', 'typescript', 'ts'],
  'Docker': ['docker', '容器', 'container', 'k8s'],
  'Git': ['git', 'github', 'gitlab', '版本控制'],
  'Linux': ['linux', 'ubuntu', 'centos', 'shell', 'bash'],
  'API': ['api', '接口', '请求', 'http', 'rest'],
  '数据库': ['sql', 'mysql', 'postgres', 'redis', 'mongo', 'sqlite'],
  '面试': ['interview', '简历', '求职', 'offer'],
  '房子': ['租房', '买房', '房价', '装修'],
  '孩子': ['小孩', '宝宝', '育儿', '教育'],
  '老婆': ['老公', '对象', '伴侣', '爱人'],
  '钱': ['收入', '工资', '花费', '预算', '存款'],
  '身体': ['健康', '体检', '生病', '医院'],

  // ── 情感表达（50组）──────────────────────────────────────────────────
  '愉快': ['愉悦', '舒畅', '心旷神怡', 'pleasant'],
  '幸福': ['美满', '幸运', '满足', '甜蜜', 'happiness'],
  '兴奋': ['激动', '亢奋', '热血沸腾', 'excited'],
  '惊喜': ['意外', '惊讶', '惊艳', 'surprise'],
  '感动': ['动容', '触动', '暖心', '泪目'],
  '满足': ['满意', '知足', '心满意足', 'satisfied'],
  '自信': ['底气', '有把握', '信心十足', 'confident'],
  '骄傲': ['自豪', '得意', '荣耀', 'proud'],
  '期待': ['盼望', '憧憬', '翘首以盼', '期望'],
  '感恩': ['感谢', '谢谢', '感激', 'grateful'],
  '轻松': ['放松', '舒适', '自在', '无压力'],
  '平静': ['安宁', '宁静', '淡定', '心如止水'],
  '勇敢': ['胆大', '无畏', '有胆量', 'brave'],
  '温暖': ['暖', '暖心', '温馨', 'warm'],
  '善良': ['好心', '善意', '心地好', 'kind'],
  '伤心': ['悲伤', '心碎', '心痛', '难过', 'heartbroken'],
  '愤怒': ['暴怒', '气炸', '怒火', '火大', 'furious'],
  '恐惧': ['害怕', '胆怯', '惊恐', 'fear'],
  '焦虑': ['紧张', '不安', '担忧', '心慌', 'anxiety'],
  '无聊': ['没意思', '乏味', '枯燥', 'boring'],
  '疲惫': ['累', '精疲力尽', '筋疲力尽', '体力不支'],
  '烦躁': ['烦', '心烦', '不耐烦', '烦死了', 'annoyed'],
  '尴尬': ['难为情', '窘迫', '丢脸', 'embarrassed'],
  '孤独': ['寂寞', '形单影只', '一个人', 'lonely'],
  '失望': ['心灰意冷', '泄气', '灰心', 'disappointed'],
  '后悔': ['懊悔', '追悔', '悔恨', '不该', 'regret'],
  '嫉妒': ['眼红', '羡慕嫉妒恨', '妒忌', 'jealous'],
  '内疚': ['愧疚', '自责', '过意不去', 'guilty'],
  '不安': ['忐忑', '惶恐', '心神不宁', 'uneasy'],
  '悲观': ['消极', '灰心', '看不到希望', 'pessimistic'],
  '绝望': ['无望', '走投无路', '万念俱灰', 'hopeless'],
  '委屈': ['受委屈', '冤枉', '心酸', '憋屈'],
  '崩溃': ['受不了', '绷不住', '精神崩溃', 'breakdown'],
  '抑郁': ['郁闷', '消沉', '低落', 'depression'],
  '迷茫': ['困惑', '不知所措', '茫然', 'confused'],
  '纠结': ['犹豫', '举棋不定', '左右为难', '拿不定主意'],
  '羡慕': ['眼红', '向往', '真好', 'envy'],
  '释然': ['放下', '想开了', '看开了', '释怀'],
  '怀念': ['想念', '思念', '挂念', 'miss'],
  '担心': ['操心', '忧虑', '挂心', 'worry'],
  '惭愧': ['羞愧', '无地自容', '汗颜'],
  '沮丧': ['颓废', '消沉', '低落', 'dejected'],
  '厌倦': ['腻了', '受够了', '厌烦', 'tired of'],
  '震惊': ['吃惊', '目瞪口呆', '难以置信', 'shocked'],
  '羞耻': ['丢人', '可耻', '没脸', 'shame'],
  '恐慌': ['慌张', '六神无主', '手忙脚乱', 'panic'],
  '欣慰': ['安慰', '宽慰', '放心'],
  '激动': ['热泪盈眶', '心潮澎湃', '情绪高涨'],
  '心疼': ['心痛', '舍不得', '怜惜', '疼惜'],

  // ── 日常生活（80组）──────────────────────────────────────────────────
  '喝': ['饮', '喝水', '饮料', '喝酒'],
  '睡': ['睡觉', '入睡', '躺下', '休息'],
  '走': ['步行', '走路', '散步', '溜达'],
  '跑': ['跑步', '慢跑', '冲刺', 'run', 'jogging'],
  '坐': ['坐下', '就坐', '落座'],
  '站': ['站立', '站起来', '起立'],
  '看': ['观看', '瞧', '瞅', '注视', '盯'],
  '听': ['倾听', '听到', '聆听'],
  '说': ['讲', '告诉', '说话', '聊'],
  '写': ['书写', '撰写', '写作', '码字'],
  '读': ['阅读', '看书', '朗读', '读书'],
  '洗': ['清洗', '洗涤', '冲洗', '洗澡'],
  '穿': ['穿衣', '搭配', '穿搭', '衣服'],
  '做饭': ['烹饪', '下厨', '炒菜', '煮饭', 'cook'],
  '打扫': ['清洁', '扫地', '拖地', '搞卫生'],
  '购物': ['买东西', '逛街', '剁手', 'shopping'],
  '旅游': ['旅行', '出游', '游玩', 'travel'],
  '聚会': ['派对', '聚餐', '轰趴', 'party'],
  '约会': ['见面', '约见', '相亲', 'date'],
  '加班': ['熬夜干活', '赶工', '超时工作', 'overtime'],
  '请假': ['休假', '告假', '放假', '歇班'],
  '迟到': ['晚了', '来不及', '赶不上'],
  '出差': ['差旅', '公出', '外派'],
  '洗澡': ['淋浴', '泡澡', '冲凉', 'shower'],
  '刷牙': ['漱口', '口腔清洁'],
  '化妆': ['美妆', '上妆', '打扮', 'makeup'],
  '理发': ['剪头发', '理发店', '发型', 'haircut'],
  '遛狗': ['溜狗', '带狗散步'],
  '喂猫': ['铲屎', '撸猫', '养猫'],
  '下单': ['下单购买', '网购', '买买买'],
  '退货': ['退款', '售后', '换货'],
  '签收': ['取快递', '收包裹', '收货'],
  '快递': ['包裹', '物流', '顺丰', '菜鸟'],
  '外卖': ['点外卖', '美团', '饿了么', '叫外卖'],
  '叫车': ['打车', '叫滴滴', '网约车', '出租车'],
  '排队': ['等位', '等候', '排号'],
  '预约': ['挂号', '预定', '订位', '预订'],
  '充值': ['充钱', '缴费', '续费', '付费'],
  '提现': ['取钱', '转账', '汇款'],
  '扫码': ['二维码', '扫一扫', '付款码'],
  '搬家': ['搬迁', '乔迁', '换地方'],
  '装修': ['翻新', '改造', '装潢', '施工'],
  '倒垃圾': ['扔垃圾', '垃圾分类'],
  '做家务': ['家务活', '干活', '打扫卫生'],
  '叫醒': ['闹钟', '起床', '早起', '赖床'],
  '熬夜': ['晚睡', '通宵', '夜猫子', '失眠'],
  '午休': ['午睡', '小憩', '打个盹'],
  '散步': ['溜达', '走走', '逛逛'],
  '晨跑': ['晨练', '早起运动', '跑步'],
  '锻炼': ['健身', '运动', '练', 'workout'],
  '做瑜伽': ['瑜伽', '拉伸', '冥想', 'yoga'],
  '游泳': ['泡泳池', '蛙泳', '自由泳', 'swim'],
  '骑车': ['骑自行车', '单车', '骑行', 'cycling'],
  '爬山': ['登山', '徒步', '远足', 'hiking'],
  '钓鱼': ['垂钓', '钓', '钓鱼佬', 'fishing'],
  '唱歌': ['K歌', '唱K', 'KTV', 'karaoke'],
  '跳舞': ['舞蹈', '蹦迪', '跳', 'dance'],
  '拍照': ['拍摄', '摄影', '照相', 'photo'],
  '刷手机': ['刷抖音', '刷微博', '刷视频', '摸鱼'],
  '看剧': ['追剧', '刷剧', '看电视剧', '煲剧'],
  '打游戏': ['玩游戏', '开黑', '上分', 'gaming'],
  '聊天': ['聊', '侃', '吹牛', '闲聊'],
  '吵架': ['争吵', '吵', '闹矛盾', '拌嘴'],
  '道歉': ['认错', '说对不起', '赔不是', 'apologize'],
  '搬砖': ['干活', '打工', '苦力'],
  '带娃': ['带孩子', '看孩子', '陪娃'],
  '遛弯': ['散步', '溜达', '走走'],
  '赶飞机': ['赶航班', '去机场', '登机'],
  '堵车': ['塞车', '交通拥堵', '路上堵'],
  '停车': ['找车位', '泊车', '停车场'],
  '加油': ['充电', '加满', '油费', '电费'],
  '修车': ['汽车维修', '保养', '4S店'],
  '看病': ['就医', '去医院', '看医生', '挂号'],
  '配眼镜': ['验光', '近视', '眼镜店'],
  '办证': ['办手续', '证件', '审批'],
  '缴税': ['报税', '个税', '税务'],

  // ── 工作职场（50组）──────────────────────────────────────────────────
  '简历': ['CV', '履历', '个人简介', 'resume'],
  '工资': ['薪资', '薪水', '月薪', '年薪', 'salary'],
  '加薪': ['涨薪', '调薪', '涨工资', '提薪'],
  '升职': ['晋升', '提拔', '升官', 'promotion'],
  '离职': ['辞职', '走人', '跑路', '不干了'],
  '跳槽': ['换工作', '换公司', '另谋高就'],
  '同事': ['同僚', '搭档', '队友', 'colleague'],
  '老板': ['领导', '上司', '主管', 'boss'],
  '项目': ['工程', '需求', '任务', 'project'],
  '会议': ['开会', '例会', '会', 'meeting'],
  '绩效': ['考核', '评估', 'KPI', 'performance'],
  'KPI': ['指标', '绩效', '目标', 'OKR'],
  '汇报': ['报告', '述职', '总结', 'report'],
  '培训': ['培训课', '内训', '学习', 'training'],
  '实习': ['实习生', '实习期', 'intern', 'internship'],
  '裁员': ['裁人', '优化', '毕业', 'layoff'],
  '入职': ['报到', '入职日', '上班第一天', 'onboarding'],
  '试用期': ['考察期', '转正', '试用'],
  '转正': ['正式员工', '过了试用期', '通过考核'],
  '甲方': ['客户', '客户方', '需求方'],
  '乙方': ['供应商', '外包', '服务方'],
  '需求': ['需求文档', 'PRD', '产品需求', '功能需求'],
  '排期': ['计划', '时间表', '里程碑', 'schedule'],
  '上线': ['发布', '上线部署', '推送', 'release'],
  '周报': ['日报', '月报', '进度汇报'],
  '团队': ['小组', '部门', '组', 'team'],
  'HR': ['人事', '人力资源', '招聘'],
  '福利': ['五险一金', '年终奖', '奖金', '补贴'],
  '年假': ['带薪假', '假期', '休假', '放假'],
  '出勤': ['打卡', '签到', '考勤'],
  '早退': ['提前走', '先走了'],
  '加班费': ['加班工资', '补贴', '调休'],
  '调休': ['补休', '换休', '倒休'],
  '年终奖': ['年终', '十三薪', '双薪'],
  '股权': ['期权', '股票期权', 'RSU', 'option'],
  '创业': ['创业公司', '初创', 'startup', '自己干'],
  '融资': ['风投', 'VC', '投资', 'funding'],
  '上市': ['IPO', '敲钟', '市值'],
  'PPT': ['幻灯片', '演示文稿', 'slide', '做PPT'],
  '方案': ['提案', '计划书', '策划'],
  '复盘': ['回顾', '反思', '事后总结', 'retrospective'],
  '协作': ['合作', '配合', '协同', 'collaboration'],
  '沟通': ['交流', '对接', '拉通', 'communication'],
  '摸鱼': ['划水', '偷懒', '磨洋工', '带薪拉屎'],
  '内卷': ['卷', '过度竞争', '996'],
  '躺平': ['佛系', '随缘', '不卷了'],
  '背锅': ['背黑锅', '替罪羊', '甩锅'],
  '跑路': ['溜了', '闪人', '开溜'],

  // ── 技术编程（60组）──────────────────────────────────────────────────
  'Go': ['golang', 'goroutine', 'channel', 'go语言'],
  'Rust': ['rust', 'cargo', 'crate', 'borrow checker'],
  'Java': ['java', 'jvm', 'spring', 'maven', 'gradle'],
  'C++': ['cpp', 'c plus plus', '指针', 'stl'],
  'Swift': ['swift', 'swiftui', 'xcode', 'ios开发'],
  'PHP': ['php', 'laravel', 'composer', 'wordpress'],
  'Ruby': ['ruby', 'rails', 'gem', 'rake'],
  'React': ['react', 'jsx', 'hooks', 'redux', '前端框架'],
  'Vue': ['vue', 'vuex', 'nuxt', 'vue3'],
  'Angular': ['angular', 'rxjs', 'ngrx', 'ng'],
  'TypeScript': ['ts', 'typescript', '类型', '泛型'],
  'SQL': ['sql', '查询', 'SELECT', 'JOIN', '数据库查询'],
  'Redis': ['redis', '缓存', 'cache', 'key-value'],
  'MongoDB': ['mongo', 'nosql', '文档数据库', 'mongoose'],
  'PostgreSQL': ['pg', 'postgres', '关系型数据库', 'psql'],
  'MySQL': ['mysql', 'mariadb', '关系型数据库'],
  'SQLite': ['sqlite', 'sqlite3', '嵌入式数据库', '轻量数据库'],
  'Kubernetes': ['k8s', 'kubectl', 'pod', 'helm', '容器编排'],
  'HTTP': ['http', 'https', '请求', '响应', 'status code'],
  'REST': ['restful', 'rest api', '接口设计'],
  'GraphQL': ['graphql', 'query', 'mutation', 'schema'],
  'gRPC': ['grpc', 'protobuf', 'rpc'],
  '前端': ['frontend', '页面', 'HTML', 'CSS', 'UI'],
  '后端': ['backend', '服务端', '接口', 'server'],
  '全栈': ['fullstack', '前后端', '全栈开发'],
  '算法': ['algorithm', '数据结构', '刷题', 'leetcode'],
  '数据结构': ['链表', '树', '图', '哈希表', '栈', '队列'],
  '部署': ['deploy', '上线', '发布', '运维', 'CI/CD'],
  '调试': ['debug', '排查', '定位', '断点'],
  'bug': ['缺陷', '问题', '故障', '报错', 'issue'],
  '代码审查': ['code review', 'CR', '审代码', 'review'],
  '重构': ['refactor', '优化代码', '重写', '改善'],
  '框架': ['framework', '库', '中间件', 'library'],
  '微服务': ['microservice', '服务拆分', '分布式', 'SOA'],
  '消息队列': ['MQ', 'Kafka', 'RabbitMQ', '队列'],
  '负载均衡': ['load balancer', 'nginx', '反向代理', 'LB'],
  '监控': ['monitoring', '告警', 'Prometheus', 'Grafana'],
  '日志': ['log', '日志系统', 'ELK', '日志分析'],
  '测试': ['test', '单元测试', '集成测试', 'QA', '自动化测试'],
  '性能': ['performance', '优化', '并发', '响应时间'],
  '安全': ['security', '漏洞', '加密', '认证', '鉴权'],
  '架构': ['architecture', '设计模式', '系统设计'],
  '云服务': ['AWS', '阿里云', '腾讯云', 'Azure', 'GCP'],
  '服务器': ['server', '主机', 'VPS', '云主机'],
  'Shell': ['bash', 'zsh', '终端', 'terminal', '命令行'],
  '正则': ['regex', '正则表达式', '匹配', 'pattern'],
  '爬虫': ['spider', 'crawler', '抓取', 'scrape'],
  '机器学习': ['ML', '深度学习', 'AI', '模型', '训练'],
  '大模型': ['LLM', 'GPT', 'Claude', 'transformer', '大语言模型'],
  '向量': ['embedding', '向量数据库', 'vector', 'FAISS'],
  'Nginx': ['nginx', '反向代理', '负载均衡', 'web服务器'],
  '版本控制': ['git', 'svn', '分支', 'merge', 'commit'],
  'CI/CD': ['持续集成', '持续部署', 'pipeline', 'Jenkins', 'GitHub Actions'],
  '容器': ['docker', '镜像', 'image', 'dockerfile'],
  'ORM': ['orm', 'ActiveRecord', 'SQLAlchemy', 'Prisma'],
  '缓存': ['cache', 'Redis', 'CDN', '浏览器缓存'],
  '并发': ['多线程', '多进程', '异步', 'async', 'goroutine'],
  '网络': ['TCP', 'UDP', 'DNS', 'IP', 'socket', '网络协议'],
  '加密': ['encryption', 'RSA', 'AES', 'HTTPS', '签名'],
  '开源': ['open source', 'GitHub', '社区', 'MIT', 'Apache'],

  // ── 健康医疗（40组）──────────────────────────────────────────────────
  '头疼': ['头痛', '偏头痛', '脑袋疼', 'headache'],
  '感冒': ['着凉', '流感', '鼻塞', '打喷嚏', 'cold'],
  '发烧': ['发热', '高烧', '低烧', '体温高', 'fever'],
  '咳嗽': ['咳', '干咳', '嗓子痒', 'cough'],
  '过敏': ['皮肤痒', '过敏反应', '花粉过敏', 'allergy'],
  '失眠': ['睡不着', '难以入睡', '翻来覆去', 'insomnia'],
  '体检': ['检查', '检查身体', '年度体检', '健康检查'],
  '手术': ['开刀', '做手术', '微创', 'surgery'],
  '药': ['吃药', '用药', '处方药', '药物', 'medicine'],
  '减肥药': ['减肥产品', '瘦身药', '代餐'],
  '蛋白质': ['protein', '鸡胸肉', '蛋白'],
  '碳水': ['碳水化合物', '主食', '糖', 'carb'],
  '脂肪': ['油脂', '肥肉', '卡路里', 'fat'],
  '维生素': ['维C', '维D', 'vitamin', '营养素'],
  '血压': ['高血压', '低血压', '量血压', '血压计'],
  '血糖': ['高血糖', '低血糖', '糖尿病', '测血糖'],
  '胃疼': ['胃痛', '胃病', '消化不良', '胃炎'],
  '拉肚子': ['腹泻', '肠胃炎', '水土不服', 'diarrhea'],
  '便秘': ['排便困难', '肠道不通', '通便'],
  '腰疼': ['腰痛', '腰酸', '腰椎', '久坐'],
  '颈椎': ['颈椎病', '脖子疼', '肩颈', '落枕'],
  '近视': ['视力', '眼镜', '散光', '矫正'],
  '牙疼': ['牙痛', '蛀牙', '智齿', '看牙'],
  '打针': ['注射', '打点滴', '输液', '疫苗'],
  '中药': ['中医', '汤药', '针灸', '草药'],
  '西药': ['西医', '抗生素', '消炎药'],
  '核酸': ['核酸检测', '抗原', '检测'],
  '健身房': ['gym', '撸铁', '器械', '私教'],
  '跑步机': ['椭圆机', '动感单车', '有氧器械'],
  '营养': ['营养搭配', '膳食', '饮食均衡', 'nutrition'],
  '热量': ['卡路里', 'kcal', '热量摄入', '基础代谢'],
  '体重': ['称重', '秤', '体脂', 'BMI'],
  '塑形': ['身材', '增肌', '线条', '马甲线'],
  '拉伸': ['柔韧性', '筋膜', '泡沫轴', 'stretching'],
  '心率': ['心跳', '脉搏', '有氧心率', '运动手表'],
  '保健品': ['补品', '保健', '膳食补充剂'],
  '康复': ['复健', '理疗', '恢复', 'rehab'],
  '挂号': ['预约挂号', '网上挂号', '排号'],
  '医保': ['医疗保险', '报销', '社保卡'],
  '处方': ['处方药', '医嘱', '开药'],

  // ── 教育学习（30组）──────────────────────────────────────────────────
  '考试': ['考', '测试', '笔试', 'exam'],
  '英语': ['English', '口语', '听力', '四六级', '雅思'],
  '数学': ['math', '高数', '微积分', '线性代数'],
  '论文': ['paper', '毕业论文', '学术', '期刊'],
  '课程': ['课', '网课', '公开课', 'course'],
  '大学': ['本科', '高校', '学校', 'university'],
  '研究生': ['硕士', '读研', '考研', '研一'],
  '留学': ['出国', '留学申请', '海外', 'study abroad'],
  '证书': ['认证', '考证', '资格证', '证'],
  '刷题': ['做题', '练习', '题库', 'leetcode'],
  '考研': ['研究生考试', '备考', '考研党'],
  '考公': ['公务员考试', '事业编', '国考', '省考'],
  '雅思': ['IELTS', '出国考试', '语言考试'],
  '托福': ['TOEFL', '留学考试', '英语考试'],
  'GPA': ['绩点', '成绩', '学分'],
  '毕业': ['毕业典礼', '答辩', '毕业季'],
  '学费': ['tuition', '教育费用', '书费'],
  '奖学金': ['scholarship', '助学金', '补助'],
  '导师': ['mentor', '老师', '教授', '指导'],
  '实验室': ['lab', '实验', '科研'],
  '图书馆': ['library', '自习室', '阅览室'],
  '网课': ['在线课程', '直播课', '录播课', 'MOOC'],
  '编程课': ['编程培训', '编程学习', '代码训练营', 'bootcamp'],
  '学历': ['文凭', '学位', '本科', '硕士'],
  '辅导': ['补课', '家教', '辅导班', '培优'],
  '笔记': ['课堂笔记', '学习笔记', '记录', 'note'],
  '复习': ['温习', '回顾', '备考', 'review'],
  '预习': ['提前学', '自学'],
  '作业': ['homework', '练习', '作业本', '写作业'],
  '阅读': ['精读', '泛读', '看书', '读'],

  // ── 财务理财（30组）──────────────────────────────────────────────────
  '收入': ['进账', '入账', '到手', 'income'],
  '花费': ['开销', '支出', '消费', 'expense'],
  '房贷': ['月供', '按揭', '贷款', 'mortgage'],
  '信用卡': ['刷卡', '还款', '账单', '信用额度'],
  '基金': ['定投', '指数基金', '理财产品', 'fund'],
  '股票': ['炒股', '股市', 'A股', '美股', 'stock'],
  '保险': ['投保', '保单', '理赔', 'insurance'],
  '养老': ['养老金', '退休金', '退休', 'pension'],
  '公积金': ['住房公积金', '提取公积金', '公积金贷款'],
  '存款': ['储蓄', '定期', '活期', '存钱'],
  '投资': ['理财', '增值', '资产配置', 'invest'],
  '理财': ['财务管理', '资产管理', '钱生钱'],
  '利息': ['利率', '年化', '收益率', 'interest'],
  '贷款': ['借钱', '借贷', '分期', 'loan'],
  '还款': ['还钱', '还贷', '月供'],
  '账单': ['对账', '流水', '明细', 'bill'],
  '预算': ['花费计划', '开支预算', 'budget'],
  '省钱': ['节省', '节约', '省着花'],
  '负债': ['欠钱', '欠款', '负资产', 'debt'],
  '记账': ['账本', '记录支出', '账目'],
  '税': ['个税', '所得税', '税率', 'tax'],
  '汇率': ['外汇', '换汇', '美元', '汇兑'],
  '比特币': ['BTC', '加密货币', 'crypto', '币圈'],
  '数字货币': ['虚拟货币', 'USDT', '区块链'],
  '定投': ['基金定投', '定期投资', '长期持有'],
  '分红': ['股息', '红利', '派息', 'dividend'],
  '亏损': ['亏钱', '赔钱', '浮亏', 'loss'],
  '盈利': ['赚钱', '盈余', '回报', 'profit'],
  '通胀': ['通货膨胀', '物价上涨', '贬值', 'inflation'],
  '财务自由': ['FIRE', '经济自由', '退休自由'],

  // ── 家庭关系（30组）──────────────────────────────────────────────────
  '爸爸': ['父亲', '爹', '老爸', '老爹', 'dad'],
  '妈妈': ['母亲', '娘', '老妈', 'mom'],
  '老公': ['丈夫', '先生', '另一半', 'husband'],
  '儿子': ['男孩', '小子', '崽', 'son'],
  '女儿': ['女孩', '闺女', '丫头', 'daughter'],
  '哥哥': ['兄', '大哥', '老哥', 'brother'],
  '姐姐': ['姐', '大姐', '老姐', 'sister'],
  '弟弟': ['弟', '小弟', '老弟'],
  '妹妹': ['妹', '小妹', '妹子'],
  '爷爷': ['祖父', '外公', '姥爷', 'grandfather'],
  '奶奶': ['祖母', '外婆', '姥姥', 'grandmother'],
  '朋友': ['好友', '哥们', '闺蜜', '伙伴', 'friend'],
  '同学': ['同窗', '校友', '学长', '学姐', 'classmate'],
  '邻居': ['隔壁', '邻里', '楼上楼下', 'neighbor'],
  '亲戚': ['亲属', '家人', '家族'],
  '叔叔': ['大叔', '舅舅', '伯伯', 'uncle'],
  '阿姨': ['大姨', '姑姑', '婶婶', 'aunt'],
  '宝宝': ['小婴儿', '娃娃', '宝贝', 'baby'],
  '父母': ['爸妈', '双亲', '家长', 'parents'],
  '家人': ['家庭', '家族', '家里人', 'family'],
  '情侣': ['男女朋友', '对象', '恋人', 'couple'],
  '前任': ['前男友', '前女友', '前对象', 'ex'],
  '暗恋': ['单恋', '暗恋对象', '悄悄喜欢'],
  '表白': ['告白', '说喜欢', '追', 'confess'],
  '分手': ['分了', '散了', '掰了', 'break up'],
  '结婚': ['婚礼', '领证', '嫁/娶', 'marry'],
  '离婚': ['离了', '分开', '离异', 'divorce'],
  '婆媳': ['婆婆', '儿媳', '婆媳关系'],
  '育儿': ['养娃', '带孩子', '教育孩子', 'parenting'],
  '陪伴': ['在一起', '陪', '相伴', 'companion'],

  // ── 住房出行（30组）──────────────────────────────────────────────────
  '租房': ['租', '房租', '合租', '整租', 'rent'],
  '买房': ['购房', '首付', '房产', '新房'],
  '房价': ['房价走势', '均价', '楼盘', '地段'],
  '地铁': ['地铁站', '换乘', '早高峰', 'subway'],
  '公交': ['公交车', '坐公交', '公交站', 'bus'],
  '打车': ['叫车', '出租车', '网约车', '滴滴'],
  '开车': ['自驾', '驾驶', '驾车', 'drive'],
  '高铁': ['火车', '动车', '铁路', '12306'],
  '飞机': ['航班', '机票', '登机', '航空', 'flight'],
  '酒店': ['宾馆', '民宿', '住宿', 'hotel'],
  '车位': ['停车位', '停车场', '地下车库'],
  '物业': ['物业费', '物业管理', '业主委员会'],
  '二手房': ['二手', '存量房', '挂牌'],
  '学区房': ['学区', '划片', '对口学校'],
  '新房': ['期房', '现房', '样板间'],
  '首付': ['首付款', '付首付', '首付比例'],
  '贷款利率': ['房贷利率', 'LPR', '利率下调'],
  '通勤': ['上下班', '通勤时间', '距离'],
  '导航': ['地图', '百度地图', '高德', 'GPS'],
  '违章': ['罚单', '扣分', '超速', '闯红灯'],
  '驾照': ['驾驶证', '考驾照', '科目', '学车'],
  '电动车': ['电瓶车', '电动自行车', '充电'],
  '共享单车': ['哈啰', '美团单车', '青桔'],
  '限号': ['尾号限行', '单双号', '限行'],
  '路况': ['堵不堵', '路况信息', '拥堵'],
  '高速': ['高速公路', '收费站', 'ETC'],
  '签证': ['visa', '办签证', '签证申请'],
  '护照': ['passport', '办护照', '出境'],
  '行李': ['行李箱', '拉杆箱', '收拾行李', 'luggage'],
  '民宿': ['airbnb', '短租', '客栈'],

  // ── 饮食烹饪（30组）──────────────────────────────────────────────────
  '米饭': ['白饭', '大米', '蒸饭', 'rice'],
  '面条': ['面', '拉面', '意面', '挂面', 'noodle'],
  '火锅': ['涮锅', '自助火锅', '麻辣锅', 'hotpot'],
  '烧烤': ['撸串', 'BBQ', '烤串', '烤肉'],
  '咖啡': ['coffee', '拿铁', '美式', '星巴克', '瑞幸'],
  '奶茶': ['茶饮', '喜茶', '蜜雪冰城', '珍珠奶茶'],
  '啤酒': ['beer', '精酿', '扎啤', '冰啤'],
  '水果': ['fruit', '苹果', '香蕉', '橘子', '葡萄'],
  '蔬菜': ['青菜', '蔬', '菜', 'vegetable'],
  '肉': ['猪肉', '牛肉', '鸡肉', '羊肉', 'meat'],
  '鱼': ['鱼肉', '鱼类', '海鱼', '淡水鱼', 'fish'],
  '鸡蛋': ['蛋', '鸡蛋', '蛋类', 'egg'],
  '饺子': ['水饺', '包饺子', '蒸饺', 'dumpling'],
  '包子': ['馒头', '肉包', '蒸包'],
  '粥': ['稀饭', '八宝粥', '白粥'],
  '炒菜': ['炒', '爆炒', '清炒', '小炒'],
  '红烧': ['红烧肉', '红烧鱼', '焖煮'],
  '煲汤': ['炖汤', '汤', '老火汤', '靓汤'],
  '凉菜': ['凉拌', '冷盘', '拍黄瓜'],
  '甜点': ['dessert', '蛋糕', '甜品', '冰淇淋'],
  '零食': ['snack', '薯片', '饼干', '坚果'],
  '调料': ['酱油', '盐', '醋', '辣椒', 'seasoning'],
  '辣': ['辣椒', '麻辣', '微辣', '变态辣', 'spicy'],
  '酸': ['醋', '酸味', '柠檬', 'sour'],
  '甜': ['糖', '甜味', '蜂蜜', 'sweet'],
  '苦': ['苦味', '苦瓜', '苦口', 'bitter'],
  '点餐': ['点外卖', '外送', '配送'],
  '食堂': ['饭堂', '食堂饭', '工作餐'],
  '下厨': ['做饭', '自己做', '在家做'],
  '食谱': ['菜谱', '做法', '配方', 'recipe'],

  // ── 娱乐休闲（30组）──────────────────────────────────────────────────
  '电视剧': ['剧', '连续剧', '网剧', 'TV series'],
  '综艺': ['综艺节目', '真人秀', '选秀', 'variety show'],
  '动漫': ['动画', '番剧', '二次元', 'anime'],
  '小说': ['网文', '小说书', '看小说', 'novel'],
  '游戏': ['game', '手游', '端游', '主机游戏'],
  '摄影': ['拍照', '单反', '相机', 'photography'],
  '健身': ['gym', '力量训练', '有氧', '撸铁'],
  '瑜伽': ['yoga', '冥想', '拉伸', '正念'],
  '画画': ['绘画', '素描', '水彩', 'drawing'],
  '书法': ['毛笔', '练字', '字帖', 'calligraphy'],
  '乐器': ['吉他', '钢琴', '贝斯', '架子鼓'],
  '直播': ['live', '主播', '直播间', '带货'],
  '短视频': ['抖音', '快手', 'vlog', 'B站'],
  '播客': ['podcast', '播客节目', '有声'],
  '桌游': ['剧本杀', '狼人杀', '三国杀', 'board game'],
  '密室': ['密室逃脱', '沉浸式', '体验馆'],
  '露营': ['camping', '帐篷', '野餐', '户外'],
  '滑雪': ['skiing', '雪场', '滑板'],
  '潜水': ['diving', '浮潜', '深潜'],
  '冲浪': ['surfing', '浪', '水上运动'],
  '攀岩': ['climbing', '抱石', '岩壁'],
  '跑团': ['TRPG', '跑团游戏', 'DND'],
  '手办': ['模型', '盲盒', '潮玩', 'figure'],
  '追星': ['粉丝', '偶像', '饭圈', 'fan'],
  '演唱会': ['concert', '音乐节', '看演出', '现场'],
  '展览': ['展', '美术馆', '博物馆', 'exhibition'],
  'KTV': ['唱歌', 'K歌', '麦霸'],
  '麻将': ['棋牌', '打牌', '打麻将', '搓麻'],
  '剧本杀': ['剧本', '推理', '本格'],
  '宠物': ['猫', '狗', '宠物店', 'pet'],

  // ── 通用形容（40组）──────────────────────────────────────────────────
  '不错': ['挺好', '还行', '可以', '行'],
  '棒': ['赞', '厉害', '牛逼', '给力', 'awesome'],
  '糟糕': ['完蛋', '惨了', '坏了', '糟了'],
  '多': ['很多', '一大堆', '不少', '大量'],
  '少': ['不多', '很少', '稀少', '仅有'],
  '远': ['遥远', '很远', '路程长', 'far'],
  '近': ['很近', '附近', '不远', 'near'],
  '难': ['困难', '不容易', '费劲', 'difficult'],
  '简单': ['容易', '不难', '轻松', 'easy'],
  '复杂': ['麻烦', '繁琐', '复杂度高', 'complex'],
  '重要': ['关键', '要紧', '核心', 'important'],
  '有趣': ['好玩', '有意思', '有梗', 'interesting'],
  '热': ['炎热', '闷热', '高温', 'hot'],
  '冷': ['寒冷', '冰冷', '零下', 'cold'],
  '新': ['崭新', '最新', '全新', 'new'],
  '旧': ['老旧', '过时', '老的', 'old'],
  '高': ['很高', '偏高', '居高不下', 'high'],
  '低': ['偏低', '很低', '不高', 'low'],
  '长': ['很长', '冗长', '时间长', 'long'],
  '短': ['很短', '简短', '时间短', 'short'],
  '干净': ['整洁', '清爽', '一尘不染', 'clean'],
  '脏': ['肮脏', '不干净', '邋遢', 'dirty'],
  '漂亮': ['好看', '美丽', '颜值高', '养眼', 'beautiful'],
  '丑': ['难看', '丑陋', '不好看', 'ugly'],
  '聪明': ['智慧', '机灵', '脑子好使', 'smart'],
  '笨': ['蠢', '迟钝', '脑子不好使', 'stupid'],
  '安静': ['静', '清静', '安静一下', 'quiet'],
  '吵': ['嘈杂', '吵闹', '闹腾', 'noisy'],
  '忙': ['繁忙', '没空', '事情多', 'busy'],
  '闲': ['空闲', '没事', '有空', 'free'],
  '厚': ['厚实', '很厚', '厚重'],
  '薄': ['很薄', '薄薄的', '单薄'],
  '硬': ['坚硬', '很硬', '硬邦邦'],
  '软': ['柔软', '很软', '软绵绵'],
  '亮': ['明亮', '光亮', '发光', 'bright'],
  '暗': ['黑暗', '昏暗', '灰暗', 'dark'],
  '香': ['好闻', '香味', '芳香', 'fragrant'],
  '臭': ['难闻', '臭味', '恶臭', 'stink'],
  '正常': ['没毛病', '正常的', '一切正常', 'normal'],
  '奇怪': ['怪', '诡异', '不正常', '离谱', 'weird'],
}
let COLD_START_SYNONYMS: Record<string, string[]> = loadJson(SYNONYMS_PATH, _defaultSynonyms)
// 首次运行时保存默认值到文件
if (!existsSync(SYNONYMS_PATH)) {
  debouncedSave(SYNONYMS_PATH, COLD_START_SYNONYMS)
}

/**
 * Tokenize text into words for association network.
 * CJK: 2-3 char segments. English: 3+ letter words.
 */
function tokenize(text: string): string[] {
  const words: string[] = []
  // CJK: extract 2-char and 3-char segments using sliding window, then deduplicate
  // This balances between "whole word" and "n-gram" — catches both "减肥" and "面试"
  const cjkRaw = text.match(/[\u4e00-\u9fff]+/g) || []
  for (const seg of cjkRaw) {
    // 2-char words (step by 1, sliding window — the most common Chinese word length)
    for (let i = 0; i <= seg.length - 2; i++) {
      words.push(seg.slice(i, i + 2))
    }
    // Full 3-4 char segment if it exists (compound words like "减肥期", "面试官")
    if (seg.length >= 3 && seg.length <= 4) words.push(seg)
  }
  // English words (3+ letters)
  const enWords = text.match(/[a-zA-Z]{3,}/g) || []
  words.push(...enWords.map(w => w.toLowerCase()))
  // Deduplicate within this tokenization
  return [...new Set(words)]
}

// Stop words to filter out noise (CJK 2-grams that are grammatical, not semantic)
const STOPWORDS_PATH = resolve(DATA_DIR, 'aam_stopwords.json')
const _defaultStopWords = [
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们',
  '不', '有', '这', '那', '就', '也', '和', '但', '还', '都',
  '会', '能', '可以', '什么', '怎么', '为什么', '吗', '呢', '吧',
  '很', '太', '最', '比较', '非常', '一个', '一些', '一下',
  '被问', '问了', '到了', '试完', '完拿', '拿到', '期间', '多了',
  '二天', '太多', '班太', '第二', '上吃', '想学', '写了',
  '试被', '天称', '称重', '重涨', '涨了', '少吃', '点疼',
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was',
  'not', 'but', 'have', 'has', 'had', 'will', 'can', 'you', 'your',
]
const STOP_WORDS = new Set(loadJson<string[]>(STOPWORDS_PATH, _defaultStopWords))

function filterStopWords(words: string[]): string[] {
  return words.filter(w => !STOP_WORDS.has(w) && w.length >= 2)
}

/**
 * Feed a new memory into the association network.
 * Updates word co-occurrence counts.
 */
export function learnAssociation(content: string) {
  const words = filterStopWords(tokenize(content))
  const unique = [...new Set(words)]
  if (unique.length < 2) return

  network.totalDocs++

  // Update document frequency
  for (const w of unique) {
    network.df[w] = (network.df[w] || 0) + 1
  }

  // Update co-occurrence (all pairs within the same memory)
  for (let i = 0; i < unique.length; i++) {
    if (!network.cooccur[unique[i]]) network.cooccur[unique[i]] = {}
    for (let j = i + 1; j < unique.length; j++) {
      network.cooccur[unique[i]][unique[j]] = (network.cooccur[unique[i]][unique[j]] || 0) + 1
      // Bidirectional
      if (!network.cooccur[unique[j]]) network.cooccur[unique[j]] = {}
      network.cooccur[unique[j]][unique[i]] = (network.cooccur[unique[j]][unique[i]] || 0) + 1
    }
  }

  // Periodic save (every 10 documents)
  if (network.totalDocs % 10 === 0) {
    debouncedSave(ASSOC_PATH, network)
  }

  // PMI 强关联自动毕业到同义词表（全动态，不需要人工维护）
  // 每 50 个文档检查一次，发现 PMI > 2.5 的词对自动写入 aam_synonyms.json
  if (network.totalDocs >= 30 && network.totalDocs % 50 === 0) {
    graduateStrongAssociations()
  }
}

/**
 * PMI 强关联自动毕业：从共现网络中发现的强关联自动写入同义词表
 * 不需要人工维护 500 组同义词——系统自己从用户数据中学到
 * 同义词表是"活的"，会随着用户聊天自动增长
 */
function graduateStrongAssociations() {
  let graduated = 0
  for (const [w1, related] of Object.entries(network.cooccur)) {
    if (w1.length < 2) continue
    for (const [w2, count] of Object.entries(related)) {
      if (w2.length < 2 || count < 3) continue
      const p = pmi(w1, w2)
      if (p > 2.5) {  // 非常强的关联
        // 检查是否已在同义词表中
        const existing = COLD_START_SYNONYMS[w1]
        if (existing && existing.includes(w2)) continue
        // 自动加入
        if (!COLD_START_SYNONYMS[w1]) COLD_START_SYNONYMS[w1] = []
        COLD_START_SYNONYMS[w1].push(w2)
        graduated++
      }
    }
  }
  if (graduated > 0) {
    debouncedSave(SYNONYMS_PATH, COLD_START_SYNONYMS)
    console.log(`[cc-soul][aam] graduated ${graduated} strong associations to synonym table (total groups: ${Object.keys(COLD_START_SYNONYMS).length})`)
  }
}

/**
 * Get PMI (Pointwise Mutual Information) between two words.
 * PMI > 0 means they co-occur more than expected by chance.
 */
function pmi(w1: string, w2: string): number {
  const N = Math.max(1, network.totalDocs)
  const cooccurCount = network.cooccur[w1]?.[w2] || 0
  if (cooccurCount === 0) return 0
  const df1 = network.df[w1] || 1
  const df2 = network.df[w2] || 1
  // PMI = log2(P(w1,w2) / (P(w1) × P(w2)))
  const pmiVal = Math.log2((cooccurCount * N) / (df1 * df2))
  return Math.max(0, pmiVal) // Positive PMI only
}

/**
 * Expand a set of query words with semantically related words.
 * Uses learned co-occurrence + cold-start synonyms.
 */
/** 查询两个词的共现次数（供 hybridSimilarity 的 AAM 同义词融合用）*/
export function getCooccurrence(wordA: string, wordB: string): number {
  return network.cooccur[wordA]?.[wordB] ?? network.cooccur[wordB]?.[wordA] ?? 0
}

export function expandQuery(queryWords: string[], maxExpansion = 10): { word: string; weight: number }[] {
  const expanded: Map<string, number> = new Map()

  // Original words get weight 1.0
  for (const w of queryWords) expanded.set(w, 1.0)

  // Phase 1: Cold-start synonyms (always available)
  for (const w of queryWords) {
    const syns = COLD_START_SYNONYMS[w]
    if (syns) {
      for (const s of syns) {
        if (!expanded.has(s)) expanded.set(s, 0.6)  // synonym weight
      }
    }
  }

  // Phase 2: Learned associations (PMI-based)
  if (network.totalDocs >= 20) {  // need minimum data
    for (const w of queryWords) {
      const cooc = network.cooccur[w]
      if (!cooc) continue
      // Find top associated words by PMI
      const candidates: { word: string; pmiScore: number }[] = []
      for (const [other, _count] of Object.entries(cooc)) {
        if (expanded.has(other)) continue
        // Filter: skip 2-char CJK fragments that aren't real words
        // Real words: in synonym table, or df >= 3 (appeared in 3+ memories)
        if (other.length === 2 && /^[\u4e00-\u9fff]+$/.test(other)) {
          const isKnown = Object.keys(COLD_START_SYNONYMS).includes(other) ||
            Object.values(COLD_START_SYNONYMS).some(syns => syns.includes(other))
          if (!isKnown && (network.df[other] || 0) < 3) continue
        }
        const p = pmi(w, other)
        if (p > 1.5) candidates.push({ word: other, pmiScore: p })  // PMI > 1.5 = strong association
      }
      candidates.sort((a, b) => b.pmiScore - a.pmiScore)
      for (const c of candidates.slice(0, 3)) {
        // Weight proportional to PMI, capped at 0.8
        const weight = Math.min(0.8, c.pmiScore / 5)
        expanded.set(c.word, Math.max(expanded.get(c.word) || 0, weight))
      }
    }
  }

  // Sort by weight, take top N
  return [...expanded.entries()]
    .map(([word, weight]) => ({ word, weight }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, queryWords.length + maxExpansion)
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 2: MULTI-KEY NOISY-OR RETRIEVAL
// 每条记忆有多把钥匙，任何一把匹配有概率召回，多把同时匹配概率跳升
// ═══════════════════════════════════════════════════════════════════════════════

interface RecallKey {
  type: 'lexical' | 'temporal' | 'emotional' | 'entity' | 'behavioral' | 'factual' | 'causal' | 'sequence'
  match: (query: string, mem: Memory, ctx: AAMContext) => number  // 0-1 probability
}

export interface AAMContext {
  query: string
  expandedWords: { word: string; weight: number }[]
  mood: number
  timeSlot: string
  topicDomain: string
  recentTopics: string[]
  isCausalQuery: boolean
  userId?: string
}

// The 7 keys (stayable types of access)
const RECALL_KEYS: RecallKey[] = [
  // K1: Lexical — expanded word overlap (PMI-enhanced)
  {
    type: 'lexical',
    match: (query, mem, ctx) => {
      const memWords = new Set(filterStopWords(tokenize(mem.content)))
      let weightedHits = 0
      let totalWeight = 0
      for (const { word, weight } of ctx.expandedWords) {
        totalWeight += weight
        if (memWords.has(word)) weightedHits += weight
      }
      return totalWeight > 0 ? Math.min(1, weightedHits / totalWeight * 1.5) : 0
    },
  },

  // K2: Temporal — time proximity / recency
  {
    type: 'temporal',
    match: (_query, mem, _ctx) => {
      const ageDays = (Date.now() - (mem.lastAccessed || mem.ts)) / 86400000
      // Power law decay with gentle slope
      return 1 / (1 + ageDays / 30)
    },
  },

  // K3: Emotional — mood congruence
  {
    type: 'emotional',
    match: (_query, mem, ctx) => {
      if (mem.situationCtx?.mood === undefined) return 0.3
      const delta = Math.abs(ctx.mood - mem.situationCtx.mood)
      const congruence = Math.max(0, 1 - delta)
      // Flashbulb effect: high emotion intensity always boosts
      const flashbulb = (mem.emotionIntensity || 0) >= 0.7 ? 0.3 : 0
      return Math.min(1, congruence * 0.7 + flashbulb)
    },
  },

  // K4: Entity — shared named entities
  {
    type: 'entity',
    match: (query, mem, _ctx) => {
      // Extract capitalized words, CJK names (2-4 chars)
      const qEntities = new Set((query.match(/[\u4e00-\u9fff]{2,4}|[A-Z][a-z]+/g) || []).map(e => e.toLowerCase()))
      const mEntities = new Set((mem.content.match(/[\u4e00-\u9fff]{2,4}|[A-Z][a-z]+/g) || []).map(e => e.toLowerCase()))
      if (qEntities.size === 0) return 0.2
      let hits = 0
      for (const e of qEntities) if (mEntities.has(e)) hits++
      return Math.min(1, hits / qEntities.size)
    },
  },

  // K5: Behavioral — situational pattern match
  {
    type: 'behavioral',
    match: (_query, mem, ctx) => {
      let score = 0.2
      // Same topic domain
      const memContent = mem.content.toLowerCase()
      if (ctx.topicDomain && memContent.includes(ctx.topicDomain)) score += 0.3
      // Same time context as when memory was created
      if (mem.situationCtx?.attention && ctx.topicDomain) {
        if (mem.situationCtx.attention === 'technical' && /tech|code|python|docker|sql|api/i.test(ctx.topicDomain)) score += 0.2
      }
      // Recent topic continuity
      if (ctx.recentTopics.length > 0) {
        for (const topic of ctx.recentTopics) {
          if (memContent.includes(topic)) { score += 0.15; break }
        }
      }
      return Math.min(1, score)
    },
  },

  // K6: Factual — structured fact relevance
  {
    type: 'factual',
    match: (query, mem, _ctx) => {
      // User-stated facts are more trustworthy
      const sourceBoost = mem.source === 'user_said' ? 0.2 : 0
      // Memory has reasoning/because that matches query
      if (mem.because) {
        const qWords = new Set(filterStopWords(tokenize(query)))
        const bWords = filterStopWords(tokenize(mem.because))
        const hits = bWords.filter(w => qWords.has(w)).length
        if (hits > 0) return Math.min(1, 0.5 + hits * 0.15 + sourceBoost)
      }
      // Scope bonus: facts and preferences are inherently more relevant
      if (mem.scope === 'fact' || mem.scope === 'preference') return 0.4 + sourceBoost
      if (mem.scope === 'correction') return 0.45 + sourceBoost
      return 0.2 + sourceBoost
    },
  },

  // K7: Causal — reasoning chain match
  {
    type: 'causal',
    match: (query, mem, ctx) => {
      if (!ctx.isCausalQuery) return 0.15
      // "为什么" queries → memories with reasoning are gold
      if (mem.reasoning) {
        const rText = (mem.reasoning.context || '') + ' ' + (mem.reasoning.conclusion || '')
        const qWords = new Set(filterStopWords(tokenize(query)))
        const rWords = filterStopWords(tokenize(rText))
        const hits = rWords.filter(w => qWords.has(w)).length
        return Math.min(1, 0.3 + hits * 0.2 + mem.reasoning.confidence * 0.3)
      }
      if (mem.because) return 0.5
      return 0.15
    },
  },

  // K8: Sequence — conversation flow continuity (from MSAR S5)
  {
    type: 'sequence',
    match: (_query, mem, ctx) => {
      if (ctx.recentTopics.length === 0) return 0.3
      const memLower = mem.content.toLowerCase()
      // 检测记忆内容的领域
      let memDomain = ''
      const domainPatterns: [string, RegExp][] = [
        ['python', /python|\.py|pip|django|flask/],
        ['javascript', /javascript|node|react|vue|typescript/],
        ['go', /\bgo\b|golang|goroutine/],
        ['devops', /docker|k8s|nginx|deploy|容器/],
        ['database', /sql|数据库|mysql|redis|postgres/],
        ['career', /面试|简历|工作|职场|薪资/],
        ['health', /健康|减肥|睡眠|运动/],
        ['tech', /代码|函数|编程|bug|算法/],
      ]
      for (const [domain, re] of domainPatterns) {
        if (re.test(memLower)) { memDomain = domain; break }
      }
      if (!memDomain) return 0.2

      // 当前话题延续 → 高分
      if (memDomain === ctx.topicDomain) return 0.8
      // 最近话题中出现过 → 中分
      if (ctx.recentTopics.includes(memDomain)) return 0.6
      return 0.2
    },
  },

  // K9: Cognitive Field — CIN personality match (原创)
  {
    type: 'cognitive' as any,
    match: (_query, mem, ctx) => {
      try {
        // Lazy load CIN field
        const cin = require('./cin.ts')
        const field = cin.getFieldSummary()
        if (!field || !field.risk) return 0.3

        // Memory matches personality direction → higher recall probability
        // E.g., if user is "保守" and memory is about choosing stable tech → boost
        let score = 0.3
        const c = mem.content.toLowerCase()

        // Risk dimension
        if (field.risk.direction === '保守' && /稳定|成熟|可靠|传统/.test(c)) score += 0.2
        if (field.risk.direction === '冒险' && /新的|尝试|创新|突破/.test(c)) score += 0.2

        // Communication dimension
        if (field.communication.direction === '直接' && /直说|明确|简单/.test(c)) score += 0.1
        if (field.communication.direction === '委婉' && /可能|也许|大概/.test(c)) score += 0.1

        return Math.min(1, score)
      } catch { return 0.3 }
    },
  },
]

/**
 * Noisy-OR combination: P(recall) = 1 - Π(1 - Pi)
 * Unlike weighted sum, this has non-linear amplification:
 * - 1 key at 0.5 → P=0.5
 * - 2 keys at 0.5 → P=0.75 (not 0.5!)
 * - 3 keys at 0.5 → P=0.875
 * Multiple weak signals combine into a strong signal.
 */
/** AAM 自适应门槛：PMI 方差高=查询词关联弱=降低门槛；PMI 方差低=强关联=提高门槛 */
function computeAdaptiveThreshold(expandedWords: { word: string; weight: number }[]): number {
  if (expandedWords.length < 2) return 0.4  // 默认偏宽松
  const weights = expandedWords.map(e => e.weight)
  const mean = weights.reduce((s, w) => s + w, 0) / weights.length
  const variance = weights.reduce((s, w) => s + (w - mean) ** 2, 0) / weights.length
  // 高方差 → 宽松门槛（0.35，防遗漏），低方差 → 严格门槛（0.60，防假阳性）
  return 0.35 + 0.25 * (1 - Math.min(1, variance * 4))  // 范围 0.35-0.60
}

function noisyOR(probabilities: number[], activeThreshold: number = 0.5): number {
  // 门槛：至少 1 个 key > activeThreshold 才认为有效召回
  const activeKeys = probabilities.filter(p => p > activeThreshold).length
  if (activeKeys === 0) {
    // 没有强信号，用衰减的 Noisy-OR（防止多个弱信号叠加成假阳性）
    let product = 1
    for (const p of probabilities) {
      product *= (1 - Math.max(0, Math.min(1, p)) * 0.5)  // 衰减 50%
    }
    return 1 - product
  }
  // 正常 Noisy-OR
  let product = 1
  for (const p of probabilities) {
    product *= (1 - Math.max(0, Math.min(1, p)))
  }
  return 1 - product
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 3: HEBBIAN LEARNING
// "Neurons that fire together wire together"
// 有用的钥匙变强，没用的变弱
// ═══════════════════════════════════════════════════════════════════════════════

const KEY_WEIGHTS_PATH = resolve(DATA_DIR, 'aam_key_weights.json')

interface KeyWeights {
  // type → weight multiplier (default 1.0, range 0.3-3.0)
  weights: Record<string, number>
  feedbackCount: number
  lastUpdated: number  // 赫布时间衰减用
}

let keyWeights: KeyWeights = loadJson<KeyWeights>(KEY_WEIGHTS_PATH, {
  weights: {
    lexical: 1.0, temporal: 1.0, emotional: 1.0, entity: 1.0,
    behavioral: 1.0, factual: 1.0, causal: 1.0, sequence: 1.0, cognitive: 1.0,
  },
  feedbackCount: 0,
  lastUpdated: Date.now(),
})

function saveKeyWeights() { debouncedSave(KEY_WEIGHTS_PATH, keyWeights) }

/**
 * Hebbian update: strengthen keys that contributed to useful recall.
 */
export function hebbianUpdate(keyScores: Record<string, number>, wasUseful: boolean) {
  // ── 时间衰减：旧反馈影响逐渐减弱，向中性值 1.0 衰减 ──
  const now = Date.now()
  const hoursSinceLastUpdate = (now - (keyWeights.lastUpdated || now)) / 3600000
  if (hoursSinceLastUpdate > 1) {  // 至少过 1 小时才衰减
    const decayFactor = Math.exp(-hoursSinceLastUpdate / 168)  // 一周半衰期
    for (const key of Object.keys(keyWeights.weights)) {
      keyWeights.weights[key] = 1.0 + (keyWeights.weights[key] - 1.0) * decayFactor
    }
  }
  keyWeights.lastUpdated = now

  const lr = 0.05 / (1 + keyWeights.feedbackCount * 0.001)  // annealing learning rate
  keyWeights.feedbackCount++

  for (const [keyType, score] of Object.entries(keyScores)) {
    if (score < 0.2) continue  // key wasn't active, don't update
    const current = keyWeights.weights[keyType] || 1.0
    if (wasUseful) {
      // Hebbian 强化
      keyWeights.weights[keyType] = Math.min(3.0, current + lr * score)
    } else {
      // Anti-Hebbian 抑制：无用的高激活 key 惩罚更重
      // score 高但没用 = 假阳性 → 惩罚大
      // score 低且没用 = 本来就没参与 → 惩罚小
      const penalty = lr * score * (score > 0.5 ? 1.5 : 0.5)  // 高激活假阳性额外惩罚 1.5x
      keyWeights.weights[keyType] = Math.max(0.3, current - penalty)
    }
  }

  saveKeyWeights()
  antiHebbianDecay()
}

/**
 * Anti-Hebbian 关联抑制：削弱总是共现但从未有用的词关联
 * 人脑原理：竞争性学习——无用的连接被主动削弱，不只是被动衰减
 */
export function antiHebbianDecay() {
  // 每 100 次反馈后执行一次
  if (keyWeights.feedbackCount % 100 !== 0 || keyWeights.feedbackCount === 0) return

  // 找出关联网络中高共现但低 PMI 的词对（噪音关联）
  let pruned = 0
  for (const [w1, related] of Object.entries(network.cooccur)) {
    for (const [w2, count] of Object.entries(related)) {
      if (count < 3) continue  // 样本不够，不判定
      const pmiVal = pmi(w1, w2)
      if (pmiVal < 0.5 && count > 5) {
        // 高共现但低 PMI = 纯粹是因为都是常见词而共现，不是有意义的关联
        related[w2] = Math.max(1, Math.floor(count * 0.8))  // 衰减 20%
        pruned++
      }
    }
  }

  if (pruned > 0) {
    debouncedSave(ASSOC_PATH, network)
    console.log(`[cc-soul][aam] anti-Hebbian: pruned ${pruned} noise associations`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AAM RECALL — the main entry point
// ═══════════════════════════════════════════════════════════════════════════════

export interface AAMResult {
  memory: Memory
  score: number
  keyScores: Record<string, number>
  expansions: string[]  // which expanded words contributed
}

/**
 * AAM Recall: Adaptive Associative Memory retrieval.
 *
 * 1. Expand query words using learned associations + cold-start synonyms
 * 2. Score each memory using 7 keys (Noisy-OR combination)
 * 3. Apply Hebbian key weights
 * 4. Return top N results
 */
export function aamRecall(
  memories: Memory[],
  ctx: AAMContext,
  topN = 10,
): AAMResult[] {
  // Filter candidates
  let candidates = memories.filter(m =>
    m.scope !== 'expired' && m.scope !== 'decayed' && m.content.length > 5
  )

  // 热集合优化：大量记忆时先粗筛，只取最近激活的 top 500 做全量 Noisy-OR
  if (candidates.length > 5000) {
    candidates.sort((a, b) => ((b as any).lastAccessed || b.ts) - ((a as any).lastAccessed || a.ts))
    candidates = candidates.slice(0, 500)
  }

  if (candidates.length === 0) return []

  // Expand query
  const queryWords = filterStopWords(tokenize(ctx.query))
  const expanded = expandQuery(queryWords)
  ctx.expandedWords = expanded
  const expansionWords = expanded.filter(e => !queryWords.includes(e.word)).map(e => e.word)

  // Score each memory
  const scored: AAMResult[] = []

  for (const mem of candidates) {
    // Compute each key's match probability
    const keyScores: Record<string, number> = {}
    const probabilities: number[] = []

    for (const key of RECALL_KEYS) {
      const rawScore = key.match(ctx.query, mem, ctx)
      // Apply Hebbian weight
      const hebbianWeight = keyWeights.weights[key.type] || 1.0
      const adjustedScore = Math.min(1, rawScore * hebbianWeight)
      keyScores[key.type] = adjustedScore
      probabilities.push(adjustedScore)
    }

    // Noisy-OR combination with adaptive threshold
    const adaptiveThreshold = computeAdaptiveThreshold(expanded)
    const noisyOrScore = noisyOR(probabilities, adaptiveThreshold)

    // Skip very low scores early
    if (noisyOrScore < 0.15) continue

    // Confidence scaling (soft, not multiplicative kill)
    const conf = mem.confidence ?? 0.7
    const finalScore = noisyOrScore * (0.6 + conf * 0.4)

    scored.push({
      memory: mem,
      score: finalScore,
      keyScores,
      expansions: expansionWords,
    })
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score)

  return scored.slice(0, topN)
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build AAMContext from available information.
 */
export function buildAAMContext(
  query: string,
  mood = 0,
  timeSlot = 'afternoon',
  topicDomain = 'general',
  recentTopics: string[] = [],
  userId?: string,
): AAMContext {
  return {
    query,
    expandedWords: [],  // filled during aamRecall
    mood,
    timeSlot,
    topicDomain,
    recentTopics,
    isCausalQuery: /为什么|因为|原因|why|because|怎么回事|咋回事/.test(query),
    userId,
  }
}

/**
 * Explain why a memory was recalled (for debugging/transparency).
 */
export function explainAAM(result: AAMResult): string {
  const activeKeys = Object.entries(result.keyScores)
    .filter(([, v]) => v > 0.3)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v.toFixed(2)}`)
  const expWords = result.expansions.length > 0 ? ` [扩展词: ${result.expansions.slice(0, 3).join(',')}]` : ''
  return `score=${result.score.toFixed(3)} keys=[${activeKeys.join(', ')}]${expWords}`
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════════════

export function getAAMStats() {
  return {
    vocabularySize: Object.keys(network.df).length,
    totalDocs: network.totalDocs,
    associationPairs: Object.values(network.cooccur).reduce((s, v) => s + Object.keys(v).length, 0),
    coldStartSynonyms: Object.keys(COLD_START_SYNONYMS).length,
    keyWeights: { ...keyWeights.weights },
    feedbackCount: keyWeights.feedbackCount,
  }
}
