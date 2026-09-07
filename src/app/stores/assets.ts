import { reactive } from "vue";
import { api, type AssetEntry } from "../../lib/api";
import { isInternalAsset } from "../../lib/internal-assets";
import { assetService } from "../services/assetService";
import { logStore } from "./log";

/**
 * 资产状态层：持有资产列表/meta/选中项，并把写操作委托给 assetService。
 * 业务规则（命名去重/只读保护/场景引用跟随/模板注入）在 services/assetService.ts，
 * 本 store 只负责成功后的状态刷新（重扫列表/清选中）。
 */

export interface AssetsStore {
  assets: AssetEntry[];
  metaMap: Map<string, string>;
  selectedAsset: string | null;
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
  createMaterialAsset: (
    root: string,
    destDir: string,
    typeKey: string,
    /** 显式指定材质名（devtools/外部调用按名创建）；缺省用类型显示名（资产面板「新建材质」） */
    preferStem?: string | null,
  ) => Promise<string | null>;
  createScriptAsset: (root: string, destDir: string, stem: string) => Promise<string | null>;
  readText: (root: string, rel: string) => Promise<string | null>;
}

let singleton: AssetsStore | null = null;

export function getAssetsStore(): AssetsStore {
  if (singleton) return singleton;

  const state = reactive({
    assets: [] as AssetEntry[],
    metaMap: new Map<string, string>(),
    selectedAsset: null as string | null,
    loadedPath: null as string | null,
  });

  /** 写操作成功后重扫列表（业务逻辑不接触状态，由本层统一刷新） */
  const reload = (root: string) => store.load(root);

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
    },
    async createFolder(root, rel) {
      const r = await assetService.createFolder(root, rel);
      if (r) await reload(root);
      return r;
    },
    async rename(root, rel, newName) {
      const r = await assetService.rename(root, rel, newName);
      if (r) await reload(root);
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
      const r = await assetService.moveTo(root, rel, destDir);
      if (r) await reload(root);
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
    async createMaterialAsset(root, destDir, typeKey, preferStem = null) {
      const r = await assetService.createMaterialAsset(
        root,
        destDir,
        typeKey,
        state.assets,
        preferStem,
      );
      if (r) await reload(root);
      return r;
    },
    async createScriptAsset(root, destDir, stem) {
      const r = await assetService.createScriptAsset(root, destDir, stem, state.assets);
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
