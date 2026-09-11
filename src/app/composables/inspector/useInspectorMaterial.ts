// ---------------------------------------------------------------------------
// 材质卡片（Material）域：材质参数落盘（300ms 防抖合并 + 引擎缓存即时同步）、
// 切换材质引用、编辑着色器 Properties 参数、切换挂载着色器、内置材质复制为
// 项目资产。
//
// 协作：只依赖 useInspectorNode 返回的 ctx（node / commit / mutateNode / engine /
// projectStore / assetsStore），域之间互不引用。材质写盘是「缓存即时 + 文件防抖」
// 双轨：面板/视口读缓存立即同步，文件写盘由 scheduleMaterialPersist 合并；
// 面板卸载时调用返回的 flushMaterialPersist 把未落盘的修改写入源文件。
// materialOpen 是材质卡折叠状态（面板内存，不持久化）。
//
// 背景：从 InspectorPanel.vue 抽出的材质域，逐字搬运（含防抖时长、cachePut /
// preload / refreshMaterialNodes 的调用顺序与 await 关系）。
// ---------------------------------------------------------------------------
import { ref, type Ref } from "vue";
import { MeshNode } from "../../../framework/prototype/derived/Primitives";
import type { MaterialParams, MaterialParamKey, MaterialEnableKey } from "../../../framework/material";
import { clampMaterialParam, isMaterialEnableKey, materialFileStem } from "../../../framework/material";
import { isInternalAsset } from "../../../lib/internal-assets";
import {
  duplicateMaterialToProject,
  loadMaterialDoc,
  saveMaterialParams,
} from "../../lib/materials";
import { loadShaderKind } from "../../lib/shaders";
import { logStore } from "../../stores/log";
import type { InspectorNodeApi } from "./useInspectorNode";

export interface InspectorMaterialApi {
  /** 材质卡折叠状态（面板内存，不持久化） */
  materialOpen: Ref<boolean>;
  /** 立即把未落盘的材质修改写入文件（面板卸载 / 切换材质前调用） */
  flushMaterialPersist: () => void;
  onSetMaterial: (rel: string) => Promise<void>;
  onMaterialEdit: (field: MaterialParamKey | MaterialEnableKey, value: number | boolean | string) => Promise<void>;
  onMaterialChangeShader: (shaderRel: string) => Promise<void>;
  onMaterialCopyToProject: () => Promise<void>;
  /** 着色器 Properties 参数编辑（.mat 的 props 字段；键 = 属性名） */
  onMaterialPropEdit: (key: string, value: number | string | number[]) => Promise<void>;
}

export function useInspectorMaterial(ctx: InspectorNodeApi): InspectorMaterialApi {
  const { node, engine, projectStore, assetsStore, commit, mutateNode } = ctx;

  // ---------------------------------------------------------------------------
  // 材质参数落盘：编辑时先即时写入引擎缓存（面板/视口立即同步），文件写盘做
  // 300ms 防抖合并，避免拖拽/连续输入时每条都跨 IPC 写盘造成的延迟与乱序覆盖。
  // ---------------------------------------------------------------------------
  let materialDirtyTimer: ReturnType<typeof setTimeout> | null = null;
  let materialDirty: {
    root: string;
    rel: string;
    name: string;
    /** 挂载的着色器资产引用（写入 .mat 的 shader 字段） */
    shader: string;
    params: MaterialParams;
  } | null = null;

  function persistMaterialNow(d: NonNullable<typeof materialDirty>): void {
    saveMaterialParams(d.root, d.rel, d.name, d.params, d.shader).catch((e) =>
      logStore.log("error", `保存材质 ${d.rel} 失败: ${e}`, "engine"),
    );
  }

  function flushMaterialPersist(): void {
    if (materialDirtyTimer) clearTimeout(materialDirtyTimer);
    materialDirtyTimer = null;
    const d = materialDirty;
    materialDirty = null;
    if (d) persistMaterialNow(d);
  }

  function scheduleMaterialPersist(
    rel: string,
    params: MaterialParams,
    kind?: string,
    shader?: string,
  ): void {
    const root = projectStore.currentPath;
    if (!root) return;
    // 连续编辑中切到另一份材质时，先把上一份落盘，避免被覆盖丢失
    if (materialDirty && materialDirty.rel !== rel) flushMaterialPersist();
    // 着色器引用缺省时取引擎缓存的当前值（参数编辑不改挂载；切换着色器显式传入）
    materialDirty = {
      root,
      rel,
      name: materialFileStem(rel),
      shader: shader ?? engine.materials.shaderFor(rel),
      params: { ...params },
    };
    if (kind) {
      // 渲染分支即时写缓存（引用该材质的网格按新分支重建 three 材质）
      engine.materials.cachePut(rel, params, kind, materialDirty.shader);
    }
    if (materialDirtyTimer) clearTimeout(materialDirtyTimer);
    materialDirtyTimer = setTimeout(() => {
      materialDirtyTimer = null;
      const d = materialDirty;
      materialDirty = null;
      if (d) persistMaterialNow(d);
    }, 300);
  }

  // ---------------------------------------------------------------------------
  // 材质资产（Material）卡片事件
  // ---------------------------------------------------------------------------

  /** 切换到另一份材质资产：先取到新材质参数再提交引用（避免先默认灰再跳变） */
  async function onSetMaterial(rel: string): Promise<void> {
    const n = node.value;
    if (!n || !(n instanceof MeshNode) || !rel || rel === n.material) return;
    const root = projectStore.currentPath;
    if (materialDirty) flushMaterialPersist(); // 切换前把正在编辑的材质落盘
    if (root && !engine.materials.has(rel)) {
      await engine.materials.preload([rel]);
      // 着色器文档：先取到钩子再入图（避免先默认外观后叠加效果）
      await engine.shaders.preload([engine.materials.shaderFor(rel)].filter((s) => s.length > 0));
    }
    commit((m) => { (m as MeshNode).material = rel; }, "Set Material");
    if (root) engine.refreshMaterialNodes(rel);
  }

  /** 修改当前材质资产的某个 PBR 参数/贴图：即时更新缓存（面板/视口立刻同步），文件写盘防抖 */
  async function onMaterialEdit(
    field: MaterialParamKey | MaterialEnableKey,
    value: number | boolean | string,
  ): Promise<void> {
    const n = node.value;
    if (!n || !(n instanceof MeshNode)) return;
    const root = projectStore.currentPath;
    if (!root) {
      logStore.log("error", "未打开项目，无法保存材质修改", "engine");
      return;
    }
    let rel = n.material;
    if (isInternalAsset(rel)) {
      // 内置材质只读（UI 已禁用，这里兜底）：先复制为项目材质再修改
      const dup = await duplicateMaterialToProject(root, rel, n.name);
      if (!dup) {
        logStore.log("error", "复制内置材质到项目失败", "engine");
        return;
      }
      mutateNode(n, (m) => {
        (m as MeshNode).material = dup;
      }, "复制材质到项目");
      rel = dup;
    }
    const params: MaterialParams = { ...engine.materials.paramsFor(rel) };
    if (field === "wireframe") {
      params.wireframe = value === true;
    } else if (isMaterialEnableKey(field)) {
      (params as unknown as Record<string, unknown>)[field] = value === true;
    } else if (typeof value === "string") {
      // 贴图通道：存项目资产相对路径（空串 = 无贴图）
      (params as unknown as Record<string, unknown>)[field] = value;
    } else {
      // 数值/颜色统一收敛（颜色按 hex 截断）
      (params as unknown as Record<string, unknown>)[field] = clampMaterialParam(
        field,
        value as number,
      );
    }
    // 先同步进缓存并广播（引用该材质的所有网格外观同步刷新），文件落盘走防抖
    engine.materials.cachePut(rel, params);
    scheduleMaterialPersist(rel, params);
  }

  /** 切换当前材质挂载的着色器：改写 .mat 的 shader 引用并按新渲染分支重建视口材质 */
  async function onMaterialChangeShader(shaderRel: string): Promise<void> {
    const n = node.value;
    if (!n || !(n instanceof MeshNode) || !shaderRel) return;
    const root = projectStore.currentPath;
    if (!root) {
      logStore.log("error", "未打开项目，无法切换着色器", "engine");
      return;
    }
    let rel = n.material;
    if (isInternalAsset(rel)) {
      // 内置材质只读（UI 已禁用，这里兜底）：先复制为项目材质再切换着色器
      const dup = await duplicateMaterialToProject(root, rel, n.name);
      if (!dup) {
        logStore.log("error", "复制内置材质到项目失败", "engine");
        return;
      }
      mutateNode(n, (m) => {
        (m as MeshNode).material = dup;
      }, "复制材质到项目");
      rel = dup;
    }
    if (materialDirty) flushMaterialPersist(); // 切换前先落盘旧的参数修改
    // 解析新着色器的渲染分支（.shader 读取失败回退 PBR），缓存 + 落盘都在
    // scheduleMaterialPersist 内完成（引用该材质的网格按新分支重建 three 材质）
    const kind = await loadShaderKind(root, shaderRel);
    const params: MaterialParams = { ...engine.materials.paramsFor(rel) };
    scheduleMaterialPersist(rel, params, kind, shaderRel);
  }

  /** 复制当前材质为项目资产并绑定到本节点（内置材质转可编辑 / 生成独立副本） */
  async function onMaterialCopyToProject(): Promise<void> {
    const n = node.value;
    if (!n || !(n instanceof MeshNode)) return;
    const root = projectStore.currentPath;
    if (!root) return;
    if (materialDirty) flushMaterialPersist(); // 复制前先把未落盘的修改写入源文件
    const dup = await duplicateMaterialToProject(root, n.material, n.name);
    if (!dup) {
      logStore.log("error", "复制材质资产失败", "engine");
      return;
    }
    // 复制完成后先把新副本文档（类型 + 参数 + 着色器引用）入缓存，再切换引用：面板/视口不经过默认灰
    if (root) {
      const dupDoc = await loadMaterialDoc(root, dup);
      if (dupDoc) engine.materials.cachePut(dup, dupDoc.params, dupDoc.type, dupDoc.shader);
    }
    mutateNode(n, (m) => { (m as MeshNode).material = dup; }, "复制材质到项目");
    if (root) engine.refreshMaterialNodes(dup);
    // 资产面板下拉项同步
    void assetsStore.load(root);
  }

  /**
   * 着色器 Properties 参数编辑（.mat 的 props 字段；键 = 着色器属性名）：
   * 与分支参数同一链路——即时写引擎缓存（视口同步刷新）+ 防抖写盘。
   */
  async function onMaterialPropEdit(
    key: string,
    value: number | string | number[],
  ): Promise<void> {
    const n = node.value;
    if (!n || !(n instanceof MeshNode)) return;
    const root = projectStore.currentPath;
    if (!root) {
      logStore.log("error", "未打开项目，无法保存材质修改", "engine");
      return;
    }
    const rel = n.material;
    if (isInternalAsset(rel)) return; // 内置材质只读（UI 已禁用，这里兜底）
    const params: MaterialParams = { ...engine.materials.paramsFor(rel) };
    params.props = {
      ...params.props,
      [key]: Array.isArray(value) ? [...value] : value,
    };
    engine.materials.cachePut(rel, params);
    scheduleMaterialPersist(rel, params);
  }

  /** 材质卡折叠状态（面板内存，不持久化） */
  const materialOpen = ref(true);

  return {
    materialOpen,
    flushMaterialPersist,
    onSetMaterial,
    onMaterialEdit,
    onMaterialChangeShader,
    onMaterialCopyToProject,
    onMaterialPropEdit,
  };
}
