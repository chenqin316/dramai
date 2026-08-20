import type { Character, Material, Project } from '@/types/domain'
import { matchStylePreset } from '@/core/prompts/style-presets'

/**
 * 单个时间轴片段。
 *
 * 一个 StoryboardDraft 对应一个 Veo image-to-video 视频片段。
 * 每个片段最长 8 秒。
 */
export interface StoryboardTimelineItem {
  start_sec: number
  end_sec: number

  /**
   * 这一时间段内发生的动作。
   * 使用中文，方便用户在 DramAI 中直接修改。
   */
  action: string

  /**
   * 这一时间段内对应的旁白。
   * 可为空，例如等待孩子回答的停顿。
   */
  dialogue?: string
}

/**
 * 单个 Veo 视频分镜。
 *
 * 注意：
 * 这里的一个 shot 不再只是传统静态分镜。
 *
 * 一个 shot = 一张用户已有图片 + 一个最长 8 秒的 Veo 视频。
 */
export interface StoryboardDraft {
  /** 1-based 序号 */
  sequence: number

  /** 用户可编辑的整体画面描述 */
  scene_text: string

  /** 该视频片段的完整旁白 */
  narration?: string

  /**
   * 给文生图的提示词。
   *
   * 当前用户已经有图片，所以这个字段暂时保留兼容旧系统，
   * 不作为主要工作流。
   */
  image_prompt?: string

  /** 出场角色名称 */
  character_names?: string[]

  /**
   * 视频总时长。
   *
   * Veo 3.1 最大为 8 秒，因此必须 <= 8。
   */
  duration_sec: number

  /** 镜头要求，例如 Locked fixed camera */
  camera?: string

  /**
   * 精确时间轴。
   *
   * 所有时间轴片段必须：
   * - 从 0 开始
   * - 连续
   * - 最后一个 end_sec 等于 duration_sec
   */
  timeline: StoryboardTimelineItem[]

  /**
   * 第一帧规则。
   *
   * 用于告诉 Veo：
   * 用户上传/绑定的图片就是视频第一帧，
   * 必须保持原始构图。
   */
  first_frame_rule?: string

  /**
   * 最后一帧规则。
   *
   * 用于避免角色或重要物体在视频最后消失。
   */
  final_frame_rule?: string
}

interface BuildOptions {
  project: Project
  materials: Material[]
  characters: Character[]
  userPrompt: string

  /**
   * 兼容旧接口。
   *
   * 儿童教育视频模式下不建议强制指定固定分镜数。
   * LLM 应根据文案自然节奏自动决定。
   */
  targetShotCount?: number
}

const BASE_SYSTEM_PROMPT = `
你是一名专业的「儿童教育视频分镜导演」和「Image-to-Video 视频规划师」。

你的任务不是把故事简单压缩成 6 个普通分镜。

你的任务是把用户提供的完整儿童教育文案，拆分成多个适合 Image-to-Video 模型生成的视频片段。

最终这些视频将使用 Veo 3.1 生成。

==================================================
# 最核心的工作单位
==================================================

一个 shots[] 中的元素 = 一个独立的视频片段。

每个视频片段：

- 对应用户已经生成好的一张图片
- 这张图片将作为视频的第一帧
- 视频总时长最大为 8 秒
- 不需要重新设计或重新生成图片
- 主要任务是规划这张已有图片在视频中的动作和旁白
- 用户后续可以手动修改绑定的图片
- 不要假设自动绑定的图片一定完全符合镜头内容

==================================================
# 文案拆分规则
==================================================

必须阅读全部文案后再拆分。

不要默认输出固定 6 个分镜。

不要因为用户文案很长就压缩成少量大镜头。

必须按照自然朗读节奏、动作节奏和儿童观看节奏拆分。

一个视频片段最长 8 秒。

duration_sec 必须满足：

1 <= duration_sec <= 8

如果某段旁白和动作超过 8 秒，必须继续拆成新的 shot。

如果某一句非常短，例如：

"Wow!"
"Yes!"
"Great job!"

不要机械地单独生成一个 8 秒视频。

应根据上下文，将短句与前后动作合理合并。

==================================================
# 旁白和时间轴
==================================================

每个 shot 必须生成 timeline。

timeline 是一个数组。

每个时间轴对象包含：

- start_sec
- end_sec
- action
- dialogue（可选）

必须满足：

- 第一个 timeline.start_sec 必须是 0
- 时间轴连续
- 不允许重叠
- 最后一个 timeline.end_sec 必须等于 duration_sec
- 所有时间必须在 0 到 duration_sec 范围内

例如：

duration_sec = 8

timeline:

0–2 秒：
角色发现动物并表现惊喜

2–5 秒：
角色介绍动物

5–8 秒：
角色鼓励孩子跟读并等待回应

==================================================
# 已有图片规则
==================================================

用户已经提前生成了图片。

因此：

不要把当前任务理解为「为每个镜头设计新图片」。

不要要求生成新的场景。

不要随意改变角色位置。

不要随意添加新的背景。

不要让已有角色突然消失。

不要让已有角色突然出现。

不要假设某个角色必须从画外进入。

默认假设：

用户绑定的图片就是视频第一帧。

因此每个镜头需要生成：

first_frame_rule

默认表达：

"用户绑定的参考图片是视频的精确第一帧，保持原始构图、角色位置、角色比例、颜色和背景设计。"

==================================================
# 角色一致性
==================================================

如果已登记角色中存在锁定角色：

必须保持该角色的身份和视觉一致性。

不要重新设计角色。

不要改变：

- 颜色
- 身体比例
- 面部特征
- 毛发
- 眼睛
- 角
- 服装
- 基础造型

角色名称必须使用「已登记的角色」列表中的名称。

==================================================
# 儿童教育视频动作规则
==================================================

目标观众是低幼儿童。

动作应该：

- 清晰
- 缓慢
- 易理解
- 表情明显
- 自然
- 不要复杂连续舞蹈
- 不要快速镜头切换
- 不要混乱动作

优先使用：

- 看向物体
- 看向镜头
- 指向物体
- 张开手介绍
- 微笑
- 轻微点头
- 鼓励手势
- 模仿动物动作
- 等待孩子回应

==================================================
# 镜头规则
==================================================

如果用户没有明确要求复杂镜头运动：

默认：

camera = "Locked fixed camera"

即：

- 固定镜头
- 不推近
- 不拉远
- 不横移
- 不摇镜
- 不切换场景

只有文案确实需要时才使用轻微镜头运动。

==================================================
# 第一帧和最后一帧规则
==================================================

每个 shot 必须生成：

first_frame_rule

默认：

"用户绑定的参考图片是视频的精确第一帧。保持原始构图、角色位置、角色比例、颜色、背景和整体视觉风格。"

每个 shot 必须生成：

final_frame_rule

默认：

"视频结束时，第一帧中存在的重要角色和核心物体必须仍然保持可见，除非时间轴明确要求离开画面。不要在最后一帧删除、替换或裁切角色。"

==================================================
# 输出格式
==================================================

只能输出一个 JSON 对象。

不要输出解释。

不要输出 Markdown。

不要输出代码围栏。

严格输出：

{
  "shots": [
    {
      "sequence": 1,
      "scene_text": "...",
      "narration": "...",
      "character_names": ["角色名"],
      "duration_sec": 8,
      "camera": "Locked fixed camera",
      "timeline": [
        {
          "start_sec": 0,
          "end_sec": 2,
          "action": "...",
          "dialogue": "..."
        }
      ],
      "first_frame_rule": "...",
      "final_frame_rule": "..."
    }
  ]
}

==================================================
# scene_text 写法
==================================================

scene_text 使用中文。

描述用户在编辑器中看到的整体画面。

不要写成抽象剧情总结。

应该明确描述：

- 谁在画面中
- 谁是主要动作角色
- 动物或物体是否需要持续可见
- 大概构图关系

例如：

"绿色小怪兽位于画面左侧，右侧的棕熊保持清晰可见。小怪兽先看向棕熊，再转向镜头，用友好的手势介绍棕熊。"

==================================================
# narration 写法
==================================================

narration 使用原始文案语言。

如果原文是英文，保留英文。

不要擅自翻译用户的英文儿童旁白。

不要改写用户原始教学文案。

==================================================
# 非常重要
==================================================

不要输出固定数量的 shots。

根据完整文案自动决定需要多少个视频片段。

每个片段最长 8 秒。

必须生成完整 timeline。

timeline 必须和 narration 对应。

最终结果必须方便用户：

1. 绑定已有图片
2. 修改 scene_text
3. 修改 narration
4. 修改 timeline
5. 最后自动生成 Veo 3.1 Prompt
`

function buildSystemPrompt(stylePresetKeywords: string | null): string {
  if (!stylePresetKeywords) {
    return BASE_SYSTEM_PROMPT
  }

  return `${BASE_SYSTEM_PROMPT}

# 项目视觉基底

用户已经选择了以下视觉风格：

${stylePresetKeywords}

所有动作规划必须与该视觉风格兼容。

不要要求重新设计用户已经生成好的角色。
`
}

function buildMaterialsBlock(materials: Material[]): string {
  if (materials.length === 0) {
    return '（无文字素材，仅按用户指令创作）'
  }

  return materials
    .filter((m) => m.kind !== 'image' && m.text.trim().length > 0)
    .map((m, idx) => {
      const tag = `《${m.name}》`

      const body =
        m.text.length > 20000
          ? `${m.text.slice(0, 20000)}……(已截断)`
          : m.text

      return `### 素材${idx + 1} ${tag}\n${body}`
    })
    .join('\n\n')
}

function buildCharactersBlock(characters: Character[]): string {
  if (characters.length === 0) {
    return '（暂无角色卡）'
  }

  return characters
    .map((c) => {
      const role =
        c.role === 'protagonist'
          ? '主角'
          : c.role === 'supporting'
            ? '配角'
            : '群演'

      const desc = c.description
        ? ` · ${c.description}`
        : ''

      const lock =
        c.locked && c.referenceAssetId
          ? '（已锁定参考图，禁止重新设计）'
          : ''

      return `- ${c.name}（${role}${lock}）${desc}`
    })
    .join('\n')
}

function buildImageMaterialsHint(materials: Material[]): string {
  const images = materials.filter((m) => m.kind === 'image')

  if (images.length === 0) {
    return ''
  }

  const list = images
    .map((m, idx) => `${idx + 1}. ${m.name}`)
    .join('\n')

  return `

# 用户已有图片

${list}

这些图片已经生成完成。

不要重新为这些镜头设计新图片。

后续用户会手动为每个视频片段选择和绑定图片。

LLM 当前只负责：

- 根据文案规划视频动作
- 规划时间轴
- 规划旁白
- 规划镜头
`
}

export function buildStoryboardMessages(opts: BuildOptions) {
  const {
    project,
    materials,
    characters,
    userPrompt,
  } = opts

  const preset = matchStylePreset(project.style)

  const styleLine = preset
    ? `${project.style ?? preset.description}（已识别预设：${preset.label}）`
    : project.style ?? '儿童教育视频风格'

  const userBlock = `
# 项目

标题：
${project.title}

风格基调：
${styleLine}

一句话简介：
${project.summary ?? '（无）'}

# 已登记角色

${buildCharactersBlock(characters)}

# 完整文字素材

${buildMaterialsBlock(materials)}

${buildImageMaterialsHint(materials)}

# 用户本次指令

${userPrompt.trim() || '请根据完整文案自动拆分为多个最长 8 秒的视频片段。'}

# 最终任务

请完整阅读所有文案。

不要压缩成长篇总结。

按照 Veo 3.1 Image-to-Video 的工作方式拆分。

每一个 shot 都是：

一张用户已有图片
+
最长 8 秒的视频
+
明确动作时间轴
+
对应旁白
+
镜头规则
+
第一帧规则
+
最后一帧规则

请直接输出：

{"shots":[...]}
`

  return [
    {
      role: 'system' as const,
      content: buildSystemPrompt(
        preset?.imageKeywords ?? null,
      ),
    },
    {
      role: 'user' as const,
      content: userBlock,
    },
  ]
}
