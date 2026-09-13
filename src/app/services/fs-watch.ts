// ---------------------------------------------------------------------------
// 文件监听桥（fs-changed）：后端 notify 递归监听当前项目根，外部改动去抖后
// 推送变更相对路径列表。本服务把路径按资产类别分派：
// - 贴图/材质/着色器/模型/音频/TextureCube → 失效引擎对应内存缓存并刷新视口
//   （asset:// 协议本身 no-store，缓存失效后重取即得新字节）；
// - 脚本(.ts) → 工作台非脏标签页/元数据缓存重读（脏文件保护本地编辑）；
// - 其余（增删/目录/.meta 等）→ 资产面板重扫，新文件/删除即时可见。
// `.scene` 不自动重载：场景权威状态在编辑器会话内存中，外部覆盖后自动重装会
// 冲掉未保存改动，仅记录日志提醒。
// ---------------------------------------------------------------------------

import { listen } from "@tauri-apps/api/event";
import { AUDIO_EXTS } from "../../framework/audio/types";
import { MODEL_EXTS } from "../../framework/mesh/types";
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
  // 非当前工程的事件（残留监听/旧工程）忽略
  if (!projectStore.currentPath || payload.root !== projectStore.currentPath) return;

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
    logStore.log(
      "info",
      "场景文件已被外部修改：如需载入磁盘版本请重新打开该场景（未保存改动不会被覆盖）",
      "scene",
    );
  }
}
