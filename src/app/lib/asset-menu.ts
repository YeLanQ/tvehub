// asset-menu —— 资产面板右键菜单条目构造（纯函数，不依赖 Vue 状态）。
// 菜单的“结构/守卫”集中于此；具体动作经 AssetMenuApi 回调注入（实现仍在面板，
// 涉及 prompt/confirm、选中态、当前目录等 UI 上下文）。
// 分支与 AssetsPanel 原 onItemContext / onContentContext / onBlankContext 完全一致。

import type { ChildEntry } from "./asset-browser";
import { menuSeparator, type CtxMenuItem } from "../../lib/editor/context-menu";
import { isModelAssetRel } from "../../framework/mesh";

/** 材质类型注册表项（菜单「新建材质」子项需要 key + label） */
export interface MenuMaterialType {
  key: string;
  label: string;
}

/** 面板注入的菜单动作集合（参数均为纯数据，由面板闭包执行） */
export interface AssetMenuApi {
  isInternal: (path: string) => boolean;
  isProtected: (path: string) => boolean;
  isSrcDir: (dir: string) => boolean;
  importAllowed: (dir: string) => boolean;
  materialTypes: () => MenuMaterialType[];
  onOpenDir: (dir: string) => void;
  onAddModelToScene: (item: ChildEntry) => void;
  onOpenScript: (item: ChildEntry) => void;
  onCopyInternal: (item: ChildEntry) => void;
  onCopy: (item: ChildEntry) => void;
  onRename: (item: ChildEntry) => void;
  onDelete: (item: ChildEntry) => void;
  onNewScene: (dir: string) => void;
  onNewScript: (dir: string) => void;
  onNewFolder: (dir: string) => void;
  onNewMaterial: (dir: string, typeKey: string) => void;
  onNewTextureCube: (dir: string) => void;
  onImport: (dir: string) => void;
  onImportFolder: (dir: string) => void;
  onCopyPath: (path: string) => void;
  onRefresh: () => void;
}

function parentOf(path: string): string | null {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : i === 0 ? "" : null;
}

/** 目录允许时的「新建场景」菜单项（src / 内置目录不允许 → null） */
function sceneCreateItem(dir: string, api: AssetMenuApi): CtxMenuItem | null {
  if (!api.importAllowed(dir)) return null;
  return { label: "新建场景", onClick: () => api.onNewScene(dir) };
}

/** 目录允许时的「新建材质」子菜单（二级列出已注册材质类型；null 表示不提供） */
function materialCreateItem(dir: string, api: AssetMenuApi): CtxMenuItem | null {
  if (!api.importAllowed(dir)) return null;
  return {
    label: "新建材质",
    children: api.materialTypes().map((def) => ({
      label: def.label,
      onClick: () => api.onNewMaterial(dir, def.key),
    })),
  };
}

/** 目录允许时的「新建 TextureCube」菜单项（立方体纹理资产；null 表示不提供） */
function textureCubeCreateItem(dir: string, api: AssetMenuApi): CtxMenuItem | null {
  if (!api.importAllowed(dir)) return null;
  return { label: "新建 TextureCube", onClick: () => api.onNewTextureCube(dir) };
}

/** 目录允许时的导入菜单项（dir 为导入目标目录；不允许 → 空数组） */
function importMenuItems(dir: string, api: AssetMenuApi): CtxMenuItem[] {
  if (!api.importAllowed(dir)) return [];
  return [
    { label: "导入资产…", onClick: () => api.onImport(dir) },
    { label: "导入目录…", onClick: () => api.onImportFolder(dir) },
  ];
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
  // 脚本资产：打开脚本工作台编辑
  if (item.kind === "ts") {
    items.push({ label: "打开脚本", onClick: () => api.onOpenScript(item) });
  }

  if (isProtected) {
    // 内置资源 internal/… 与项目固定根目录 assets、src：只读，不可复制/重命名/删除
    if (!isInternal && item.kind === "dir" && item.path === "assets") {
      // assets 固定根目录内仍可新建场景/材质/子目录（assets/materials 等）
      const sc = sceneCreateItem(item.path, api);
      if (sc) items.push(sc);
      const mc = materialCreateItem(item.path, api);
      if (mc) items.push(mc);
      const tc = textureCubeCreateItem(item.path, api);
      if (tc) items.push(tc);
      items.push({ label: "新建目录", onClick: () => api.onNewFolder(item.path) });
      items.push(menuSeparator(), ...importMenuItems(item.path, api));
    } else if (!isInternal && item.kind === "dir" && item.path === "src") {
      // src 固定脚本目录：新建脚本/子目录（脚本经「新建脚本」模板创建）
      items.push({ label: "新建脚本", onClick: () => api.onNewScript(item.path) });
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
      } else {
        const sc = sceneCreateItem(dir, api);
        if (sc) items.push(sc);
        const mc = materialCreateItem(dir, api);
        if (mc) items.push(mc);
        const tc = textureCubeCreateItem(dir, api);
        if (tc) items.push(tc);
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

/** 内容区空白处右键（dir = 当前目录）：新建 + 导入 + 刷新（内置目录只读时无新建项） */
export function buildContentMenu(dir: string, api: AssetMenuApi): CtxMenuItem[] {
  const items: CtxMenuItem[] = [];
  if (!api.isInternal(dir)) {
    if (api.isSrcDir(dir)) {
      items.push({ label: "新建脚本", onClick: () => api.onNewScript(dir) });
    } else {
      const sc = sceneCreateItem(dir, api);
      if (sc) items.push(sc);
      const mc = materialCreateItem(dir, api);
      if (mc) items.push(mc);
      const tc = textureCubeCreateItem(dir, api);
      if (tc) items.push(tc);
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
