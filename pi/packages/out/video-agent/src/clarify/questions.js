/**
 * 访谈题库。
 *
 * 结构：10 条固定题承载「风格界限」（情绪/风格/光线/色彩/节奏/镜头/结构/音乐/旁白/音效），
 * 全部确定性、人工策划、无 LLM；另外 5 条按需求定制的题目由 LLM 现场生成
 * （server 侧 tailoredQuestionsMessages），生成失败时降级使用本文件的
 * FALLBACK_TAILORED_QUESTIONS（通用创意决策题），保证访谈永远可走通。
 *
 * 双语：text / label / hint 均为中英可选（用户在 UI 切换 locale）；
 * promptTags 始终为英文 —— 注入下游生成 prompt（视频/图像模型对英文更稳）。
 */
export const QUESTIONS = [
    {
        id: "emotion",
        intentKey: "primaryEmotion",
        category: { zh: "情绪", en: "Emotion" },
        text: {
            zh: "观众看完这条广告，心里应该留下什么感受？",
            en: "What should viewers feel after watching?",
        },
        weight: "core",
        source: "fixed",
        options: [
            {
                id: "inspired",
                label: { zh: "激励振奋", en: "Inspired" },
                hint: {
                    zh: "看完就想动起来，开阔画面配上扬节奏",
                    en: "Makes you want to move — wide shots, rising rhythm",
                },
                promptTags: ["uplifting mood", "energizing", "aspirational"],
            },
            {
                id: "calm",
                label: { zh: "平静治愈", en: "Calm" },
                hint: {
                    zh: "松弛呼吸感，慢节奏，适合生活方式类",
                    en: "Relaxed breathing room, slow pace, great for lifestyle",
                },
                promptTags: ["calm mood", "soothing", "serene"],
            },
            {
                id: "excited",
                label: { zh: "兴奋刺激", en: "Excited" },
                hint: { zh: "多巴胺拉满，快剪、撞色、动感", en: "Dopamine rush — fast cuts, bold color, motion" },
                promptTags: ["exciting mood", "high energy", "thrilling"],
            },
            {
                id: "nostalgic",
                label: { zh: "怀旧温情", en: "Nostalgic" },
                hint: { zh: "旧时光滤镜，暖光、家人、回忆感", en: "Vintage filter, warm light, family memories" },
                promptTags: ["nostalgic mood", "warm-hearted", "sentimental"],
            },
            {
                id: "confident",
                label: { zh: "自信笃定", en: "Confident" },
                hint: { zh: "专业可靠感，克制、有力量", en: "Professional and reliable, restrained power" },
                promptTags: ["confident tone", "assured", "authoritative"],
            },
        ],
    },
    {
        id: "style",
        intentKey: "visualStyle",
        category: { zh: "风格", en: "Style" },
        text: { zh: "整体视觉气质走哪种路线？", en: "Which visual treatment fits?" },
        weight: "core",
        source: "fixed",
        options: [
            {
                id: "cinematic",
                label: { zh: "电影感", en: "Cinematic" },
                hint: { zh: "浅景深、宽画幅、电影级调色", en: "Shallow depth, wide framing, filmic grading" },
                promptTags: ["cinematic style", "shallow depth of field", "filmic color grading"],
            },
            {
                id: "lo-fi",
                label: { zh: "生活流 lo-fi", en: "Lo-fi" },
                hint: { zh: "手持、自然光、胶片颗粒的真实感", en: "Handheld, natural light, film-grain realism" },
                promptTags: ["lo-fi aesthetic", "handheld", "film grain"],
            },
            {
                id: "studio",
                label: { zh: "棚拍精修", en: "Studio" },
                hint: { zh: "无缝背景、完美布光、电商质感", en: "Seamless backdrop, perfect lighting, e-commerce polish" },
                promptTags: ["studio polish", "seamless backdrop", "commercial product lighting"],
            },
            {
                id: "documentary",
                label: { zh: "纪实跟拍", en: "Documentary" },
                hint: { zh: "真实场景不摆拍，抓拍质感", en: "Real scenes, no staging, candid texture" },
                promptTags: ["documentary style", "candid", "observational"],
            },
            {
                id: "motion-graphics",
                label: { zh: "动态图形", en: "Motion graphics" },
                hint: { zh: "MG 动画、字效、图形化转场", en: "Animated graphics, kinetic type, graphic transitions" },
                promptTags: ["motion graphics", "kinetic typography", "graphic transitions"],
            },
        ],
    },
    {
        id: "lighting",
        intentKey: "lighting",
        category: { zh: "光线", en: "Lighting" },
        text: { zh: "光线与氛围怎么定？", en: "How should light and mood feel?" },
        weight: "core",
        source: "fixed",
        options: [
            {
                id: "bright-daylight",
                label: { zh: "明亮日光", en: "Bright daylight" },
                hint: { zh: "通透干净，白天的清爽感", en: "Airy and clean, daytime freshness" },
                promptTags: ["bright daylight", "airy and clean", "high-key lighting"],
            },
            {
                id: "golden-hour",
                label: { zh: "黄金时刻", en: "Golden hour" },
                hint: { zh: "日落暖光、长影子、氛围感", en: "Sunset warmth, long shadows, atmosphere" },
                promptTags: ["golden hour", "warm sunset glow", "long shadows"],
            },
            {
                id: "studio-softbox",
                label: { zh: "柔光棚拍", en: "Softbox" },
                hint: { zh: "无影柔光，商品标准照的干净", en: "Shadowless soft light, catalog-clean" },
                promptTags: ["softbox lighting", "shadowless", "clean product lighting"],
            },
            {
                id: "dark-moody",
                label: { zh: "暗调质感", en: "Moody" },
                hint: { zh: "低调布光，明暗对比强烈", en: "Low-key, strong contrast, dramatic shadows" },
                promptTags: ["moody low-key lighting", "strong contrast", "dramatic shadows"],
            },
            {
                id: "neon-night",
                label: { zh: "霓虹夜色", en: "Neon night" },
                hint: { zh: "城市夜晚、霓虹光效、赛博感", en: "City night, neon glow, cyber edge" },
                promptTags: ["neon night", "city lights bokeh", "cyberpunk glow"],
            },
        ],
    },
    {
        id: "pacing",
        intentKey: "pacing",
        category: { zh: "节奏", en: "Pacing" },
        text: { zh: "时长与节奏选哪种？", en: "Pick length and rhythm:" },
        weight: "core",
        source: "fixed",
        options: [
            {
                id: "punchy-6s",
                label: { zh: "6 秒快剪", en: "Punchy 6s" },
                hint: { zh: "一镜一卖点，信息密度高", en: "One beat per shot, high density" },
                promptTags: ["punchy pacing", "fast cuts", "6-second spot"],
            },
            {
                id: "standard-15s",
                label: { zh: "15 秒标准", en: "Standard 15s" },
                hint: { zh: "起承转合完整的经典结构", en: "Classic structure, complete arc" },
                promptTags: ["standard pacing", "15-second spot", "clear beats"],
            },
            {
                id: "cinematic-30s",
                label: { zh: "30 秒电影感", en: "Cinematic 30s" },
                hint: { zh: "有铺垫、高潮与收尾的完整叙事", en: "Build-up, climax and resolution" },
                promptTags: ["cinematic pacing", "30-second spot", "build-up and payoff"],
            },
            {
                id: "multi-shot-60s",
                label: { zh: "60 秒多镜头", en: "Multi-shot 60s" },
                hint: { zh: "系列感、多场景组合", en: "Series feel, montage of scenes" },
                promptTags: ["multi-shot pacing", "60-second spot", "montage of scenes"],
            },
        ],
    },
    {
        id: "palette",
        intentKey: "colorPalette",
        category: { zh: "色彩", en: "Palette" },
        text: { zh: "色彩方向倾向哪种？", en: "Which color direction?" },
        weight: "core",
        source: "fixed",
        options: [
            {
                id: "brand-colors",
                label: { zh: "品牌色主导", en: "Brand colors" },
                hint: { zh: "以品牌 VI 色贯穿全片", en: "Brand hues carried through every shot" },
                promptTags: ["brand color palette", "consistent brand hues"],
            },
            {
                id: "warm-earth",
                label: { zh: "暖调大地", en: "Warm earth" },
                hint: { zh: "陶土、米色、大地色系", en: "Terracotta, beige, earthy tones" },
                promptTags: ["warm earth tones", "terracotta and beige"],
            },
            {
                id: "cool-minimal",
                label: { zh: "冷调极简", en: "Cool minimal" },
                hint: { zh: "黑白灰蓝，克制的性冷淡风", en: "Monochrome with blue accents, restrained" },
                promptTags: ["cool minimal palette", "monochrome with blue accents"],
            },
            {
                id: "high-contrast",
                label: { zh: "高对比撞色", en: "High contrast" },
                hint: { zh: "大胆撞色，视觉冲击力强", en: "Bold blocking, visual punch" },
                promptTags: ["high-contrast palette", "bold color blocking"],
            },
            {
                id: "muted-vintage",
                label: { zh: "低饱和复古", en: "Muted vintage" },
                hint: { zh: "褪色胶片感、低饱和", en: "Faded film look, desaturated" },
                promptTags: ["muted vintage palette", "desaturated film look"],
            },
        ],
    },
    {
        id: "camera",
        intentKey: "cameraLanguage",
        category: { zh: "镜头", en: "Camera" },
        text: { zh: "镜头语言偏好？", en: "Preferred camera language?" },
        weight: "refinement",
        source: "fixed",
        options: [
            {
                id: "static-locked",
                label: { zh: "固定机位", en: "Static locked" },
                hint: { zh: "稳定构图，极简克制", en: "Stable framing, minimal" },
                promptTags: ["static locked-off shots", "stable composition"],
            },
            {
                id: "slow-dolly",
                label: { zh: "缓慢推轨", en: "Slow dolly" },
                hint: { zh: "缓慢逼近，仪式感", en: "Gradual push-in, ceremony" },
                promptTags: ["slow dolly moves", "gradual push-in"],
            },
            {
                id: "handheld",
                label: { zh: "手持跟拍", en: "Handheld" },
                hint: { zh: "动感真实、有呼吸感", en: "Dynamic, breathing feel" },
                promptTags: ["handheld tracking", "organic camera movement"],
            },
            {
                id: "crane",
                label: { zh: "升降摇臂", en: "Crane" },
                hint: { zh: "大场面、垂直运动", en: "Sweeping vertical moves" },
                promptTags: ["crane shots", "sweeping vertical moves"],
            },
            {
                id: "dynamic-mix",
                label: { zh: "动静混搭", en: "Dynamic mix" },
                hint: { zh: "多种运镜组合，节奏变化", en: "Varied moves, rhythmic change" },
                promptTags: ["dynamic camera mix", "varied shot movement"],
            },
        ],
    },
    {
        id: "story",
        intentKey: "storyArc",
        category: { zh: "结构", en: "Story" },
        text: { zh: "故事结构用哪种？", en: "Which story arc?" },
        weight: "refinement",
        source: "fixed",
        options: [
            {
                id: "hook-product-cta",
                label: { zh: "钩子-产品-CTA", en: "Hook–product–CTA" },
                hint: { zh: "经典广告三段式", en: "Classic three-beat ad" },
                promptTags: ["hook-product-cta arc", "classic ad structure"],
            },
            {
                id: "problem-solution",
                label: { zh: "问题-解决", en: "Problem–solution" },
                hint: { zh: "痛点开场，产品解围", en: "Pain point opens, product resolves" },
                promptTags: ["problem-solution arc", "pain point opening"],
            },
            {
                id: "aesthetic-linger",
                label: { zh: "美学沉浸", en: "Aesthetic linger" },
                hint: { zh: "无情节，纯氛围流", en: "No plot, pure mood flow" },
                promptTags: ["aesthetic linger arc", "mood-driven flow"],
            },
            {
                id: "day-in-life",
                label: { zh: "一天的生活", en: "Day in life" },
                hint: { zh: "vlog 式时间线", en: "Vlog-style timeline" },
                promptTags: ["day-in-life arc", "vlog timeline"],
            },
            {
                id: "before-after",
                label: { zh: "前后对比", en: "Before–after" },
                hint: { zh: "变身/效果反差", en: "Transformation reveal" },
                promptTags: ["before-after arc", "transformation reveal"],
            },
        ],
    },
    {
        id: "music",
        intentKey: "music",
        category: { zh: "音乐", en: "Music" },
        text: { zh: "音乐底床用什么？", en: "What music bed fits?" },
        weight: "refinement",
        source: "fixed",
        options: [
            {
                id: "orchestral-uplift",
                label: { zh: "管弦激昂", en: "Orchestral uplift" },
                hint: { zh: "弦乐渐强，宏大叙事感", en: "Swelling strings, big narrative" },
                promptTags: ["orchestral uplift", "swelling strings"],
            },
            {
                id: "lofi-chillhop",
                label: { zh: "lo-fi 慵懒", en: "Lo-fi chillhop" },
                hint: { zh: "慵懒节拍，咖啡店氛围", en: "Laid-back beat, café vibe" },
                promptTags: ["lo-fi chillhop", "laid-back beat"],
            },
            {
                id: "synth-electronic",
                label: { zh: "电子合成", en: "Synth electronic" },
                hint: { zh: "合成器音色，未来感", en: "Synth textures, futuristic" },
                promptTags: ["synth electronic", "futuristic synth bed"],
            },
            {
                id: "acoustic-organic",
                label: { zh: "原声乐器", en: "Acoustic organic" },
                hint: { zh: "吉他/钢琴，人文温度", en: "Guitar and piano, human warmth" },
                promptTags: ["acoustic organic", "guitar and piano"],
            },
            {
                id: "none",
                label: { zh: "无音乐", en: "No music" },
                hint: { zh: "只留人声与环境音", en: "Voice and ambience only" },
                promptTags: ["no music bed"],
            },
        ],
    },
    {
        id: "voice",
        intentKey: "narratorVoice",
        category: { zh: "旁白", en: "Voice" },
        text: { zh: "旁白怎么处理？", en: "How should the narrator sound?" },
        weight: "refinement",
        source: "fixed",
        options: [
            {
                id: "warm-female",
                label: { zh: "温暖女声", en: "Warm female" },
                hint: { zh: "亲和、生活化的叙述", en: "Friendly, conversational" },
                promptTags: ["warm female narrator", "friendly voice-over"],
            },
            {
                id: "confident-male",
                label: { zh: "沉稳男声", en: "Confident male" },
                hint: { zh: "权威、有信任感", en: "Authoritative, trustworthy" },
                promptTags: ["confident male narrator", "authoritative voice-over"],
            },
            {
                id: "calm-androgynous",
                label: { zh: "中性冷静", en: "Calm androgynous" },
                hint: { zh: "克制、高级感", en: "Restrained, premium feel" },
                promptTags: ["calm androgynous narrator", "understated voice-over"],
            },
            {
                id: "no-vo",
                label: { zh: "无旁白", en: "No VO" },
                hint: { zh: "纯画面 + 文字 + 音乐叙事", en: "Visuals, text and music only" },
                promptTags: ["no voice-over", "visual storytelling only"],
            },
            {
                id: "multi-voice",
                label: { zh: "多人声", en: "Multi-voice" },
                hint: { zh: "对话体、多角色切换", en: "Dialogue, multiple characters" },
                promptTags: ["multi-voice narration", "dialogue-driven"],
            },
        ],
    },
    {
        id: "sound",
        intentKey: "soundDesign",
        category: { zh: "音效", en: "Sound" },
        text: { zh: "声音设计走哪种？", en: "What sound design?" },
        weight: "refinement",
        source: "fixed",
        options: [
            {
                id: "ambient-only",
                label: { zh: "纯环境音", en: "Ambient only" },
                hint: { zh: "现场声，沉浸感", en: "Location sound, immersion" },
                promptTags: ["ambient-only sound", "natural location audio"],
            },
            {
                id: "foley",
                label: { zh: "拟音音效", en: "Foley" },
                hint: { zh: "开盖声、冰块声等质感音效", en: "Cap clicks, ice clinks, texture" },
                promptTags: ["foley sound design", "crisp product sounds"],
            },
            {
                id: "musical-stings",
                label: { zh: "音乐点缀", en: "Musical stings" },
                hint: { zh: "关键帧的音乐重音", en: "Accent hits on key beats" },
                promptTags: ["musical stings", "accent hits on key beats"],
            },
            {
                id: "mixed",
                label: { zh: "混合", en: "Mixed" },
                hint: { zh: "环境 + 拟音 + 点缀全都要", en: "Ambience + foley + accents" },
                promptTags: ["mixed sound design", "layered audio"],
            },
        ],
    },
];
/**
 * 定制题的降级题库：LLM 生成失败时按顺序取 5 条顶上，
 * 覆盖「主体 / 参考气质 / 文字 / CTA / 手部」这些与品类强相关、
 * 本该由 LLM 针对需求定制（而固定题库不再覆盖）的通用决策。
 */
export const FALLBACK_TAILORED_QUESTIONS = [
    {
        intentKey: undefined,
        category: { zh: "主体", en: "Subject" },
        text: { zh: "镜头的主角是什么？", en: "What should the camera focus on?" },
        weight: "tailored",
        stage: "clips",
        options: [
            {
                id: "product-hero",
                label: { zh: "产品英雄", en: "Product hero" },
                hint: { zh: "产品是绝对主角，特写、环绕展示", en: "The product is the star — close-ups, orbiting reveals" },
                promptTags: ["product-hero focus", "hero close-ups", "orbiting product shots"],
            },
            {
                id: "lifestyle",
                label: { zh: "生活方式", en: "Lifestyle" },
                hint: { zh: "人在真实场景中使用产品", en: "People using the product in real life" },
                promptTags: ["lifestyle focus", "people using product", "in-context scenes"],
            },
            {
                id: "story",
                label: { zh: "故事叙事", en: "Story" },
                hint: { zh: "小情节、人物动机、有起因结果", en: "A mini plot with motive and payoff" },
                promptTags: ["narrative focus", "mini-story", "character-driven"],
            },
            {
                id: "craft",
                label: { zh: "工艺匠心", en: "Craft" },
                hint: { zh: "制作过程、细节手艺的特写", en: "Process shots, artisan detail close-ups" },
                promptTags: ["craftsmanship focus", "process shots", "artisan detail"],
            },
        ],
    },
    {
        intentKey: undefined,
        category: { zh: "参考", en: "Reference" },
        text: { zh: "想贴近哪个大牌的气质？", en: "Which brand energy to echo?" },
        weight: "tailored",
        stage: "visual",
        options: [
            {
                id: "apple",
                label: { zh: "Apple", en: "Apple" },
                hint: { zh: "极简、留白、产品崇拜", en: "Minimalism, negative space, product worship" },
                promptTags: ["Apple-like minimalism", "generous negative space"],
            },
            {
                id: "nike",
                label: { zh: "Nike", en: "Nike" },
                hint: { zh: "热血、运动、宣言式", en: "Athletic heat, declaration style" },
                promptTags: ["Nike-like energy", "sporty declaration"],
            },
            {
                id: "aesop",
                label: { zh: "Aesop", en: "Aesop" },
                hint: { zh: "文艺、质感、慢", en: "Editorial texture, slow refinement" },
                promptTags: ["Aesop-like refinement", "slow editorial texture"],
            },
            {
                id: "local-artisan",
                label: { zh: "本土匠人", en: "Local artisan" },
                hint: { zh: "手作、在地、真诚", en: "Handmade, local, sincere" },
                promptTags: ["local artisan feel", "handmade authenticity"],
            },
        ],
    },
    {
        intentKey: undefined,
        category: { zh: "文字", en: "Text" },
        text: { zh: "屏幕上的文字怎么用？", en: "How should on-screen text be used?" },
        weight: "tailored",
        stage: "export",
        options: [
            {
                id: "tagline-only",
                label: { zh: "仅 slogan", en: "Tagline only" },
                hint: { zh: "一句 slogan 点睛，其余靠画面", en: "One slogan card, visuals do the rest" },
                promptTags: ["tagline-only text", "single slogan card"],
            },
            {
                id: "beats-synced",
                label: { zh: "跟旁白同步", en: "Synced to VO" },
                hint: { zh: "字幕随节奏出现", en: "Captions land on beats" },
                promptTags: ["beats-synced captions", "rhythmic subtitles"],
            },
            {
                id: "none",
                label: { zh: "无文字", en: "No text" },
                hint: { zh: "纯画面叙事", en: "Pure visual storytelling" },
                promptTags: ["no on-screen text"],
            },
            {
                id: "headline-subhead",
                label: { zh: "标题+副标题", en: "Headline + subhead" },
                hint: { zh: "信息层级完整，适合卖点多的产品", en: "Full hierarchy for feature-rich products" },
                promptTags: ["headline and subhead", "layered text hierarchy"],
            },
        ],
    },
    {
        intentKey: undefined,
        category: { zh: "CTA", en: "CTA" },
        text: { zh: "行动号召（CTA）要多强？", en: "How strong should the CTA be?" },
        weight: "tailored",
        stage: "export",
        options: [
            {
                id: "soft",
                label: { zh: "软性", en: "Soft" },
                hint: { zh: "记住品牌就好，不打扰", en: "Brand recall only, no push" },
                promptTags: ["soft CTA", "brand recall only"],
            },
            {
                id: "medium",
                label: { zh: "中等", en: "Medium" },
                hint: { zh: "明确的行动提示", en: "Clear action prompt" },
                promptTags: ["medium CTA", "clear action prompt"],
            },
            {
                id: "hard",
                label: { zh: "强力", en: "Hard" },
                hint: { zh: "限时/紧迫感，促销风格", en: "Urgency and promo energy" },
                promptTags: ["hard CTA", "urgency-driven call to action"],
            },
            {
                id: "none",
                label: { zh: "无 CTA", en: "None" },
                hint: { zh: "纯品牌片，不引导行动", en: "Pure brand film, no ask" },
                promptTags: ["no call to action", "pure brand film"],
            },
        ],
    },
    {
        intentKey: undefined,
        category: { zh: "手部", en: "Hands" },
        text: { zh: "需要手部模特出镜吗？", en: "Should hands appear on camera?" },
        weight: "tailored",
        stage: "clips",
        options: [
            {
                id: "yes",
                label: { zh: "有手模", en: "Hand model" },
                hint: { zh: "手部出镜拿取/使用产品", en: "Hands hold and use the product" },
                promptTags: ["hand model present", "hands interacting with product"],
            },
            {
                id: "hands-only",
                label: { zh: "仅手部", en: "Hands only" },
                hint: { zh: "只出现手部特写，不见人脸", en: "Hand close-ups, no face" },
                promptTags: ["hands-only framing", "no face visible"],
            },
            {
                id: "no",
                label: { zh: "无手部", en: "No hands" },
                hint: { zh: "纯产品与场景，不出现手", en: "Product and scenes only" },
                promptTags: ["no hands in frame"],
            },
            {
                id: "abstract-suggestion",
                label: { zh: "抽象示意", en: "Abstract" },
                hint: { zh: "用光影/道具暗示触碰", en: "Light and props imply touch" },
                promptTags: ["abstract hand suggestion", "implied touch"],
            },
        ],
    },
];
/** 固定题数量（风格界限） */
export const FIXED_QUESTION_COUNT = QUESTIONS.length;
/** 定制题目标数量 */
export const TAILORED_QUESTION_COUNT = 5;
/** 题目总数上限（访谈轮次 = 固定 + 定制） */
export const QUESTION_COUNT = FIXED_QUESTION_COUNT + TAILORED_QUESTION_COUNT;
