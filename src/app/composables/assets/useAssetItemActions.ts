// ---------------------------------------------------------------------------
// 资产条目动作（右键菜单 / 双击共用）：内置资源复制到项目、复制、重命名、删除、
// 复制路径，双击分发（进入目录 / 打开场景 / 加入场景 / 打开脚本），以及把模型 /
// 音频加入当前场景、实例化预制体。prompt/confirm 文案与 logStore 文案与拆分前一致。
// 面板状态经 ctx 注入（当前目录、当前选中、主选中锚点、当前目录内容、目录导航），
// 本模块不持有面板状态。
// ---------------------------------------------------------------------------
import { type Ref } from "vue";
import { getAssetsStore } from "../../stores/assets";
import { getProjectStore } from "../../stores/project";
import { getEditorStore } from "../../stores/editor";
import { getScriptsStore } from "../../stores/scripts";
import { logStore } from "../../stores/log";
import { dispatchCommand } from "../../commands";
import { confirm } from "../../lib/confirm";
import { instantiatePrefabAsset } from "../../lib/prefabs";
import { assetService } from "../../services/assetService";
import { isInternalAsset } from "../../../lib/internal-assets";
import { isModelAssetRel } from "../../../framework/mesh";
import { isAudioAssetRel } from "../../../framework/audio";
import type { ChildEntry } from "../../lib/asset-browser";

/** 面板注入的上下文（动作依赖的面板状态与壳层回调） */
export interface UseAssetItemActionsCtx {
  /** 当前目录（删除后判断是否需要回退到 assets 根） */
  currentDir: Ref<string>;
  /** 当前选中项（多选删除时取选中全集） */
  selectedPaths: Ref<string[]>;
  /** 主选中项锚点（双击置锚；删除后复位） */
  lastAnchor: Ref<string | null>;
  /** 当前目录内容（删除时判断目标是否含目录） */
  children: Ref<ChildEntry[]>;
  /** 目录导航（删除后回退到 assets 根） */
  navigate: (dir: string) => void;
}

/** 条目动作集合（供 menuApi 与双击/工具栏事件接线） */
export interface AssetItemActionsApi {
  copyInternalToProject: (item: ChildEntry) => Promise<void>;
  onItemDblClick: (item: ChildEntry) => void;
  openScriptAsset: (item: ChildEntry) => void;
  addModelToScene: (item: ChildEntry) => void;
  addAudioToScene: (item: ChildEntry) => void;
  instantiatePrefab: (item: { path: string }) => Promise<void>;
  doCopy: (item: ChildEntry) => Promise<void>;
  doRename: (item: ChildEntry) => Promise<void>;
  doDelete: (item: ChildEntry) => Promise<void>;
  copyPath: (path: string) => Promise<void>;
}

export function useAssetItemActions(ctx: UseAssetItemActionsCtx): AssetItemActionsApi {
  const assetsStore = getAssetsStore();
  const projectStore = getProjectStore();

  /** 把内置资源（internal/…）复制到项目资产目录（业务与命名下沉 assetService） */
  async function copyInternalToProject(item: ChildEntry): Promise<void> {
    const root = projectStore.currentPath;
    if (!root || item.kind === "dir") return;
    const rel = await assetService.copyInternalToProject(
      root,
      item.name,
      item.path,
      assetsStore.assets,
    );
    if (rel) await assetsStore.load(root);
  }

  /** 双击条目：进入目录 / 打开场景 / 加入场景 / 打开脚本，其余仅选中并记录日志 */
  function onItemDblClick(item: ChildEntry) {
    ctx.selectedPaths.value = [item.path];
    ctx.lastAnchor.value = item.path;
    if (item.kind === "dir") {
      ctx.navigate(item.path);
      return;
    }
    // 双击 .scene 资产：切换当前打开场景（重载引擎场景，层级/视口随之更新）
    if (item.kind === "scene") {
      if (isInternalAsset(item.path)) {
        logStore.log("warn", "内置目录不存在可打开的工程场景");
        return;
      }
      void projectStore.openScene(item.path).then((ok) => {
        if (!ok) logStore.log("error", `打开场景失败: ${item.path}`, "engine");
      });
      return;
    }
    // 双击模型资产：作为模型网格加入当前场景
    if (isModelAssetRel(item.path)) {
      addModelToScene(item);
      return;
    }
    // 双击音频资产：作为音源节点加入当前场景（绑定该资产）
    if (isAudioAssetRel(item.path)) {
      addAudioToScene(item);
      return;
    }
    // 双击 .ts 脚本 / .shader 着色器：切到脚本工作台打开编辑
    if (item.kind === "ts" || item.kind === "shader") {
      openScriptAsset(item);
      return;
    }
    // 其余资产：双击仅选中并记录日志
    assetsStore.select(item.path);
    logStore.log("info", `${item.name} (${item.kind})`);
  }

  /** 打开脚本到脚本工作台（双击 / 右键菜单共用） */
  function openScriptAsset(item: ChildEntry): void {
    getEditorStore().setViewMode("script");
    void getScriptsStore().openScript(item.path);
  }

  /** 把模型资产作为网格节点加入当前场景（source=model；动画自动绑定） */
  function addModelToScene(item: ChildEntry): void {
    const store = getEditorStore();
    if (!store.state.mounted) {
      logStore.log("warn", "编辑器未就绪，无法添加模型");
      return;
    }
    void dispatchCommand("node.add", { kind: "model", path: item.path }).then((r) => {
      if (r.ok && r.value && typeof r.value === "object" && "name" in r.value) {
        logStore.log("success", `已添加模型节点 ${(r.value as { name: string }).name}`, "engine");
      }
    });
  }

  /** 把音频资产作为音源节点加入当前场景（audioNode 并绑定该资产） */
  function addAudioToScene(item: ChildEntry): void {
    const store = getEditorStore();
    if (!store.state.mounted) {
      logStore.log("warn", "编辑器未就绪，无法添加音源");
      return;
    }
    void dispatchCommand("node.add", { kind: "audio", path: item.path }).then((r) => {
      if (r.ok && r.value && typeof r.value === "object" && "name" in r.value) {
        logStore.log("success", `已添加音源节点 ${(r.value as { name: string }).name}`, "engine");
      }
    });
  }

  /** 实例化预制体资产到当前场景（挂到选中节点/根下；一次撤销） */
  async function instantiatePrefab(item: { path: string }): Promise<void> {
    await instantiatePrefabAsset(item.path);
  }

  async function doCopy(item: ChildEntry) {
    const root = projectStore.currentPath;
    if (!root) return;
    await assetsStore.duplicate(root, item.path);
  }

  async function doRename(item: ChildEntry) {
    // 重命名语义（补扩展名/脚本引用随动）统一在 asset.renameSelected 命令（资产面板右键 / F2 共用）
    await dispatchCommand("asset.renameSelected", { rel: item.path });
  }

  async function doDelete(item: ChildEntry) {
    const root = projectStore.currentPath;
    if (!root) return;
    const multi = ctx.selectedPaths.value.length > 1 && ctx.selectedPaths.value.includes(item.path);
    const targets = multi ? [...ctx.selectedPaths.value] : [item.path];
    const hasDir = targets.some((p) => {
      const c = ctx.children.value.find((x) => x.path === p);
      return c?.kind === "dir";
    });
    const ok = await confirm({
      title: multi ? "删除多个资产" : "删除资产",
      message: hasDir
        ? `确定删除${multi ? `这 ${targets.length} 项` : "该资产"}及其目录内容吗？此操作不可恢复。`
        : `确定删除${multi ? `这 ${targets.length} 项` : "该资产"}吗？此操作不可恢复。`,
      confirmText: multi ? `删除 ${targets.length} 项` : "删除",
      danger: true,
    });
    if (!ok) return;
    for (const p of targets) {
      // 脚本删除走 scripts store：同步移除场景内组件引用与编辑器标签页
      if (p.endsWith(".ts") && p.startsWith("src/")) {
        await getScriptsStore().deleteScript(p);
        continue;
      }
      await assetsStore.remove(root, p);
    }
    if (multi) {
      ctx.selectedPaths.value = [];
      ctx.lastAnchor.value = null;
      if (
        ctx.currentDir.value === "assets" ||
        ctx.currentDir.value === "" ||
        targets.some((t) => ctx.currentDir.value === t || ctx.currentDir.value.startsWith(t + "/"))
      ) {
        ctx.navigate("assets");
      }
    }
  }

  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      logStore.log("success", `已复制路径: ${path}`);
    } catch {
      logStore.log("warn", `复制失败: ${path}（剪贴板不可用）`);
    }
  }

  return {
    copyInternalToProject,
    onItemDblClick,
    openScriptAsset,
    addModelToScene,
    addAudioToScene,
    instantiatePrefab,
    doCopy,
    doRename,
    doDelete,
    copyPath,
  };
}
