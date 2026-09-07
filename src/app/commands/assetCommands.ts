// 资产生成/重命名的 UI 命令（资产面板与 F2 上下文快捷键共用）。
// 重命名语义与资产面板右键菜单一致：目录不补扩展名；文件未带后缀自动补原扩展名；
// 脚本走 scripts store（同步改写场景内组件引用），其余走 assets store。

import { getAssetsStore } from "../stores/assets";
import { getProjectStore } from "../stores/project";
import { getScriptsStore } from "../stores/scripts";
import { isProtectedAsset } from "../lib/asset-guards";
import { prompt } from "../lib/prompt";
import { registerCommand } from "./registry";

registerCommand({
  id: "asset.renameSelected",
  label: "重命名选中资产",
  group: "资源",
  description: "弹出统一输入框重命名选中的资产（资产面板/F2 共用；args.rel 可显式指定）",
  canRun: (ctx) => ctx.view === "editor",
  run: async (_ctx, args: any) => {
    const project = getProjectStore();
    const root = project.currentPath;
    const rel = args?.rel ? String(args.rel) : getAssetsStore().selectedAsset;
    if (!root || !rel) return { renamed: false };
    // 只读/固定根目录与已不存在的条目不重命名（与资产面板右键菜单的可用性一致）
    if (isProtectedAsset(rel)) return { renamed: false };
    if (!getAssetsStore().assets.some((a) => a.path === rel)) return { renamed: false };
    const slash = rel.lastIndexOf("/");
    const name = rel.slice(slash + 1);
    const newName = await prompt({
      title: "重命名",
      label: name,
      initial: name,
      confirmText: "重命名",
    });
    if (!newName || newName === name) return { renamed: false };
    // 文件重命名：新名未带后缀时自动补原扩展名（目录不补；隐藏文件 .env 等也不补）
    let finalName = newName;
    const dot = rel.lastIndexOf(".");
    if (dot > slash && dot > 0 && !finalName.includes(".")) {
      finalName = finalName + rel.slice(dot);
    }
    // 脚本重命名走 scripts store：同步换标签页缓存并改写场景内组件引用
    const isScript = (rel === "src" || rel.startsWith("src/")) && rel.endsWith(".ts");
    const renamed = isScript
      ? await getScriptsStore().renameScript(rel, finalName)
      : await getAssetsStore().rename(root, rel, finalName);
    return { renamed: !!renamed, from: rel, to: renamed ?? null };
  },
});
