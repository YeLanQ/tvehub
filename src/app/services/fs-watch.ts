// ---------------------------------------------------------------------------
// 文件监听桥（fs-changed）：后端 notify 递归监听当前项目根，外部改动去抖后
// 推送变更相对路径列表。本服务把路径按资产类别分派：
// - 贴图/材质/着色器/模型/音频/TextureCube → 失效引擎对应内存缓存并刷新视口
//   （asset:// 协议本身 no-store，缓存失效后重取即得新字节）；
// - 脚本(.ts) → 工作台非脏标签页/元数据缓存重读（脏文件保护本地编辑）；
// - 其余（增删/目录/.meta 等）→ 资产面板重扫，新文件/删除即时可见。
// - .scene → 按脏态分级响应（scene-reload-action.ts）：非当前场景仅提示；
//   当前场景脏走确认弹窗（重新载入/保留我的改动）；非脏自动重载 + 日志。
// ---------------------------------------------------------------------------

import { listen } from "@tauri-apps/api/event";
import { AUDIO_EXTS } from "../../framework/audio/types";
import { MODEL_EXTS } from "../../framework/mesh/types";
import { confirm } from "../../ui-kit/composables/confirm";
import { sceneReloadAction } from "../lib/scene-reload-action";
import { sceneApi } from "../../lib/scene-api";
import { getEditorStore } from "../stores/editor";
import { getProjectStore } from "../stores/project";
import { logStore } from "../stores/log";

/** 后端 watcher 推送载荷（watcher.rs flush） */
interface FsChangedPayload {
  root: string;
  paths: string[];
}

/** TextureLoader 可解码的图片资产（贴图通道颜色/数据两种用法共用同一缓存） */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "avif"]);
const MODEL_EXT_SET = new Set<string>(MODEL_EXTS);
const AUDIO_EXT_SET = new Set<string>(AUDIO_EXTS);

function extOf(rel: string): string {
  const dot = rel.lastIndexOf(".");
  return dot < 0 ? "" : rel.slice(dot + 1).toLowerCase();
}

let installed = false;

/**
 * 自己写盘抑制窗：前端保存场景（saveCurrentSceneToMain / 搬家前 flush）后，
 * watcher 会把我们自己的写盘当"外部修改"推回来——预览/构建流程先保存再切
 * 视图，自动重载会把用户从预览拽回场景视图（真实事故）。保存路径调用
 * markSceneSelfWrite() 打标，窗口内的事件不触发重载。
 */
const SELF_WRITE_SUPPRESS_MS = 2000;
let lastSelfSceneWriteAt = 0;

export function markSceneSelfWrite(): void {
  lastSelfSceneWriteAt = Date.now();
}

/** 安装 fs-changed 监听（编辑器窗口启动时一次；幂等） */
export function installFsWatch(): void {
  if (installed) return;
  installed = true;
  void listen<FsChangedPayload>("fs-changed", (e) => {
    void handleFsChanged(e.payload);
  });
}

async function handleFsChanged(payload: FsChangedPayload): Promise<void> {
  const projectStore = getProjectStore();
  // 非当前工程的事件（残留监听/旧工程）忽略。根目录不一致是异常态（正常打开
  // 流两侧同源），留对比日志便于锁定开启方式差异导致的事件丢失（2026-09-28
  // devtools 兜底开窗漏设项目根曾致热同步全哑）。
  if (!projectStore.currentPath || payload.root !== projectStore.currentPath) {
    logStore.log(
      "warn",
      `fs-changed 事件根目录不匹配，已忽略：payload.root=${payload.root} currentPath=${projectStore.currentPath ?? "(无项目)"}`,
    );
    return;
  }

  const textures: string[] = [];
  const texcubes: string[] = [];
  const materials: string[] = [];
  const shaders: string[] = [];
  const models: string[] = [];
  const audio: string[] = [];
  const scripts: string[] = [];
  let sceneChanged = false;
  for (const rel of payload.paths) {
    switch (extOf(rel)) {
      case "texcube":
        texcubes.push(rel);
        break;
      case "mat":
        materials.push(rel);
        break;
      case "shader":
        shaders.push(rel);
        break;
      case "ts":
        scripts.push(rel);
        break;
      case "scene":
        sceneChanged = true;
        break;
      default:
        if (IMAGE_EXTS.has(extOf(rel))) textures.push(rel);
        else if (MODEL_EXT_SET.has(extOf(rel))) models.push(rel);
        else if (AUDIO_EXT_SET.has(extOf(rel))) audio.push(rel);
      // 其余（.meta/目录/未知类型）只触发下方资产面板重扫
    }
  }

  // 资产面板重扫：增删文件与 .meta 变化即时可见（load 内部有在途去重，幂等）
  const { getAssetsStore } = await import("../stores/assets");
  void getAssetsStore().refresh();

  const editor = getEditorStore();
  const engine = editor.engine;
  // 引擎未就绪（编辑器隐藏/已销毁）时跳过缓存失效：重开项目会整体重建
  if (!editor.state.mounted || engine.isDisposed()) return;

  for (const rel of textures) engine.invalidateTexture(rel);
  for (const rel of texcubes) engine.invalidateTexCube(rel);
  for (const rel of audio) engine.audio.invalidate(rel);
  for (const rel of models) {
    // 丢弃旧解析后重读：完成时经 onChanged 自动刷新引用网格
    engine.models.invalidate(rel);
    void engine.models.preload([rel]);
  }
  await Promise.all(materials.map((rel) => engine.materials.reload(rel)));
  // 材质可能是天空盒材质（.mat cube 分支）：失效天空缓存并重算背景；
  // 非天空材质时重算结果不变，无副作用
  for (const rel of materials) engine.invalidateSkyMaterial(rel);
  await Promise.all(shaders.map((rel) => engine.shaders.reload(rel)));

  // 工作台脚本：非脏标签页/元数据缓存重读（脏文件不动）
  if (scripts.length) {
    const { getScriptsStore } = await import("../stores/scripts");
    await getScriptsStore().reloadExternal(scripts);
  }

  if (sceneChanged) {
    void offerSceneReloadOnExternalChange(payload.paths);
  }
}

/** 外部场景重载处理进行中标记：弹窗期间的后续事件不再叠加弹窗 */
let sceneReloadOfferInFlight = false;

/**
 * 外部 .scene 修改的分级响应（判定在 scene-reload-action.ts）：
 * 非当前场景仅提示；当前场景脏走确认（重新载入将丢弃未保存改动）；非脏自动重载。
 */
async function offerSceneReloadOnExternalChange(paths: string[]): Promise<void> {
  const projectStore = getProjectStore();
  const root = projectStore.currentPath;
  const rel = projectStore.sceneRel;
  if (!root) return;
  const isCurrentScene = Boolean(rel) && paths.includes(rel);
  // 自己刚写过的盘（保存后 2s 内）不是外部修改，跳过分级响应
  if (isCurrentScene && Date.now() - lastSelfSceneWriteAt < SELF_WRITE_SUPPRESS_MS) return;

  let dirty = false;
  if (isCurrentScene) {
    // 后端是脏标记权威；查询失败按脏处理（保守走确认，绝不静默丢改动）
    try {
      dirty = await sceneApi.dirty();
    } catch {
      dirty = true;
    }
  }

  const action = sceneReloadAction(isCurrentScene, dirty);
  if (action === "notice") {
    logStore.log("info", `场景文件已被外部修改（${paths.filter((p) => p.endsWith(".scene")).join("、")}；当前打开的是 ${rel ?? "无"}）`, "scene");
    return;
  }
  if (action === "confirm") {
    if (sceneReloadOfferInFlight) return;
    sceneReloadOfferInFlight = true;
    let reload = false;
    try {
      reload = await confirm({
        title: "检测到场景文件被外部修改",
        message: "当前场景有未保存的改动，重新载入将丢弃这些改动（以磁盘版本为准）。",
        confirmText: "重新载入",
        cancelText: "保留我的改动",
        danger: true,
      });
    } finally {
      sceneReloadOfferInFlight = false;
    }
    if (!reload) {
      logStore.log("info", "已保留未保存改动，未载入磁盘版本", "scene");
      return;
    }
  }
  const { reloadEditorScene } = await import("./editorService");
  await reloadEditorScene(root, rel!);
  logStore.log("info", "场景已从磁盘重新载入（外部修改）", "scene");
}
