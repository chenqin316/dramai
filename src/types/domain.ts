/**
 * 域模型 — dramai 的核心实体类型。
 *
 * 这些类型同时被 Zustand store、Dexie schema、AI 客户端协议共享。
 * 任何字段变更都意味着一次 IndexedDB 迁移（修改 src/core/storage/db.ts 的
 * version 号 + stores 描述）。
 */

export type ProviderKind = 'llm' | 'text2image' | 'image2video' | 'imageEdit'

/**
 * 协议风格。
 *  - 'openai-compatible' (默认)  → /v1/chat/completions、/v1/images/generations 等
 *  - 'gemini'                    → 文生图走 /v1beta/models/{model}:generateContent
 *                                  （302 上的 Nano Banana / Imagen / Google AI Studio 等）
 *  - 'volcengine'                → 火山方舟（字节即梦 Seedance / Doubao 视频）
 *                                  POST /volcengine/api/v3/contents/generations/tasks
 *                                  + GET 轮询；body 用 multimodal content 数组
 *  - 'kling'                     → image2video 走 /v1/videos/image2video（Kling 原生）
 *  - 'runway'                    → image2video Runway 原生（v0.4 暂回退到通用）
 */
export type ApiFlavor =
  | 'openai-compatible'
  | 'gemini'
  | 'volcengine'
  | 'aliyun'
  | 'kling'
  | 'runway'

export interface Provider {
  id: string
  label: string
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  model: string
  notes?: string
  /** 默认 'openai-compatible'。仅 image2video provider 上影响行为。 */
  apiFlavor?: ApiFlavor
  /** 仅在测试连接成功后写入。 */
  lastVerifiedAt?: number
}

export type ActiveProviderMap = Partial<Record<ProviderKind, string>>

export type ProjectStatus = 'draft' | 'storyboarding' | 'generating' | 'done'

export interface Project {
  id: string
  title: string
  summary?: string
  style?: string
  status: ProjectStatus
  createdAt: number
  updatedAt: number
}

export type CharacterRole = 'protagonist' | 'supporting' | 'extra'

export interface Character {
  id: string
  projectId: string
  name: string
  description?: string
  role: CharacterRole
  /** 关联到 assets 表里的参考图。 */
  referenceAssetId?: string
  /** 当为 true 时，分镜里出场会直接使用 referenceAssetId 作为图生图源图。 */
  locked: boolean
  createdAt: number
}

export type MaterialKind = 'doc' | 'txt' | 'md' | 'image'

export interface Material {
  id: string
  projectId: string
  kind: MaterialKind
  name: string
  /** 解析后的文本内容（image 类型为空字符串）。 */
  text: string
  /** 关联到 assets 表的原始文件。 */
  assetId?: string
  createdAt: number
}

export type CameraMovement =
  | 'static'
  | 'pan_left'
  | 'pan_right'
  | 'tilt_up'
  | 'tilt_down'
  | 'zoom_in'
  | 'zoom_out'
  | 'orbit_left'
  | 'orbit_right'
  | 'dolly_in'
  | 'dolly_out'

export type CameraSpeed = 'slow' | 'normal' | 'fast'

export interface CameraParams {
  movement: CameraMovement
  speed?: CameraSpeed
}

export interface StoryboardTimelineItem {
  /** 当前动作开始时间，单位：秒。 */
  startSec: number

  /** 当前动作结束时间，单位：秒。 */
  endSec: number

  /** 该时间段内的具体动作描述。 */
  action: string

  /** 该时间段内的对白；没有对白则为空。 */
  dialogue?: string
}

export interface Storyboard {
  id: string
  projectId: string
  sequence: number

  /** 当前镜头的画面描述。 */
  sceneText: string

  /** 当前镜头的旁白。 */
  narration?: string

  /** 原始文生图提示词。 */
  imagePrompt?: string

  /** 出场角色的 character.id 列表。 */
  characterIds: string[]

  /**
   * 当前 Veo 视频镜头的总时长。
   * Veo 3.1 单次视频最长按 8 秒处理。
   */
  durationSec?: number

  /**
   * 当前镜头的时间轴。
   *
   * 例如：
   * 0–2 秒：展示棕熊
   * 2–5 秒：询问孩子
   * 5–8 秒：等待孩子回答
   */
  timeline?: StoryboardTimelineItem[]

  /**
   * 给 Veo 的镜头规则。
   *
   * 例如：
   * Locked fixed camera.
   * No zoom.
   * No pan.
   * No camera movement.
   */
  camera?: string

  /**
   * 第一帧规则。
   *
   * 用户绑定的图片是该视频的 EXACT FIRST FRAME。
   */
  firstFrameRule?: string

  /**
   * 最后一帧规则。
   *
   * 用于要求重要角色和物体在视频结束时保持正确状态。
   */
  finalFrameRule?: string

  /**
   * 自动组装出的 Veo 3.1 Prompt。
   *
   * 这个字段只是缓存，用户修改分镜后可以重新生成。
   */
  veoPrompt?: string

  /**
   * 用户绑定的已经生成好的图片。
   *
   * 这张图片不是 AI 重新生成的，而是用户选择作为
   * 当前 Veo 视频的参考图 / 第一帧。
   */
  imageAssetId?: string

  videoAssetId?: string

  /** 运镜参数。v0.3 起；旧分镜没有则按 static 处理。 */
  cameraParams?: CameraParams

  /**
   * 异步视频任务句柄，用于刷新页面后恢复轮询。
   * 任务结束后清空。
   */
  pendingVideoTask?: {
    taskId: string
    apiFlavor: ApiFlavor
    submittedAt: number
  }

  status: 'pending' | 'image-ready' | 'video-ready' | 'failed'
}

export type AssetKind = 'image' | 'video' | 'doc'

export interface Asset {
  id: string
  projectId: string
  kind: AssetKind
  /** 原始 mime type，例如 image/png、video/mp4。 */
  mimeType: string
  blob: Blob
  width?: number
  height?: number
  createdAt: number
}

export interface Generation {
  id: string
  projectId: string
  stageName: 'rewrite' | 'storyboard' | 'image' | 'camera' | 'video'
  status: 'pending' | 'running' | 'success' | 'failed'
  input: unknown
  output?: unknown
  error?: string
  retry: number
  createdAt: number
  finishedAt?: number
}
