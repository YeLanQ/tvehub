// 项目设置（Project Settings）逻辑：草稿模型、常用分辨率预设、保存流程。
// 与 LQEN 的 project-settings.ts 对应（精简为当前 3D 编辑器可用的字段），
// 配置写入项目根目录 project.config.json；面板只做 Vue 绑定，本模块无组件依赖。

import { api } from "../../lib/api";
import { getProjectStore } from "../stores/project";
import { logStore } from "../stores/log";

/** 项目设置配置文件（相对项目根） */
export const PROJECT_CONFIG_REL = "project.config.json";

export type Orientation = "auto" | "portrait" | "landscape";

/** 渲染后端：webgl / webgpu（three 自动 WebGL 回退）/ auto */
export type RendererBackend = "webgl" | "webgpu" | "auto";

/** 项目设置表单草稿（保存前不落盘） */
export interface ProjectDraft {
  version: string;
  description: string;
  /** 主场景（工程入口场景，相对项目路径，如 "assets/Main.scene"；空 = 未设置） */
  mainScene: string;
  designWidth: number;
  designHeight: number;
  orientation: Orientation;
  scaleMode: string;
  /** 渲染合成：hdr = HDR 合成 / ldr = LDR 合成 */
  hdrMode: "hdr" | "ldr";
  /** 抗锯齿（MSAA 采样数：0=无，2/4/8） */
  antiAliasing: number;
  /** 渲染后端（编辑器视口使用；webgpu 不可用时 three 会自动回退 WebGL2） */
  renderer: RendererBackend;
}

/** 常用分辨率预设（label 即「宽 × 高」，竖屏/横屏分组） */
export const RESOLUTION_PRESETS: {
  label: string;
  width: number;
  height: number;
  group: "竖屏" | "横屏";
}[] = [
  { label: "640 × 960", width: 640, height: 960, group: "竖屏" },
  { label: "720 × 1280", width: 720, height: 1280, group: "竖屏" },
  { label: "768 × 1024", width: 768, height: 1024, group: "竖屏" },
  { label: "1080 × 1920", width: 1080, height: 1920, group: "竖屏" },
  { label: "1280 × 720", width: 1280, height: 720, group: "横屏" },
  { label: "1334 × 750", width: 1334, height: 750, group: "横屏" },
  { label: "1920 × 1080", width: 1920, height: 1080, group: "横屏" },
  { label: "2560 × 1440", width: 2560, height: 1440, group: "横屏" },
  { label: "3840 × 2160", width: 3840, height: 2160, group: "横屏" },
];

/** 按 竖屏/横屏 分组（optgroup 渲染用） */
export function groupResolutionPresets(): [
  "竖屏" | "横屏",
  { label: string; width: number; height: number }[],
][] {
  const map = new Map<
    "竖屏" | "横屏",
    { label: string; width: number; height: number }[]
  >();
  for (const p of RESOLUTION_PRESETS) {
    const arr = map.get(p.group) ?? [];
    arr.push(p);
    map.set(p.group, arr);
  }
  return [...map.entries()];
}

/** 当前宽高匹配的预设 label（无匹配返回自定义哨兵） */
export function matchResolutionPreset(w?: number, h?: number): string {
  const hit = RESOLUTION_PRESETS.find((p) => p.width === w && p.height === h);
  return hit ? hit.label : "__custom__";
}

/** 应用预设分辨率到草稿 */
export function applyResolutionPreset(draft: ProjectDraft, label: string): void {
  const p = RESOLUTION_PRESETS.find((x) => x.label === label);
  if (p) {
    draft.designWidth = p.width;
    draft.designHeight = p.height;
  }
}

function clampInt(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(v)));
}

/** 无配置文件时的默认草稿 */
export function defaultDraft(): ProjectDraft {
  return {
    version: "0.0.1",
    description: "",
    mainScene: "",
    designWidth: 1280,
    designHeight: 720,
    orientation: "landscape",
    scaleMode: "fixedauto",
    hdrMode: "ldr",
    antiAliasing: 2,
    renderer: "webgl",
  };
}

/** 从配置对象合并默认值生成草稿 */
function draftFromConfig(cfg: Record<string, unknown> | null | undefined): ProjectDraft {
  const d = defaultDraft();
  if (!cfg) return d;
  const num = (v: unknown, fb: number) => (typeof v === "number" && v > 0 ? Math.round(v) : fb);
  const str = (v: unknown, fb: string) => (typeof v === "string" && v.trim() ? v.trim() : fb);
  const design = (cfg.designResolution ?? {}) as { width?: unknown; height?: unknown };
  return {
    version: str(cfg.version, d.version),
    description: str(cfg.description, d.description),
    mainScene: str(cfg.mainScene, d.mainScene),
    designWidth: num(design.width, d.designWidth),
    designHeight: num(design.height, d.designHeight),
    orientation: cfg.orientation === "portrait" || cfg.orientation === "landscape"
      ? cfg.orientation
      : "auto",
    scaleMode: str(cfg.scaleMode, d.scaleMode),
    hdrMode: cfg.hdrMode === "hdr" ? "hdr" : "ldr",
    antiAliasing: typeof cfg.antiAliasing === "number"
      ? clampInt(cfg.antiAliasing, 0, 8)
      : d.antiAliasing,
    renderer: cfg.renderer === "webgpu" || cfg.renderer === "auto" ? cfg.renderer : "webgl",
  };
}

/** 读取项目配置草稿（文件缺失/损坏时返回默认草稿） */
export async function loadProjectDraft(): Promise<ProjectDraft> {
  const p = getProjectStore();
  if (!p.currentPath) return defaultDraft();
  try {
    const text = await api.readText(p.currentPath, PROJECT_CONFIG_REL);
    const cfg = JSON.parse(text) as Record<string, unknown>;
    return draftFromConfig(cfg);
  } catch {
    return defaultDraft();
  }
}

/** 保存项目设置到 project.config.json（保留未编辑字段由草稿整体写回），并同步 store */
export async function saveProjectDraft(draft: ProjectDraft): Promise<void> {
  const p = getProjectStore();
  if (!p.currentPath) throw new Error("尚未打开项目，无法保存设置");
  const next: Record<string, unknown> = {
    version: draft.version.trim() || "0.0.1",
    description: draft.description.trim(),
    mainScene: draft.mainScene.trim(),
    designResolution: {
      width: clampInt(draft.designWidth, 1, 16384),
      height: clampInt(draft.designHeight, 1, 16384),
    },
    orientation: draft.orientation,
    scaleMode: draft.scaleMode,
    hdrMode: draft.hdrMode,
    antiAliasing: clampInt(draft.antiAliasing, 0, 8),
    renderer: draft.renderer,
  };
  await api.writeText(p.currentPath, PROJECT_CONFIG_REL, JSON.stringify(next, null, 2));
  p.setRendererBackend(draft.renderer);
  logStore.log("success", "已保存项目设置", "toolbar");
}
