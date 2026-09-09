import { reactive } from "vue";
import { api, type AssetEntry } from "../../lib/api";
import { sceneApi } from "../../lib/scene-api";
import { isInternalAsset } from "../../lib/internal-assets";
import { assetService } from "../services/assetService";
import type { ScriptPrototype } from "../lib/script-prototypes";
import { logStore } from "./log";
import { getProjectStore } from "./project";

/**
 * 资产状态层：持有资产列表/meta/选中项，并把写操作委托给 assetService。
 * 业务规则（命名去重/只读保护/场景引用跟随/模板注入）在 services/assetService.ts，
 * 本 store 只负责成功后的状态刷新（重扫列表/清选中）。
 */

export interface AssetsStore {
  assets: AssetEntry[];
  metaMap: Map<string, string>;
  selectedAsset: string | null;
  /** 选择序号（每次 select 调用递增，即使同一资产；检查器据此重切资产模式） */
  selectedAssetSeq: number;
  loadedPath: string | null;
  load: (root: string) => Promise<void>;
  refresh: () => Promise<void>;
  select: (rel: string | null) => void;
  createFolder: (root: string, rel: string) => Promise<string | null>;
  rename: (root: string, rel: string, newName: string) => Promise<string | null>;
  duplicate: (root: string, rel: string) => Promise<string | null>;
  remove: (root: string, rel: string) => Promise<boolean>;
  moveTo: (root: string, rel: string, destDir: string) => Promise<string | null>;
  importPaths: (root: string, destDir: string, sourcePaths: string[]) => Promise<boolean>;
  createSceneAsset: (root: string, destDir: string, stem: string) => Promise<string | null>;
  createPrefabAsset: (root: string, destDir: string, stem: string) => Promise<string | null>;
  createAnimAsset: (root: string, destDir: string, stem: string) => Promise<string | null>;
  createMaterialAsset: (
    root: string,
    destDir: string,
    /** 显式指定材质名（devtools/外部调用按名创建）；缺省用 "Material"（资产面板「新建材质」） */
    preferStem?: string | null,
  ) => Promise<string | null>;
  createShaderAsset: (
    root: string,
    destDir: string,
    /** 着色器种类（physical/unlit/toon） */
    kind: string,
    /** 显式指定名称；缺省按种类用 "PBR"/"Unlit"/"Toon"（资产面板「新建着色器」） */
    preferStem?: string | null,
  ) => Promise<string | null>;
  createScriptAsset: (
    root: string,
    destDir: string,
    stem: string,
    /** 代码工坊原型（缺省走内置模板） */
    proto?: ScriptPrototype,
  ) => Promise<string | null>;
  createTextureCubeAsset: (
    root: string,
    destDir: string,
    /** 显式指定名称（devtools/外部调用按名创建）；缺省用 "TextureCube"（资产面板「新建」） */
    preferStem?: string | null,
  ) => Promise<string | null>;
  createSkyboxAsset: (
    root: string,
    destDir: string,
    kind: "procedural" | "cube",
    /** 显式指定名称；缺省按类型用 "ProceduralSky"/"SkyBox" */
    preferStem?: string | null,
  ) => Promise<string | null>;
  readText: (root: string, rel: string) => Promise<string | null>;
}

let singleton: AssetsStore | null = null;

export function getAssetsStore(): AssetsStore {
  if (singleton) return singleton;

  const state = reactive({
    assets: [] as AssetEntry[],
    metaMap: new Map<string, string>(),
    selectedAsset: null as string | null,
    selectedAssetSeq: 0,
    loadedPath: null as string | null,
  });

  /** 写操作成功后重扫列表（业务逻辑不接触状态，由本层统一刷新） */
  const reload = (root: string) => store.load(root);

  /** 被移动/重命名的路径是否影响当前打开的场景（场景本身或位于被移动目录内） */
  function affectsOpenScene(rel: string): boolean {
    const openRel = getProjectStore().sceneRel;
    return !!openRel && (openRel === rel || openRel.startsWith(rel + "/"));
  }

  /**
   * 移动/重命名当前打开的场景前先落盘脏改动：磁盘文件随后被移到新路径，
   * 避免“未保存内容留在旧路径、随后重建旧文件”的数据分裂。
   */
  async function flushOpenSceneSave(): Promise<void> {
    const { getEditorStore } = await import("./editor");
    const editor = getEditorStore();
    if (editor.state.mounted && editor.dirty()) {
      try {
        await sceneApi.save();
      } catch (e) {
        console.warn("移动场景前保存失败（按磁盘现有内容移动）:", e);
      }
    }
  }

  /**
   * 当前打开场景被移动/重命名后重绑编辑器会话：assetService 已更新 sceneRel 指向新路径，
   * 这里按新路径 scene_open 重装会话，避免后端保存目标停留在旧路径（旧路径被重建/重复 Main）。
   */
  async function rebindOpenScene(root: string): Promise<void> {
    const { reloadEditorScene } = await import("../services/editorService");
    const rel = getProjectStore().sceneRel;
    if (rel) await reloadEditorScene(root, rel);
  }

  const store: AssetsStore = {
    get assets() {
      return state.assets;
    },
    get metaMap() {
      return state.metaMap;
    },
    get selectedAsset() {
      return state.selectedAsset;
    },
    get selectedAssetSeq() {
      return state.selectedAssetSeq;
    },
    get loadedPath() {
      return state.loadedPath;
    },
    async load(root) {
      try {
        const assets = await api.scanAssets(root);
        // 项目资产（去掉可能与内置 internal 冲突的同名目录）+ 编辑器内置资源（后端扫描）合并展示
        const projectAssets = assets.filter((a) => !isInternalAsset(a.path));
        const internalAssets = await api.scanInternalAssets();
        const metas = await api.scanAssetDb(root);
        const map = new Map<string, string>();
        for (const m of metas) map.set(m.uuid, m.url);
        state.assets = [...projectAssets, ...internalAssets];
        state.metaMap = map;
        state.loadedPath = root;
      } catch (e) {
        logStore.log("error", `资产扫描失败: ${e}`);
      }
    },
    async refresh() {
      if (!state.loadedPath) return;
      await store.load(state.loadedPath);
    },
    select(rel) {
      state.selectedAsset = rel;
      state.selectedAssetSeq += 1;
    },
    async createFolder(root, rel) {
      const r = await assetService.createFolder(root, rel);
      if (r) await reload(root);
      return r;
    },
    async rename(root, rel, newName) {
      const movingOpenScene = affectsOpenScene(rel);
      if (movingOpenScene) await flushOpenSceneSave();
      const r = await assetService.rename(root, rel, newName);
      if (r) {
        await reload(root);
        if (movingOpenScene) await rebindOpenScene(root);
      }
      return r;
    },
    async duplicate(root, rel) {
      const r = await assetService.duplicate(root, rel);
      if (r) await reload(root);
      return r;
    },
    async remove(root, rel) {
      const ok = await assetService.remove(root, rel);
      if (ok) {
        if (state.selectedAsset === rel) state.selectedAsset = null;
        await reload(root);
      }
      return ok;
    },
    async moveTo(root, rel, destDir) {
      const movingOpenScene = affectsOpenScene(rel);
      if (movingOpenScene) await flushOpenSceneSave();
      const r = await assetService.moveTo(root, rel, destDir);
      if (r) {
        await reload(root);
        if (movingOpenScene) await rebindOpenScene(root);
      }
      return r;
    },
    async importPaths(root, destDir, sourcePaths) {
      const ok = await assetService.importPaths(root, destDir, sourcePaths);
      if (ok) await reload(root);
      return ok;
    },
    async createSceneAsset(root, destDir, stem) {
      const r = await assetService.createSceneAsset(root, destDir, stem, state.assets);
      if (r) await reload(root);
      return r;
    },
    async createPrefabAsset(root, destDir, stem) {
      const r = await assetService.createPrefabAsset(root, destDir, stem, state.assets);
      if (r) await reload(root);
      return r;
    },
    async createAnimAsset(root, destDir, stem) {
      const r = await assetService.createAnimAsset(root, destDir, stem, state.assets);
      if (r) await reload(root);
      return r;
    },
    async createMaterialAsset(root, destDir, preferStem = null) {
      const r = await assetService.createMaterialAsset(root, destDir, state.assets, preferStem);
      if (r) await reload(root);
      return r;
    },
    async createShaderAsset(root, destDir, kind, preferStem = null) {
      const r = await assetService.createShaderAsset(root, destDir, kind, state.assets, preferStem);
      if (r) await reload(root);
      return r;
    },
    async createScriptAsset(root, destDir, stem, proto?: ScriptPrototype) {
      const r = await assetService.createScriptAsset(root, destDir, stem, state.assets, proto);
      if (r) await reload(root);
      return r;
    },
    async createTextureCubeAsset(root, destDir, preferStem = null) {
      const r = await assetService.createTextureCubeAsset(root, destDir, state.assets, preferStem);
      if (r) await reload(root);
      return r;
    },
    async createSkyboxAsset(root, destDir, kind, preferStem = null) {
      const r = await assetService.createSkyboxAsset(root, destDir, kind, state.assets, preferStem);
      if (r) await reload(root);
      return r;
    },
    async readText(root, rel) {
      return assetService.readText(root, rel);
    },
  };

  singleton = store;
  return store;
}
