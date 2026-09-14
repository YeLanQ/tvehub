// asset-menu —— 资产面板右键菜单条目构造（纯函数，不依赖 Vue 状态）。
// 菜单的“结构/守卫”集中于此；具体动作经 AssetMenuApi 回调注入（实现仍在面板，
// 涉及 prompt/confirm、选中态、当前目录等 UI 上下文）。
// 分支与 AssetsPanel 原 onItemContext / onContentContext / onBlankContext 完全一致。

import type { ChildEntry } from "./asset-browser";
import { menuSeparator, type CtxMenuItem } from "../../lib/editor/context-menu";
import { isGltfAssetRel, isModelAssetRel } from "../../framework/mesh";
import { isAudioAssetRel } from "../../framework/audio";
import { isTerrainAssetRel } from "../../framework/terrain";

/** 着色器种类注册表项（菜单「新建着色器」子项需要 key + label） */
export interface MenuShaderType {
  key: string;
  label: string;
}

/**
 * 创意工坊菜单项（仓库文件 → 新建项目资产）：
 * kind = "script"（.ts 脚本，固定落盘 src/）| "shader"（.shader 资产，落盘右键目录）。
 */
export interface MenuWorkshopItem {
  /** 来源分类（repos 子目录名，如 "code" / "effect"） */
  category: string;
  /** 来源文件名（含扩展名） */
  file: string;
  /** 显示名（文件名去扩展名） */
  name: string;
  kind: "script" | "shader";
}

/** 创意工坊分类（菜单里的一层「标签」，与首页工坊标签名一致） */
export interface MenuWorkshopCategory {
  /** 分类 id（= repos 子目录名） */
  id: string;
  /** 标签名（= 目录名首字母大写） */
  label: string;
  items: MenuWorkshopItem[];
}

/** 面板注入的菜单动作集合（参数均为纯数据，由面板闭包执行） */
export interface AssetMenuApi {
  isInternal: (path: string) => boolean;
  isProtected: (path: string) => boolean;
  isSrcDir: (dir: string) => boolean;
  importAllowed: (dir: string) => boolean;
  shaderTypes: () => MenuShaderType[];
  onOpenDir: (dir: string) => void;
  onAddModelToScene: (item: ChildEntry) => void;
  /** glTF/GLB 资产：Draco 压缩（弹参数窗，产物 <名>.draco.glb 写同目录） */
  onCompressDraco: (item: ChildEntry) => void;
  onAddAudioToScene: (item: ChildEntry) => void;
  /** 地形资产：按资产设置创建地形节点并入场景 */
  onAddTerrainToScene: (item: ChildEntry) => void;
  onInstantiatePrefab: (item: ChildEntry) => void;
  onOpenScript: (item: ChildEntry) => void;
  onCopyInternal: (item: ChildEntry) => void;
  onCopy: (item: ChildEntry) => void;
  onRename: (item: ChildEntry) => void;
  onDelete: (item: ChildEntry) => void;
  onNewScene: (dir: string) => void;
  /** 新建脚本（内置基础模板） */
  onNewScript: (dir: string) => void;
  /** 创意工坊分类清单（标签 + 内容；面板在右键时刷新缓存后提供） */
  workshops: () => MenuWorkshopCategory[];
  /** 按创意工坊文件新建项目资产（脚本 → src/；效果 → 当前目录的 .shader） */
  onNewFromWorkshop: (dir: string, item: MenuWorkshopItem) => void;
  onNewFolder: (dir: string) => void;
  onNewMaterial: (dir: string) => void;
  onNewShader: (dir: string, kind: string) => void;
  onNewSkybox: (dir: string, kind: "procedural" | "cube") => void;
  onNewTerrain: (dir: string) => void;
  onNewTextureCube: (dir: string) => void;
  onNewPrefab: (dir: string) => void;
  onNewAnim: (dir: string) => void;
  onImport: (dir: string) => void;
  onImportFolder: (dir: string) => void;
  onCopyPath: (path: string) => void;
  onRefresh: () => void;
}

function parentOf(path: string): string | null {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : i === 0 ? "" : null;
}

/** 目录允许时的全部「新建」菜单项（场景/材质/着色器/天空盒/TextureCube/预制体） */
function newAssetItems(dir: string, api: AssetMenuApi): CtxMenuItem[] {
  if (!api.importAllowed(dir)) return [];
  return [
    { label: "新建场景", onClick: () => api.onNewScene(dir) },
    { label: "新建材质", onClick: () => api.onNewMaterial(dir) },
    {
      label: "新建着色器",
      children: api.shaderTypes().map((def) => ({
        label: def.label,
        onClick: () => api.onNewShader(dir, def.key),
      })),
    },
    {
      label: "新建天空盒",
      children: [
        { label: "程序化天空", onClick: () => api.onNewSkybox(dir, "procedural") },
        { label: "立方体天空盒", onClick: () => api.onNewSkybox(dir, "cube") },
      ],
    },
    { label: "新建 TextureCube", onClick: () => api.onNewTextureCube(dir) },
    { label: "新建地形", onClick: () => api.onNewTerrain(dir) },
    { label: "新建预制体", onClick: () => api.onNewPrefab(dir) },
    { label: "新建动画", onClick: () => api.onNewAnim(dir) },
  ];
}

/** 目录允许时的导入菜单项（dir 为导入目标目录；不允许 → 空数组） */
function importMenuItems(dir: string, api: AssetMenuApi): CtxMenuItem[] {
  if (!api.importAllowed(dir)) return [];
  return [
    { label: "导入资产…", onClick: () => api.onImport(dir) },
    { label: "导入目录…", onClick: () => api.onImportFolder(dir) },
  ];
}

/**
 * 「创意工坊」子菜单：结构与首页工坊一致 —— 创意工坊 ▸ 标签（仓库分类）▸ 该标签内容。
 * - 脚本项（code 分类）任意可编辑目录都可调起（脚本固定落盘 src/）；
 * - 效果项（effect 分类）仅在可写资产目录出现（着色器资产落盘该目录）；
 * - 分类无可用项时跳过；全空时返回 null（不显示空子菜单）。
 */
function workshopMenuItem(dir: string, api: AssetMenuApi): CtxMenuItem | null {
  const allowShader = api.importAllowed(dir);
  const children: CtxMenuItem[] = [];
  for (const cat of api.workshops()) {
    const usable = cat.items.filter((it) => (it.kind === "shader" ? allowShader : true));
    if (usable.length === 0) continue;
    children.push({
      label: cat.label,
      children: usable.map((it) => ({
        label: it.name,
        onClick: () => api.onNewFromWorkshop(dir, it),
      })),
    });
  }
  if (children.length === 0) return null;
  return { label: "创意工坊", children };
}

/** 追加创意工坊子菜单（无原型时不追加） */
function pushWorkshopMenu(items: CtxMenuItem[], dir: string, api: AssetMenuApi): void {
  const item = workshopMenuItem(dir, api);
  if (item) items.push(item);
}

/** 资产条目右键菜单（网格/列表中的文件、目录、内置资源） */
export function buildEntryMenu(item: ChildEntry, api: AssetMenuApi): CtxMenuItem[] {
  const items: CtxMenuItem[] = [];
  const isProtected = api.isProtected(item.path);
  const isInternal = api.isInternal(item.path);

  if (item.kind === "dir") items.push({ label: "打开", onClick: () => api.onOpenDir(item.path) });
  // 模型资产：加入当前场景（source=model 网格节点）
  if (item.kind !== "dir" && isModelAssetRel(item.path)) {
    items.push({ label: "添加到场景", onClick: () => api.onAddModelToScene(item) });
  }
  // glTF/GLB 资产：Draco 压缩（生成新文件 <名>.draco.glb；fbx/obj 无此入口）
  if (item.kind !== "dir" && isGltfAssetRel(item.path)) {
    items.push({ label: "Draco 压缩…", onClick: () => api.onCompressDraco(item) });
  }
  // 音频资产：加入当前场景（audioNode 音源节点并绑定该资产）
  if (item.kind !== "dir" && isAudioAssetRel(item.path)) {
    items.push({ label: "添加到场景", onClick: () => api.onAddAudioToScene(item) });
  }
  // 地形资产：加入当前场景（terrainNode 并快照资产设置）
  if (item.kind !== "dir" && isTerrainAssetRel(item.path)) {
    items.push({ label: "添加到场景", onClick: () => api.onAddTerrainToScene(item) });
  }
  // 预制体资产：实例化到当前场景（挂到选中节点/根下，一次撤销）
  if (item.kind === "prefab") {
    items.push({ label: "实例化到场景", onClick: () => api.onInstantiatePrefab(item) });
  }
  // 脚本/着色器资产：打开脚本工作台编辑
  if (item.kind === "ts") {
    items.push({ label: "打开脚本", onClick: () => api.onOpenScript(item) });
  }
  if (item.kind === "shader") {
    items.push({ label: "打开着色器", onClick: () => api.onOpenScript(item) });
  }

  if (isProtected) {
    // 内置资源 internal/… 与项目固定根目录 assets、src：只读，不可复制/重命名/删除
    if (!isInternal && item.kind === "dir" && item.path === "assets") {
      // assets 固定根目录内仍可新建资产/子目录（assets/materials 等）
      items.push(...newAssetItems(item.path, api));
      pushWorkshopMenu(items, item.path, api);
      items.push({ label: "新建目录", onClick: () => api.onNewFolder(item.path) });
      items.push(menuSeparator(), ...importMenuItems(item.path, api));
    } else if (!isInternal && item.kind === "dir" && item.path === "src") {
      // src 固定脚本目录：创意工坊原型/新建子目录（脚本经工坊原型创建）
      items.push({ label: "新建脚本", onClick: () => api.onNewScript(item.path) });
      pushWorkshopMenu(items, item.path, api);
      items.push({ label: "新建目录", onClick: () => api.onNewFolder(item.path) });
    } else if (isInternal && item.kind !== "dir") {
      // 内置文件可「复制到项目」生成项目内可编辑副本
      items.push({ label: "复制到项目", onClick: () => api.onCopyInternal(item) });
    }
  } else {
    items.push(
      { label: "复制", onClick: () => api.onCopy(item) },
      { label: "重命名", onClick: () => api.onRename(item) },
      { label: "删除", danger: true, onClick: () => api.onDelete(item) },
    );
    const dir = item.kind === "dir" ? item.path : parentOf(item.path);
    if (dir != null) {
      if (api.isSrcDir(dir)) {
        items.push({ label: "新建脚本", onClick: () => api.onNewScript(dir) });
        pushWorkshopMenu(items, dir, api);
      } else {
        items.push(...newAssetItems(dir, api));
        // 创意工坊不局限在 src：任一可编辑目录都可按原型新建脚本（落盘 src/）
        pushWorkshopMenu(items, dir, api);
      }
      items.push({ label: "新建目录", onClick: () => api.onNewFolder(dir) });
      if (!api.isSrcDir(dir)) {
        items.push(menuSeparator(), ...importMenuItems(dir, api));
      }
    }
  }
  items.push(menuSeparator());
  items.push({ label: "复制路径", onClick: () => api.onCopyPath(item.path) });
  return items;
}

/** 内容区空白处右键（dir = 当前目录）：新建 + 创意工坊 + 导入 + 刷新（内置目录只读时无新建项） */
export function buildContentMenu(dir: string, api: AssetMenuApi): CtxMenuItem[] {
  const items: CtxMenuItem[] = [];
  if (!api.isInternal(dir)) {
    if (api.isSrcDir(dir)) {
      items.push({ label: "新建脚本", onClick: () => api.onNewScript(dir) });
      pushWorkshopMenu(items, dir, api);
    } else {
      items.push(...newAssetItems(dir, api));
      // 创意工坊不局限在 src：任一可编辑目录都可按原型新建脚本（落盘 src/）
      pushWorkshopMenu(items, dir, api);
    }
    items.push({ label: "新建目录", onClick: () => api.onNewFolder(dir) });
    if (!api.isSrcDir(dir)) {
      items.push(menuSeparator(), ...importMenuItems(dir, api));
    }
  }
  items.push(menuSeparator(), { label: "刷新资产", onClick: () => api.onRefresh() });
  return items;
}

/** 目录树空白处右键（固定创建于 assets 根；内部当前目录守卫由面板先行判断） */
export function buildBlankMenu(api: AssetMenuApi): CtxMenuItem[] {
  return buildContentMenu("assets", api);
}

/** 只读目录下的「仅刷新」菜单（分隔线 + 刷新资产） */
export function buildRefreshOnlyMenu(api: AssetMenuApi): CtxMenuItem[] {
  return [menuSeparator(), { label: "刷新资产", onClick: () => api.onRefresh() }];
}
