import { streamChat, LLMRequestError } from '@/core/llm/client'
import { buildStoryboardMessages, type StoryboardDraft } from '@/core/prompts/storyboard'
import { db } from '@/core/storage/db'
import {
  appendStoryboardFromDraft,
  clearProjectStoryboards,
} from '@/core/storage/storyboards'
import { updateProject } from '@/core/storage/projects'
import type {
  Character,
  Material,
  Project,
  Provider,
} from '@/types/domain'

export type StoryboardEvent =
  | { phase: 'starting' }
  | { phase: 'streaming'; accumulated: string }
  | { phase: 'parsing'; accumulated: string }
  | { phase: 'persisting'; shotCount: number }
  | { phase: 'done'; shotCount: number }
  | { phase: 'error'; message: string; raw?: string }

interface RunInput {
  provider: Provider
  project: Project
  materials: Material[]
  characters: Character[]
  userPrompt: string

  /**
   * 可选的分镜数量提示。
   *
   * 儿童教育视频默认根据完整文案
   * 和每段最长 8 秒的规则自动决定。
   */
  targetShotCount?: number

  signal?: AbortSignal
}

/**
 * 文本 / 素材
 * ↓
 * LLM 流式输出
 * ↓
 * 解析 shots[]
 * ↓
 * 落库
 *
 * 当前模式：
 *
 * 一个 shot = 一个最长 8 秒的 Image-to-Video 视频片段。
 *
 * 每个 shot 可以包含：
 * - scene_text
 * - narration
 * - duration_sec
 * - camera
 * - timeline
 * - first_frame_rule
 * - final_frame_rule
 *
 * 用户后续可以为每个 shot
 * 手动绑定已经生成好的图片。
 */
export async function* generateStoryboards(
  input: RunInput,
): AsyncGenerator<StoryboardEvent, void, void> {
  yield { phase: 'starting' }

  const messages = buildStoryboardMessages({
    project: input.project,
    materials: input.materials,
    characters: input.characters,
    userPrompt: input.userPrompt,
    targetShotCount: input.targetShotCount,
  })

  let accumulated = ''

  try {
    await updateProject(input.project.id, {
      status: 'storyboarding',
    })

    for await (const chunk of streamChat(input.provider, {
      model: input.provider.model,
      messages,
      jsonMode: true,
      temperature: 0.7,
      signal: input.signal,
    })) {
      accumulated = chunk.accumulated

      yield {
        phase: 'streaming',
        accumulated,
      }
    }

    yield {
      phase: 'parsing',
      accumulated,
    }

    const shots = parseShots(accumulated)

    if (shots.length === 0) {
      yield {
        phase: 'error',
        message:
          'LLM 没有产出可用的分镜（解析后为空）',
        raw: accumulated,
      }

      await updateProject(input.project.id, {
        status: 'draft',
      })

      return
    }

    yield {
      phase: 'persisting',
      shotCount: shots.length,
    }

    /**
     * 重新生成时清空旧分镜。
     *
     * 注意：
     * 这里会删除旧 storyboard。
     * 如果后续已经绑定图片，
     * 重新生成分镜前要注意备份。
     */
    await clearProjectStoryboards(input.project.id)

    for (const draft of shots) {
      await appendStoryboardFromDraft(
        input.project.id,
        draft,
        input.characters,
      )
    }

    await updateProject(input.project.id, {
      status: 'storyboarding',
    })

    yield {
      phase: 'done',
      shotCount: shots.length,
    }
  } catch (err) {
    const msg =
      err instanceof LLMRequestError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err)

    await updateProject(input.project.id, {
      status: 'draft',
    })

    yield {
      phase: 'error',
      message: msg,
      raw: accumulated || undefined,
    }
  }
}

/**
 * 把 LLM 文本输出解析成 StoryboardDraft 数组。
 *
 * 容忍：
 *
 * 1. Markdown 代码围栏
 * 2. JSON 前后的多余文字
 * 3. camelCase 字段
 * 4. snake_case 字段
 */
export function parseShots(
  raw: string,
): StoryboardDraft[] {
  const candidate = stripCodeFence(raw).trim()

  if (!candidate) {
    return []
  }

  /**
   * 第一种情况：
   * 整段就是合法 JSON。
   */
  const direct = tryParseShots(candidate)

  if (direct) {
    return direct
  }

  /**
   * 第二种情况：
   * LLM 在 JSON 前后输出了额外文字。
   *
   * 尝试抽取最外层 { ... }。
   */
  const objMatch =
    matchOutermostBraces(candidate)

  if (objMatch) {
    const parsed =
      tryParseShots(objMatch)

    if (parsed) {
      return parsed
    }
  }

  return []
}

/**
 * 尝试解析 JSON。
 */
function tryParseShots(
  text: string,
): StoryboardDraft[] | null {
  try {
    const json = JSON.parse(text) as unknown

    if (
      !json ||
      typeof json !== 'object'
    ) {
      return null
    }

    const shots =
      (json as { shots?: unknown }).shots

    if (!Array.isArray(shots)) {
      return null
    }

    return shots
      .map((entry, idx) =>
        normalizeShot(entry, idx),
      )
      .filter(
        (
          shot,
        ): shot is StoryboardDraft =>
          shot !== null,
      )
  } catch {
    return null
  }
}

/**
 * 标准化单个 Shot。
 *
 * DeepSeek / 其他模型有时可能输出：
 *
 * sceneText
 * durationSec
 * firstFrameRule
 *
 * 因此这里同时兼容：
 *
 * snake_case
 * camelCase
 */
function normalizeShot(
  entry: unknown,
  idx: number,
): StoryboardDraft | null {
  if (
    !entry ||
    typeof entry !== 'object'
  ) {
    return null
  }

  const obj =
    entry as Record<string, unknown>

  /**
   * scene_text
   */
  const sceneText =
    typeof obj.scene_text === 'string'
      ? obj.scene_text
      : typeof obj.sceneText === 'string'
        ? obj.sceneText
        : ''

  /**
   * scene_text 是最基本字段。
   *
   * 没有画面描述就不保存。
   */
  if (!sceneText.trim()) {
    return null
  }

  /**
   * duration_sec
   *
   * 默认 8 秒。
   *
   * Veo 3.1 单条视频最大 8 秒，
   * 因此这里强制限制为 1–8 秒。
   */
  const durationRaw =
    typeof obj.duration_sec === 'number' &&
    Number.isFinite(obj.duration_sec)
      ? obj.duration_sec
      : typeof obj.durationSec === 'number' &&
          Number.isFinite(obj.durationSec)
        ? obj.durationSec
        : 8

  const durationSec = Math.min(
    8,
    Math.max(
      1,
      Math.floor(durationRaw),
    ),
  )

  /**
   * timeline
   *
   * 使用独立函数处理，
   * 防止 LLM 输出格式不完整导致整个 Shot 丢失。
   */
  const timeline =
    normalizeTimeline(
      obj.timeline,
      durationSec,
    )

  return {
    /**
     * sequence
     */
    sequence:
      typeof obj.sequence === 'number' &&
      Number.isFinite(obj.sequence)
        ? Math.floor(obj.sequence)
        : idx + 1,

    /**
     * scene_text
     */
    scene_text: sceneText,

    /**
     * narration
     */
    narration:
      typeof obj.narration === 'string'
        ? obj.narration
        : undefined,

    /**
     * image_prompt
     *
     * 目前保留兼容。
     *
     * 你的工作流主要使用
     * 已生成图片 + Image-to-Video，
     * 因此后续不一定使用这个字段。
     */
    image_prompt:
      typeof obj.image_prompt === 'string'
        ? obj.image_prompt
        : typeof obj.imagePrompt === 'string'
          ? obj.imagePrompt
          : undefined,

    /**
     * character_names
     */
    character_names:
      Array.isArray(obj.character_names)
        ? obj.character_names.filter(
            (
              x,
            ): x is string =>
              typeof x === 'string',
          )
        : Array.isArray(
              obj.characterNames,
            )
          ? obj.characterNames.filter(
              (
                x,
              ): x is string =>
                typeof x === 'string',
            )
          : undefined,

    /**
     * 视频总时长。
     *
     * 已限制最大 8 秒。
     */
    duration_sec: durationSec,

    /**
     * 镜头。
     *
     * 默认固定镜头。
     */
    camera:
      typeof obj.camera === 'string'
        ? obj.camera
        : 'Locked fixed camera',

    /**
     * 精确时间轴。
     */
    timeline,

    /**
     * 第一帧规则。
     *
     * 用户后续绑定的图片
     * 就是 Veo 视频第一帧。
     */
    first_frame_rule:
      typeof obj.first_frame_rule === 'string'
        ? obj.first_frame_rule
        : typeof obj.firstFrameRule === 'string'
          ? obj.firstFrameRule
          : '用户绑定的参考图片是视频的精确第一帧。保持原始构图、角色位置、角色比例、颜色、背景和整体视觉风格。',

    /**
     * 最后一帧规则。
     *
     * 防止 Veo 在视频结束前
     * 自动删除重要角色或物体。
     */
    final_frame_rule:
      typeof obj.final_frame_rule === 'string'
        ? obj.final_frame_rule
        : typeof obj.finalFrameRule === 'string'
          ? obj.finalFrameRule
          : '视频结束时，第一帧中存在的重要角色和核心物体必须仍然保持可见，除非时间轴明确要求离开画面。不要在最后一帧删除、替换或裁切角色。',
  }
}

/**
 * 标准化 timeline。
 *
 * LLM 输出的 timeline 可能存在：
 *
 * - 时间不连续
 * - 第一段不是 0 秒
 * - 最后一段没有结束于 duration_sec
 * - start_sec / end_sec 是小数
 * - 某些 timeline 条目格式错误
 *
 * 这里尽可能自动修正。
 */
function normalizeTimeline(
  value: unknown,
  durationSec: number,
): StoryboardDraft['timeline'] {
  /**
   * 如果完全没有 timeline，
   * 自动生成一个覆盖全程的兜底时间轴。
   */
  if (
    !Array.isArray(value) ||
    value.length === 0
  ) {
    return [
      {
        start_sec: 0,
        end_sec: durationSec,
        action:
          '保持自然、清晰、适合儿童教育视频的角色动作。',
      },
    ]
  }

  const items = value
    .map((item) => {
      if (
        !item ||
        typeof item !== 'object'
      ) {
        return null
      }

      const obj =
        item as Record<string, unknown>

      /**
       * 兼容：
       *
       * start_sec
       * startSec
       */
      const start =
        typeof obj.start_sec === 'number'
          ? obj.start_sec
          : typeof obj.startSec === 'number'
            ? obj.startSec
            : null

      /**
       * 兼容：
       *
       * end_sec
       * endSec
       */
      const end =
        typeof obj.end_sec === 'number'
          ? obj.end_sec
          : typeof obj.endSec === 'number'
            ? obj.endSec
            : null

      const action =
        typeof obj.action === 'string'
          ? obj.action.trim()
          : ''

      const dialogue =
        typeof obj.dialogue === 'string'
          ? obj.dialogue.trim()
          : undefined

      /**
       * 基础字段错误，
       * 直接忽略该 timeline。
       */
      if (
        start === null ||
        end === null ||
        !action ||
        !Number.isFinite(start) ||
        !Number.isFinite(end)
      ) {
        return null
      }

      return {
        /**
         * 时间不能小于 0。
         */
        start_sec: Math.max(
          0,
          Math.floor(start),
        ),

        /**
         * 时间不能超过视频总时长。
         */
        end_sec: Math.min(
          durationSec,
          Math.floor(end),
        ),

        action,

        dialogue:
          dialogue &&
          dialogue.length > 0
            ? dialogue
            : undefined,
      }
    })
    .filter(
      (
        item,
      ): item is StoryboardDraft['timeline'][number] =>
        item !== null,
    )

  /**
   * 如果全部 timeline 都无效，
   * 返回兜底时间轴。
   */
  if (items.length === 0) {
    return [
      {
        start_sec: 0,
        end_sec: durationSec,
        action:
          '保持自然、清晰、适合儿童教育视频的角色动作。',
      },
    ]
  }

  /**
   * 按开始时间排序。
   */
  items.sort(
    (a, b) =>
      a.start_sec - b.start_sec,
  )

  /**
   * 第一段必须从 0 秒开始。
   */
  items[0].start_sec = 0

  /**
   * 自动让所有片段连续。
   */
  for (
    let i = 1;
    i < items.length;
    i++
  ) {
    /**
     * 当前段从上一段结束时间开始。
     */
    items[i].start_sec =
      items[i - 1].end_sec

    /**
     * 如果当前结束时间
     * 小于等于开始时间，
     * 至少保证 1 秒。
     */
    if (
      items[i].end_sec <=
      items[i].start_sec
    ) {
      items[i].end_sec =
        Math.min(
          durationSec,
          items[i].start_sec + 1,
        )
    }
  }

  /**
   * 最后一段必须结束于视频结束。
   */
  items[
    items.length - 1
  ].end_sec = durationSec

  return items
}

/**
 * 删除 Markdown 代码围栏。
 *
 * 支持：
 *
 * ```json
 * {...}
 * ```
 *
 * 或：
 *
 * ```
 * {...}
 * ```
 */
function stripCodeFence(
  text: string,
): string {
  const fenced =
    text.match(
      /```(?:json)?\s*([\s\S]*?)```/i,
    )

  return fenced
    ? fenced[1]
    : text
}

/**
 * 从文本中提取第一个完整的
 * 最外层 { ... } JSON 对象。
 */
function matchOutermostBraces(
  text: string,
): string | null {
  const start =
    text.indexOf('{')

  if (start === -1) {
    return null
  }

  let depth = 0

  for (
    let i = start;
    i < text.length;
    i++
  ) {
    const ch = text[i]

    if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--

      if (depth === 0) {
        return text.slice(
          start,
          i + 1,
        )
      }
    }
  }

  return null
}

/**
 * 给 UI 使用。
 *
 * 获取当前项目下所有 storyboard，
 * 按 sequence 排序。
 */
export async function listProjectStoryboards(
  projectId: string,
) {
  return db.storyboards
    .where('projectId')
    .equals(projectId)
    .sortBy('sequence')
}
