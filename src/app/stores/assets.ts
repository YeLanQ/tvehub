import { reactive } from "vue";
import { api, type AssetEntry } from "../../lib/api";
import { isInternalAsset } from "../../lib/internal-assets";
import { MATERIAL_EXT, materialTypeRegistry } from "../../framework/material";
import { loadAssetTemplate } from "../lib/asset-templates";
import { buildMaterialContent } from "../lib/materials";
import { isProtectedAsset } from "../lib/asset-guards";
import { logStore } from "./log";

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
  createMaterialAsset: (root: string, destDir: string, typeKey: string) => Promise<string | null>;
  readText: (root: string, rel: string) => Promise<string | null>;
}

/** 资产名规范化（弹窗预填/校验用） */
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

let singleton: AssetsStore | null = null;

export function getAssetsStore(): AssetsStore {
  if (singleton) return singleton;

  const state = reactive({
    assets: [] as AssetEntry[],
    metaMap: new Map<string, string>(),
    selectedAsset: null as string | null,
    loadedPath: null as string | null,
  });

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
        // logStore.log("success", `资产扫描完成: ${state.assets.length} 项`);
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
      if (isInternalAsset(rel)) {
        logStore.log("warn", "内置目录只读，不能在其中新建");
        return null;
      }
      try {
        const r = await api.createFolder(root, rel);
        await store.load(root);
        return r;
      } catch (e) {
        logStore.log("error", `新建目录失败: ${e}`);
        return null;
      }
    },
    async rename(root, rel, newName) {
      if (isProtectedAsset(rel)) {
        logStore.log("warn", "内置资源与项目固定目录（assets/src）不允许重命名");
        return null;
      }
      try {
        const r = await api.renameAsset(root, rel, newName);
        await store.load(root);
        return r;
      } catch (e) {
        logStore.log("error", `重命名失败: ${e}`);
        return null;
      }
    },
    async duplicate(root, rel) {
      if (isProtectedAsset(rel)) {
        logStore.log("warn", "内置资源与项目固定目录（assets/src）不允许复制，请使用「复制到项目」");
        return null;
      }
      try {
        const r = await api.copyAsset(root, rel);
        await store.load(root);
        return r;
      } catch (e) {
        logStore.log("error", `复制失败: ${e}`);
        return null;
      }
    },
    async remove(root, rel) {
      if (isProtectedAsset(rel)) {
        logStore.log("warn", "内置资源与项目固定目录（assets/src）不允许删除");
        return false;
      }
      try {
        await api.deleteAsset(root, rel);
        if (state.selectedAsset === rel) state.selectedAsset = null;
        await store.load(root);
        return true;
      } catch (e) {
        logStore.log("error", `删除失败: ${e}`);
        return false;
      }
    },
    async moveTo(root, rel, destDir) {
      if (isProtectedAsset(rel) || isInternalAsset(destDir)) {
        logStore.log("warn", "内置资源与项目固定目录（assets/src）不允许移动");
        return null;
      }
      try {
        const r = await api.moveAsset(root, rel, destDir);
        await store.load(root);
        return r;
      } catch (e) {
        logStore.log("error", `移动失败: ${e}`);
        return null;
      }
    },
    async importPaths(root, destDir, sourcePaths) {
      if (!sourcePaths.length) return false;
      if (isInternalAsset(destDir) || destDir === "src" || destDir.startsWith("src/")) {
        logStore.log("warn", "内置目录与 src 目录不允许导入资产（脚本用「新建脚本」创建）");
        return false;
      }
      try {
        const imported = await api.importAssets(root, destDir, sourcePaths);
        await store.load(root);
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
    async createSceneAsset(root, destDir, stem) {
      const clean = validateAssetName(stem);
      if (!clean) {
        logStore.log("warn", "无效的场景名（不能含 / \\ : ..）");
        return null;
      }
      if (isInternalAsset(destDir) || destDir === "src" || destDir.startsWith("src/")) {
        logStore.log("warn", "内置目录与 src 目录不允许新建场景");
        return null;
      }
      const ext = ".scene";
      let name = clean;
      let n = 2;
      const prefix = destDir ? `${destDir}/` : "";
      while (
        state.assets.some(
          (a) => a.path.toLowerCase() === `${prefix}${name}${ext}`.toLowerCase(),
        )
      ) {
        name = `${clean} ${n++}`;
      }
      const rel = `${prefix}${name}${ext}`;
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
        await store.load(root);
        logStore.log("success", `已新建场景: ${rel}`);
        return rel;
      } catch (e) {
        logStore.log("error", `新建场景失败: ${e}`);
        return null;
      }
    },
    async createMaterialAsset(root, destDir, typeKey) {
      const def = materialTypeRegistry.getOrDefault(typeKey);
      if (isInternalAsset(destDir) || destDir === "src" || destDir.startsWith("src/")) {
        logStore.log("warn", "内置目录与 src 目录不允许新建材质");
        return null;
      }
      // 显示名 = 类型名（"PBR"…），目录内去重
      const prefix = destDir ? `${destDir}/` : "";
      let name = def.label;
      let n = 2;
      while (
        state.assets.some(
          (a) => a.path.toLowerCase() === `${prefix}${name}${MATERIAL_EXT}`.toLowerCase(),
        )
      ) {
        name = `${def.label} ${n++}`;
      }
      const rel = `${prefix}${name}${MATERIAL_EXT}`;
      try {
        // 材质默认参数以工厂注册表为单一来源（不走模板文件，避免两处维护）
        const content = buildMaterialContent(name, def.key);
        await api.writeText(root, rel, content);
        await store.load(root);
        logStore.log("success", `已新建材质: ${rel}`);
        return rel;
      } catch (e) {
        logStore.log("error", `新建材质失败: ${e}`);
        return null;
      }
    },
    async readText(root, rel) {
      try {
        return await api.readText(root, rel);
      } catch (e) {
        logStore.log("error", `读取资产失败: ${e}`);
        return null;
      }
    },
  };

  singleton = store;
  return store;
}