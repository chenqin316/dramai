import { nanoid } from 'nanoid'
import { db } from '@/core/storage/db'
import type {
  Character,
  Storyboard,
  StoryboardTimelineItem,
} from '@/types/domain'
import type { StoryboardDraft } from '@/core/prompts/storyboard'

/**
 * 把 LLM 输出的 StoryboardDraft 写进 IndexedDB。
 *
 * 角色名字到 character.id 的映射在这里完成；
 * 不在 LLM 输出里出现的角色名直接忽略。
 *
 * 同时保存：
 * - timeline
 * - camera
 * - first_frame_rule
 * - final_frame_rule
 *
 * 这些数据后续会用于自动生成 Veo 3.1 Prompt。
 */
export async function appendStoryboardFromDraft(
  projectId: string,
  draft: StoryboardDraft,
  characters: Character[],
): Promise<Storyboard> {
  const nameToId = new Map(
    characters.map((c) => [c.name, c.id]),
  )

  const characterIds = (draft.character_names ?? [])
    .map((name) => nameToId.get(name))
    .filter((id): id is string => Boolean(id))

  const durationSec =
    typeof draft.duration_sec === 'number' &&
    Number.isFinite(draft.duration_sec) &&
    draft.duration_sec > 0
      ? Math.min(8, Math.max(1, Math.round(draft.duration_sec)))
      : 8

  const timeline: StoryboardTimelineItem[] =
    Array.isArray(draft.timeline)
      ? draft.timeline
          .filter(
            (
              item,
            ): item is NonNullable<
              StoryboardDraft['timeline']
            >[number] =>
              Boolean(item) &&
              typeof item === 'object' &&
              typeof item.start_sec === 'number' &&
              typeof item.end_sec === 'number' &&
              typeof item.action === 'string' &&
              item.action.trim().length > 0,
          )
          .map((item) => ({
            startSec: Math.max(
              0,
              Math.floor(item.start_sec),
            ),
            endSec: Math.min(
              durationSec,
              Math.floor(item.end_sec),
            ),
            action: item.action.trim(),
            dialogue:
              typeof item.dialogue === 'string' &&
              item.dialogue.trim().length > 0
                ? item.dialogue.trim()
                : undefined,
          }))
      : []

  const storyboard: Storyboard = {
    id: nanoid(12),

    projectId,

    sequence: Math.max(
      1,
      Math.floor(draft.sequence),
    ),

    sceneText:
      draft.scene_text?.trim() ?? '',

    narration:
      draft.narration?.trim() || undefined,

    imagePrompt:
      draft.image_prompt?.trim() || undefined,

    characterIds,

    durationSec,

    timeline:
      timeline.length > 0
        ? timeline
        : undefined,

    camera:
      draft.camera?.trim() || undefined,

    firstFrameRule:
      draft.first_frame_rule?.trim() || undefined,

    finalFrameRule:
      draft.final_frame_rule?.trim() || undefined,

    status: 'pending',
  }

  await db.storyboards.add(storyboard)

  return storyboard
}

/**
 * 删除一个项目下所有分镜（重新生成前调用）。
 * 关联的图/视频 asset 一起删，避免悬空引用占空间。
 */
export async function clearProjectStoryboards(
  projectId: string,
): Promise<void> {
  await db.transaction(
    'rw',
    [db.storyboards, db.assets],
    async () => {
      const list = await db.storyboards
        .where('projectId')
        .equals(projectId)
        .toArray()

      const assetIds: string[] = []

      for (const storyboard of list) {
        if (storyboard.imageAssetId) {
          assetIds.push(
            storyboard.imageAssetId,
          )
        }

        if (storyboard.videoAssetId) {
          assetIds.push(
            storyboard.videoAssetId,
          )
        }
      }

      if (assetIds.length > 0) {
        await db.assets
          .where('id')
          .anyOf(assetIds)
          .delete()
      }

      await db.storyboards
        .where('projectId')
        .equals(projectId)
        .delete()
    },
  )
}

export async function deleteStoryboard(
  id: string,
): Promise<void> {
  await db.transaction(
    'rw',
    [db.storyboards, db.assets],
    async () => {
      const storyboard =
        await db.storyboards.get(id)

      if (!storyboard) return

      if (storyboard.imageAssetId) {
        await db.assets.delete(
          storyboard.imageAssetId,
        )
      }

      if (storyboard.videoAssetId) {
        await db.assets.delete(
          storyboard.videoAssetId,
        )
      }

      await db.storyboards.delete(id)
    },
  )
}

/**
 * 更新单个分镜。
 *
 * 可以用于：
 * - 用户手动修改 timeline
 * - 修改 camera
 * - 修改第一帧规则
 * - 修改最后一帧规则
 * - 重新生成并保存 Veo Prompt
 */
export async function updateStoryboard(
  id: string,
  patch: Partial<
    Omit<Storyboard, 'id' | 'projectId'>
  >,
): Promise<void> {
  await db.storyboards.update(id, patch)
}
