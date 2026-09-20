// assetService —— 资产业务层：创建/重命名/复制/删除/移动/导入等用例。
// 命名去重与只读保护等规则集中于此；不持有 reactive 状态（资产列表快照经参数传入），
// 落盘成功后由调用方（assets store）重扫列表。lib 数据门面（api）是本层唯一 IPC 出口。

import { api, type AssetEntry } from "../../lib/api";
import { isInternalAsset } from "../../lib/internal-assets";
import {
  DEFAULT_SHADER_REL,
  MATERIAL_EXT,
  SHADER_EXT,
  SHADER_KIND_STEMS,
  materialTypeRegistry,
  normalizeShaderKind,
} from "../../framework/material";
import {
  DEFAULT_TERRAIN_SETTINGS,
  DEFAULT_TERRAIN_MATERIAL_SETTINGS,
  TERRAIN_EXT,
  TERRAIN_MAT_EXT,
} from "../../framework/terrain";
import { DEFAULT_FSM_GRAPH, FSM_EXT } from "../../framework/fsm";
import { BT_EXT, defaultBehaviorTree } from "../../framework/behavior";
import { DEFAULT_TEXCUBE_MAP } from "../lib/texcube";
import { loadAssetTemplate } from "../lib/asset-templates";
import { injectClassName, scriptClassNameFromStem, type ScriptPrototype } from "../lib/script-prototypes";
import { sanitizeAssetStem } from "../lib/materials";
import { isProtectedAsset } from "../lib/asset-guards";
import { remapAssetPath } from "../lib/asset-paths";
import { syncMainSceneAfterMove } from "../lib/project-settings";
import { getProjectStore } from "../stores/project";
import { logStore } from "../stores/log";

/** 资产名规范化（弹窗预填/校验用）；非法返回 null */
export function validateAssetName(name: string): string | null {
  const clean = name.trim();
  if (!clean) return null;
  if (clean.includes("/") || clean.includes("\\") || clean.includes(":") || clean.includes("..")) {
    return null;
  }
  return clean;
}

/** 为指定目录建议一个不冲突的默认资产名 */
export function suggestAssetName(assets: AssetEntry[], base: string, stem: string, ext: string): string {
  const used = new Set(assets.map((a) => a.path.toLowerCase()));
  let name = stem;
  let n = 2;
  while (used.has(`${base}/${name}${ext}`.toLowerCase())) {
    name = `${stem} ${n++}`;
  }
  return `${name}${ext}`;
}

/**
 * 移动/重命名资产后跟随改写场景引用：
 * 当前打开场景（sceneRel）就是被移动文件或位于被移动目录内时指向新路径，
 * 让后续保存写入新位置而不是在旧路径重建文件；mainScene 配置同理同步。
 */
export async function followSceneMove(root: string, fromRel: string, toRel: string): Promise<void> {
  const projectStore = getProjectStore();
  const next = remapAssetPath(projectStore.sceneRel, fromRel, toRel);
  if (next) projectStore.setSceneRel(next);
  await syncMainSceneAfterMove(root, fromRel, toRel);
}

/** 目录内去重命名（与 store 状态快照保持一致：调用前传入最新资产列表） */
function uniqueRel(assets: AssetEntry[], dir: string, base: string, ext: string): string {
  const prefix = dir ? `${dir}/` : "";
  let name = base;
  let n = 2;
  while (
    assets.some((a) => a.path.toLowerCase() === `${prefix}${name}${ext}`.toLowerCase())
  ) {
    name = `${base} ${n++}`;
  }
  return `${prefix}${name}${ext}`;
}

/**
 * 按给定源码新建着色器资产（.shader；创意工坊效果原型 → 项目资产）：
 * 源码经后端 shader_write_source 落盘（Shader 指令名自动同步为资产路径、
 * 解析校验、自动补 .meta），失败返回 null。
 */
async function createShaderFromSource(
  root: string,
  destDir: string,
  stem: string,
  source: string,
  assets: AssetEntry[],
): Promise<string | null> {
  if (isInternalAsset(destDir) || destDir === "src" || destDir.startsWith("src/")) {
    logStore.log("warn", "内置目录与 src 目录不允许新建着色器");
    return null;
  }
  const clean = sanitizeAssetStem(stem);
  if (!clean) {
    logStore.log("warn", "无效的着色器名（不能含 / \\ : ..）");
    return null;
  }
  const rel = uniqueRel(assets, destDir, clean, SHADER_EXT);
  try {
    await api.shaderWriteSource(root, rel, source);
    logStore.log("success", `已新建着色器: ${rel}`);
    return rel;
  } catch (e) {
    logStore.log("error", `新建着色器失败: ${e}`);
    return null;
  }
}

/** 内置资源按类型复制到项目的默认目录 */
const INTERNAL_COPY_DIRS: Record<string, string> = {
  mat: "assets/materials",
  shader: "assets/shaders",
  prefab: "assets/prefabs",
  anim: "assets/animations",
  ts: "src",
  png: "assets/textures",
  jpg: "assets/textures",
  jpeg: "assets/textures",
  webp: "assets/textures",
  bmp: "assets/textures",
  hdr: "assets/textures",
  texcube: "assets/textures",
  terrain: "assets",
  terrainmat: "assets",
  fsm: "assets",
  bt: "assets",
  glb: "assets/models",
  gltf: "assets/models",
  fbx: "assets/models",
  obj: "assets/models",
  mp3: "assets/audio",
  wav: "assets/audio",
  ogg: "assets/audio",
  m4a: "assets/audio",
  aac: "assets/audio",
  flac: "assets/audio",
  json: "assets",
};

/** 二进制资源（图片/模型/音频等）走 base64；文本资源（材质/脚本等）走文本 */
const BINARY_EXTS = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "bmp",
  "glb", "gltf", "fbx", "obj", "bin",
  "mp3", "wav", "ogg", "m4a", "aac", "flac",
]);

export const assetService = {
  async createFolder(root: string, rel: string): Promise<string | null> {
    if (isInternalAsset(rel)) {
      logStore.log("warn", "内置目录只读，不能在其中新建");
      return null;
    }
    try {
      return await api.createFolder(root, rel);
    } catch (e) {
      logStore.log("error", `新建目录失败: ${e}`);
      return null;
    }
  },

  async rename(root: string, rel: string, newName: string): Promise<string | null> {
    if (isProtectedAsset(rel)) {
      logStore.log("warn", "内置资源与项目固定目录（assets/src）不允许重命名");
      return null;
    }
    try {
      const r = await api.renameAsset(root, rel, newName);
      await followSceneMove(root, rel, r);
      return r;
    } catch (e) {
      logStore.log("error", `重命名失败: ${e}`);
      return null;
    }
  },

  async duplicate(root: string, rel: string): Promise<string | null> {
    if (isProtectedAsset(rel)) {
      logStore.log("warn", "内置资源与项目固定目录（assets/src）不允许复制，请使用「复制到项目」");
      return null;
    }
    try {
      return await api.copyAsset(root, rel);
    } catch (e) {
      logStore.log("error", `复制失败: ${e}`);
      return null;
    }
  },

  async remove(root: string, rel: string): Promise<boolean> {
    if (isProtectedAsset(rel)) {
      logStore.log("warn", "内置资源与项目固定目录（assets/src）不允许删除");
      return false;
    }
    try {
      await api.deleteAsset(root, rel);
      return true;
    } catch (e) {
      logStore.log("error", `删除失败: ${e}`);
      return false;
    }
  },

  async moveTo(root: string, rel: string, destDir: string): Promise<string | null> {
    if (isProtectedAsset(rel) || isInternalAsset(destDir)) {
      logStore.log("warn", "内置资源与项目固定目录（assets/src）不允许移动");
      return null;
    }
    try {
      const r = await api.moveAsset(root, rel, destDir);
      await followSceneMove(root, rel, r);
      return r;
    } catch (e) {
      logStore.log("error", `移动失败: ${e}`);
      return null;
    }
  },

  async importPaths(root: string, destDir: string, sourcePaths: string[]): Promise<boolean> {
    if (!sourcePaths.length) return false;
    if (isInternalAsset(destDir) || destDir === "src" || destDir.startsWith("src/")) {
      logStore.log("warn", "内置目录与 src 目录不允许导入资产（脚本用「新建脚本」创建）");
      return false;
    }
    try {
      const imported = await api.importAssets(root, destDir, sourcePaths);
      logStore.log(
        "success",
        imported.length > 1
          ? `已导入 ${imported.length} 个资产到 ${destDir || "项目根"}`
          : `已导入资产: ${imported[0] ?? ""}`,
      );
      return true;
    } catch (e) {
      logStore.log("error", `导入失败: ${e}`);
      return false;
    }
  },

  async createSceneAsset(
    root: string,
    destDir: string,
    stem: string,
    assets: AssetEntry[],
  ): Promise<string | null> {
    const clean = validateAssetName(stem);
    if (!clean) {
      logStore.log("warn", "无效的场景名（不能含 / \\ : ..）");
      return null;
    }
    if (isInternalAsset(destDir) || destDir === "src" || destDir.startsWith("src/")) {
      logStore.log("warn", "内置目录与 src 目录不允许新建场景");
      return null;
    }
    // 基名（调用方可能已带 .scene，避免 .scene.scene）
    const base = clean.toLowerCase().endsWith(".scene") ? clean.slice(0, -".scene".length) : clean;
    const rel = uniqueRel(assets, destDir, base, ".scene");
    const name = rel.slice(rel.lastIndexOf("/") + 1, rel.length - ".scene".length);
    try {
      // 场景原型不内嵌代码：读 internal/templates 模板 + 数据注入
      const now = new Date().toISOString();
      const rootId = `node_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
      const content = await loadAssetTemplate("scene", {
        SCENE_NAME: name,
        NOW: now,
        ROOT_ID: rootId,
      });
      if (content == null) throw new Error("场景模板读取失败");
      await api.writeText(root, rel, content);
      logStore.log("success", `已新建场景: ${rel}`);
      return rel;
    } catch (e) {
      logStore.log("error", `新建场景失败: ${e}`);
      return null;
    }
  },

  /**
   * 新建关键帧动画剪辑（.anim）：变换通道曲线（AnimationClipData 形状），
   * 动画编辑窗口制作/修改内容。
   */
  async createAnimAsset(
    root: string,
    destDir: string,
    stem: string,
    assets: AssetEntry[],
  ): Promise<string | null> {
    const clean = validateAssetName(stem);
    if (!clean) {
      logStore.log("warn", "无效的动画名（不能含 / \\ : ..）");
      return null;
    }
    if (isInternalAsset(destDir) || destDir === "src" || destDir.startsWith("src/")) {
      logStore.log("warn", "内置目录与 src 目录不允许新建动画");
      return null;
    }
    const base = clean.toLowerCase().endsWith(".anim") ? clean.slice(0, -".anim".length) : clean;
    const rel = uniqueRel(assets, destDir, base, ".anim");
    const name = rel.slice(rel.lastIndexOf("/") + 1, rel.length - ".anim".length);
    try {
      const content = await loadAssetTemplate("anim", { ANIM_NAME: name });
      if (content == null) throw new Error("动画模板读取失败");
      await api.writeText(root, rel, content);
      logStore.log("success", `已新建动画: ${rel}`);
      return rel;
    } catch (e) {
      logStore.log("error", `新建动画失败: ${e}`);
      return null;
    }
  },
  /**
   * 新建空白预制体（.prefab）：单节点嵌套文档（与 .scene root 同形状）。
   * 实例化时节点/组件 id 全部重生成，模板里的 id 仅作占位。
   */
  async createPrefabAsset(
    root: string,
    destDir: string,
    stem: string,
    assets: AssetEntry[],
  ): Promise<string | null> {
    const clean = validateAssetName(stem);
    if (!clean) {
      logStore.log("warn", "无效的预制体名（不能含 / \\ : ..）");
      return null;
    }
    if (isInternalAsset(destDir) || destDir === "src" || destDir.startsWith("src/")) {
      logStore.log("warn", "内置目录与 src 目录不允许新建预制体");
      return null;
    }
    const base = clean.toLowerCase().endsWith(".prefab")
      ? clean.slice(0, -".prefab".length)
      : clean;
    const rel = uniqueRel(assets, destDir, base, ".prefab");
    const name = rel.slice(rel.lastIndexOf("/") + 1, rel.length - ".prefab".length);
    try {
      const rootId = `prefab_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
      const content = await loadAssetTemplate("prefab", {
        PREFAB_NAME: name,
        PREFAB_ROOT_ID: rootId,
      });
      if (content == null) throw new Error("预制体模板读取失败");
      await api.writeText(root, rel, content);
      logStore.log("success", `已新建预制体: ${rel}`);
      return rel;
    } catch (e) {
      logStore.log("error", `新建预制体失败: ${e}`);
      return null;
    }
  },

  /**
   * 新建材质资产（.mat）：材质与着色器分离后材质不再带类型，默认挂内置 PBR
   * 着色器（改挂着色器在检查器完成）；命名按 "Material" 基名去重，无需弹窗。
   */
  async createMaterialAsset(
    root: string,
    destDir: string,
    assets: AssetEntry[],
    preferStem: string | null = null,
  ): Promise<string | null> {
    if (isInternalAsset(destDir) || destDir === "src" || destDir.startsWith("src/")) {
      logStore.log("warn", "内置目录与 src 目录不允许新建材质");
      return null;
    }
    // 显示名 = 显式名或 "Material"，目录内去重
    const baseName = preferStem && preferStem.trim() ? sanitizeAssetStem(preferStem) : "Material";
    const rel = uniqueRel(assets, destDir, baseName, MATERIAL_EXT);
    const name = rel.slice(rel.lastIndexOf("/") + 1, rel.length - MATERIAL_EXT.length);
    try {
      // 默认参数以工厂注册表为单一来源；.mat 序列化/落盘由后端完成
      const params = materialTypeRegistry.getOrDefault("physical").defaultParams();
      await api.materialWrite(root, rel, name, DEFAULT_SHADER_REL, params as unknown as Record<string, unknown>);
      logStore.log("success", `已新建材质: ${rel}`);
      return rel;
    } catch (e) {
      logStore.log("error", `新建材质失败: ${e}`);
      return null;
    }
  },

  /**
   * 新建着色器资产（.shader）：kind 为渲染分支（PBR/Unlit/卡通/天空），创建即可
   * 被材质挂着色器下拉引用；Shader 指令名 = 路径去扩展名（与资产位置一致）；
   * 序列化/落盘由后端 shader_write 完成（自动补 .meta）。
   */
  async createShaderAsset(
    root: string,
    destDir: string,
    kind: string,
    assets: AssetEntry[],
    preferStem: string | null = null,
  ): Promise<string | null> {
    if (isInternalAsset(destDir) || destDir === "src" || destDir.startsWith("src/")) {
      logStore.log("warn", "内置目录与 src 目录不允许新建着色器");
      return null;
    }
    const shaderKind = normalizeShaderKind(kind);
    const baseName =
      preferStem && preferStem.trim() ? sanitizeAssetStem(preferStem) : SHADER_KIND_STEMS[shaderKind];
    const rel = uniqueRel(assets, destDir, baseName, SHADER_EXT);
    try {
      await api.shaderWrite(root, rel, shaderKind);
      logStore.log("success", `已新建着色器: ${rel}`);
      return rel;
    } catch (e) {
      logStore.log("error", `新建着色器失败: ${e}`);
      return null;
    }
  },

  /**
   * 按给定源码新建着色器资产（.shader；创意工坊效果原型 → 项目资产）：
   * 源码经后端 shader_write_source 落盘（Shader 指令名自动同步为资产路径、
   * 解析校验、自动补 .meta），失败返回 null。
   */
  async createShaderFromSource(
    root: string,
    destDir: string,
    stem: string,
    source: string,
    assets: AssetEntry[],
  ): Promise<string | null> {
    return createShaderFromSource(root, destDir, stem, source, assets);
  },

  /**
   * 新建 TextureCube（.texcube）资产：默认等距柱状模式并引用内置默认全景图
   * （创建即可用）；序列化/落盘由后端 texcube_write 完成（自动补 .meta）。
   */
  async createTextureCubeAsset(
    root: string,
    destDir: string,
    assets: AssetEntry[],
    preferStem: string | null = null,
  ): Promise<string | null> {
    if (isInternalAsset(destDir) || destDir === "src" || destDir.startsWith("src/")) {
      logStore.log("warn", "内置目录与 src 目录不允许新建 TextureCube");
      return null;
    }
    const baseName = preferStem && preferStem.trim() ? sanitizeAssetStem(preferStem) : "TextureCube";
    const rel = uniqueRel(assets, destDir, baseName, ".texcube");
    const name = rel.slice(rel.lastIndexOf("/") + 1, rel.length - ".texcube".length);
    try {
      await api.texcubeWrite(root, rel, name, "equirect", DEFAULT_TEXCUBE_MAP, null);
      logStore.log("success", `已新建 TextureCube: ${rel}`);
      return rel;
    } catch (e) {
      logStore.log("error", `新建 TextureCube 失败: ${e}`);
      return null;
    }
  },

  /**
   * 新建天空盒材质资产（.mat；shader/kind + 三段配色）：procedural →
   * "ProceduralSky"、cube → "SkyBox" 基名去重；序列化/落盘由后端 skymat_write
   * 完成（自动补 .meta）。创建即可被资产检查器预览与编辑。
   */
  async createSkyboxAsset(
    root: string,
    destDir: string,
    kind: "procedural" | "cube",
    assets: AssetEntry[],
    preferStem: string | null = null,
  ): Promise<string | null> {
    if (isInternalAsset(destDir) || destDir === "src" || destDir.startsWith("src/")) {
      logStore.log("warn", "内置目录与 src 目录不允许新建天空盒");
      return null;
    }
    const baseName =
      preferStem && preferStem.trim()
        ? sanitizeAssetStem(preferStem)
        : kind === "procedural"
          ? "ProceduralSky"
          : "SkyBox";
    const rel = uniqueRel(assets, destDir, baseName, MATERIAL_EXT);
    const name = rel.slice(rel.lastIndexOf("/") + 1, rel.length - MATERIAL_EXT.length);
    try {
      await api.skymatWrite(root, rel, name, kind);
      logStore.log("success", `已新建天空盒: ${rel}`);
      return rel;
    } catch (e) {
      logStore.log("error", `新建天空盒失败: ${e}`);
      return null;
    }
  },

  /**
   * 新建地形资产（.terrain）：默认程序化山地设置（与地形节点默认值一致）；
   * 序列化/落盘由后端 terrain_write 完成（自动补 .meta）。
   * 创建即可从地形节点检查器绑定，或资产面板「添加到场景」。
   */
  async createTerrainAsset(
    root: string,
    destDir: string,
    assets: AssetEntry[],
    preferStem: string | null = null,
  ): Promise<string | null> {
    if (isInternalAsset(destDir) || destDir === "src" || destDir.startsWith("src/")) {
      logStore.log("warn", "内置目录与 src 目录不允许新建地形");
      return null;
    }
    const baseName = preferStem && preferStem.trim() ? sanitizeAssetStem(preferStem) : "Terrain";
    const rel = uniqueRel(assets, destDir, baseName, TERRAIN_EXT);
    const name = rel.slice(rel.lastIndexOf("/") + 1, rel.length - TERRAIN_EXT.length);
    try {
      await api.terrainWrite(root, rel, name, { ...DEFAULT_TERRAIN_SETTINGS });
      logStore.log("success", `已新建地形: ${rel}`);
      return rel;
    } catch (e) {
      logStore.log("error", `新建地形失败: ${e}`);
      return null;
    }
  },

  /**
   * 新建地形材质资产（.terrainmat）：默认 4 纹理图层 + splatmap + 全局 PBR 设置；
   * 序列化/落盘由后端 terrainmat_write 完成（自动补 .meta）。
   * 创建即可从地形节点检查器绑定。
   */
  async createTerrainMaterialAsset(
    root: string,
    destDir: string,
    assets: AssetEntry[],
    preferStem: string | null = null,
  ): Promise<string | null> {
    if (isInternalAsset(destDir) || destDir === "src" || destDir.startsWith("src/")) {
      logStore.log("warn", "内置目录与 src 目录不允许新建地形材质");
      return null;
    }
    const baseName = preferStem && preferStem.trim() ? sanitizeAssetStem(preferStem) : "TerrainMaterial";
    const rel = uniqueRel(assets, destDir, baseName, TERRAIN_MAT_EXT);
    const name = rel.slice(rel.lastIndexOf("/") + 1, rel.length - TERRAIN_MAT_EXT.length);
    try {
      await api.terrainmatWrite(root, rel, name, { ...DEFAULT_TERRAIN_MATERIAL_SETTINGS });
      logStore.log("success", `已新建地形材质: ${rel}`);
      return rel;
    } catch (e) {
      logStore.log("error", `新建地形材质失败: ${e}`);
      return null;
    }
  },

  /** 新建状态机资产（.fsm；默认单入口状态图；重名自动去重） */
  async createFsmAsset(
    root: string,
    destDir: string,
    assets: AssetEntry[],
    preferStem: string | null = null,
  ): Promise<string | null> {
    if (isInternalAsset(destDir) || destDir === "src" || destDir.startsWith("src/")) {
      logStore.log("warn", "内置目录与 src 目录不允许新建状态机");
      return null;
    }
    const baseName = preferStem && preferStem.trim() ? sanitizeAssetStem(preferStem) : "StateMachine";
    const rel = uniqueRel(assets, destDir, baseName, FSM_EXT);
    const name = rel.slice(rel.lastIndexOf("/") + 1, rel.length - FSM_EXT.length);
    try {
      await api.fsmWrite(root, rel, name, JSON.parse(JSON.stringify(DEFAULT_FSM_GRAPH)));
      logStore.log("success", `已新建状态机: ${rel}`);
      return rel;
    } catch (e) {
      logStore.log("error", `新建状态机失败: ${e}`);
      return null;
    }
  },

  /** 新建行为树资产（.bt；默认「顺序 + 动作 + 等待」示例树；重名自动去重） */
  async createBehaviorTreeAsset(
    root: string,
    destDir: string,
    assets: AssetEntry[],
    preferStem: string | null = null,
  ): Promise<string | null> {
    if (isInternalAsset(destDir) || destDir === "src" || destDir.startsWith("src/")) {
      logStore.log("warn", "内置目录与 src 目录不允许新建行为树");
      return null;
    }
    const baseName = preferStem && preferStem.trim() ? sanitizeAssetStem(preferStem) : "BehaviorTree";
    const rel = uniqueRel(assets, destDir, baseName, BT_EXT);
    const name = rel.slice(rel.lastIndexOf("/") + 1, rel.length - BT_EXT.length);
    try {
      await api.behaviorTreeWrite(root, rel, name, defaultBehaviorTree() as unknown as Record<string, unknown>);
      logStore.log("success", `已新建行为树: ${rel}`);
      return rel;
    } catch (e) {
      logStore.log("error", `新建行为树失败: ${e}`);
      return null;
    }
  },

  async createScriptAsset(
    root: string,
    destDir: string,
    stem: string,
    assets: AssetEntry[],
    /** 创意工坊原型（缺省/内置原型走内置模板 internal/templates/Script.ts） */
    proto?: ScriptPrototype,
  ): Promise<string | null> {
    const clean = validateAssetName(stem);
    if (!clean) {
      logStore.log("warn", "无效的脚本名（不能含 / \\ : ..）");
      return null;
    }
    // 脚本固定存放 src/（项目固定脚本目录）；destDir 仅接受 src 子目录
    if (destDir !== "src" && !destDir.startsWith("src/")) {
      logStore.log("warn", "脚本只能创建在 src 目录内");
      return null;
    }
    // 基名（调用方可能已带 .ts，避免 .ts.ts）
    const base = clean.toLowerCase().endsWith(".ts") ? clean.slice(0, -".ts".length) : clean;
    const rel = uniqueRel(assets, destDir, base, ".ts");
    // 类名 = 文件名 PascalCase（模板 {{CLASS_NAME}} 注入）；取**去重后**的文件名，
    // 重名时文件是 "Rotator 2.ts"、类名同步为 "Rotator2"（类名 = 文件名是脚本
    // 组件的标识约定，工坊原型默认用原型名导入，重名是常态）
    const fileStem = rel.slice(rel.lastIndexOf("/") + 1).replace(/\.ts$/, "");
    const className = scriptClassNameFromStem(fileStem);
    try {
      // 工坊自定义原型 → 用原型代码注入类名；内置/缺省 → 内置模板
      let content =
        proto && proto.code.trim()
          ? injectClassName(proto.code, className)
          : await loadAssetTemplate("script", { CLASS_NAME: className });
      if (content == null) throw new Error("脚本模板读取失败");
      // 原型里写死的默认导出类名跟随脚本名改写（保证类名 = 文件名，如
      // CameraFollow 原型改名 MyFollow 创建后类名同步为 MyFollow）
      content = content.replace(
        /export\s+default\s+class\s+[A-Za-z_$][\w$]*/,
        `export default class ${className}`,
      );
      await api.writeText(root, rel, content);
      logStore.log("success", `已新建脚本: ${rel}${proto ? "（工坊原型）" : ""}`);
      return rel;
    } catch (e) {
      logStore.log("error", `新建脚本失败: ${e}`);
      return null;
    }
  },

  /** 把内置资源（internal/…）复制到项目资产目录（只读源 → 项目内可编辑副本） */
  async copyInternalToProject(
    root: string,
    name: string,
    path: string,
    assets: AssetEntry[],
  ): Promise<string | null> {
    const dot = name.lastIndexOf(".");
    const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
    const stem = sanitizeAssetStem(dot >= 0 ? name.slice(0, dot) : name);
    const dir = INTERNAL_COPY_DIRS[ext] ?? "assets";
    const used = new Set(assets.filter((a) => a.kind !== "dir").map((a) => a.path.toLowerCase()));
    let fname = ext ? `${stem}.${ext}` : stem;
    let n = 2;
    while (used.has(`${dir}/${fname}`.toLowerCase())) {
      fname = ext ? `${stem} ${n++}.${ext}` : `${stem} ${n++}`;
    }
    const rel = `${dir}/${fname}`;
    try {
      if (BINARY_EXTS.has(ext)) {
        const b64 = await api.readInternalBinary(path);
        if (b64 == null) throw new Error("读取内置资源失败");
        await api.writeAssetBinary(root, rel, b64);
      } else {
        const content = await api.readInternalAsset(path);
        if (content == null) throw new Error("读取内置资源失败");
        await api.writeText(root, rel, content);
      }
      logStore.log("success", `已复制到项目: ${rel}`);
      return rel;
    } catch (e) {
      logStore.log("error", `复制内置资源到项目失败: ${e}`);
      return null;
    }
  },

  async readText(root: string, rel: string): Promise<string | null> {
    try {
      return await api.readText(root, rel);
    } catch (e) {
      logStore.log("error", `读取资产失败: ${e}`);
      return null;
    }
  },
};
