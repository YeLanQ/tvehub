// ---------------------------------------------------------------------------
// 资产新建 / 导入类动作（右键菜单与工具栏共用）：新建目录、场景、脚本（基础模板
// 与创意工坊原型）、材质、着色器、天空盒、TextureCube、预制体、动画，以及导入
// 文件 / 导入目录。prompt/confirm 文案与 logStore 文案与拆分前一致。
// 面板状态经 ctx 注入（当前目录为导入的默认目标目录；目录守卫 isSrcDir /
// importAllowedDir 决定哪些目录可写），本模块不持有面板状态。
// ---------------------------------------------------------------------------
import { type Ref } from "vue";
import { getAssetsStore } from "../../stores/assets";
import { getProjectStore } from "../../stores/project";
import { getScriptsStore } from "../../stores/scripts";
import { logStore } from "../../stores/log";
import { prompt } from "../../lib/prompt";
import { normalizeShaderKind, SHADER_KIND_STEMS } from "../../../framework/material";
import { type ScriptPrototype } from "../../lib/script-prototypes";
import { readRepoFile } from "../../lib/repos";
import type { MenuWorkshopItem } from "../../lib/asset-menu";
import { api } from "../../../lib/api";

/** 面板注入的上下文（动作依赖的面板状态与目录守卫） */
export interface UseAssetActionsCtx {
  /** 当前目录（导入动作的默认目标目录） */
  currentDir: Ref<string>;
  /** 脚本目录判断（脚本只能创建在 src/ 内） */
  isSrcDir: (dir: string) => boolean;
  /** 目录是否允许新建/导入（src=脚本目录、internal=内置只读 不允许） */
  importAllowedDir: (dir: string) => boolean;
}

/** 新建 / 导入类动作集合（供 menuApi 与工具栏事件接线） */
export interface AssetActionsApi {
  doNewFolder: (dir: string) => Promise<void>;
  doNewScene: (dir: string) => Promise<void>;
  doNewScript: (dir: string) => Promise<void>;
  doNewFromWorkshop: (dir: string, item: MenuWorkshopItem) => Promise<void>;
  doNewMaterial: (dir: string) => Promise<void>;
  doNewShader: (dir: string, kind: string) => Promise<void>;
  doNewSkybox: (dir: string, kind: "procedural" | "cube") => Promise<void>;
  doNewTextureCube: (dir: string) => Promise<void>;
  doNewPrefab: (dir: string) => Promise<void>;
  doNewAnim: (dir: string) => Promise<void>;
  doImport: (dir?: string) => Promise<void>;
  doImportFolder: (dir?: string) => Promise<void>;
}

export function useAssetActions(ctx: UseAssetActionsCtx): AssetActionsApi {
  const assetsStore = getAssetsStore();
  const projectStore = getProjectStore();

  async function doNewFolder(dir: string) {
    const root = projectStore.currentPath;
    if (!root) return;
    const name = await prompt({
      title: "新建目录",
      label: dir,
      initial: "NewFolder",
      confirmText: "创建",
    });
    if (!name) return;
    const rel = `${dir}/${name}`;
    await assetsStore.createFolder(root, rel);
  }

  /** 新建 3D 场景资产（到 dir；src/内置目录不允许） */
  async function doNewScene(dir: string) {
    const root = projectStore.currentPath;
    if (!root) return;
    if (!ctx.importAllowedDir(dir)) {
      logStore.log("warn", ctx.isSrcDir(dir)
        ? "src 目录不允许新建场景"
        : "内置目录只读，不允许新建场景");
      return;
    }
    const name = await prompt({
      title: "新建场景",
      label: dir || "项目根",
      initial: "NewScene",
      confirmText: "创建",
    });
    if (!name) return;
    await assetsStore.createSceneAsset(root, dir, name);
  }

  /** 新建 TS 脚本（内置基础模板；工坊原型走右键菜单「创意工坊」子菜单） */
  async function doNewScript(dir: string) {
    if (!ctx.isSrcDir(dir)) {
      logStore.log("warn", "脚本只能创建在 src 目录内");
      return;
    }
    const name = await prompt({
      title: "新建脚本",
      label: `${dir}/（脚本名）`,
      placeholder: "MyScript",
      confirmText: "创建",
    });
    if (!name?.trim()) return;
    await getScriptsStore().createScript(name.trim());
  }

  /**
   * 按创意工坊内容新建项目资产（右键菜单「创意工坊 ▸ 标签 ▸ 内容」）：
   * - 脚本（code 分类的 .ts）：固定创建在 src/（脚本系统只编译 src/ 下的 .ts），
   *   故从任意目录调起都落到 src/，提示里显示真实目标而不随右键位置变化；
   * - 效果（effect 分类的 .shader）：把原型源码写成当前目录下的着色器资产
   *   （指令名随路径自动同步，随后在材质卡片「着色器」下拉中挂载）。
   */
  async function doNewFromWorkshop(dir: string, item: MenuWorkshopItem) {
    const root = projectStore.currentPath;
    if (!root) return;
    if (item.kind === "shader" && !ctx.importAllowedDir(dir)) {
      logStore.log("warn", ctx.isSrcDir(dir) ? "src 目录不允许新建着色器" : "内置目录只读，不允许新建着色器");
      return;
    }
    const isScript = item.kind === "script";
    const name = await prompt({
      title: isScript ? "新建脚本" : "新建着色器",
      label: isScript
        ? `src/（脚本名）· 原型：${item.name}`
        : `${dir}/（着色器名）· 效果原型：${item.name}`,
      placeholder: item.name,
      confirmText: "创建",
    });
    if (!name?.trim()) return;
    const source = await readRepoFile(item.category, item.file);
    if (!source.trim()) {
      logStore.log("warn", `创意工坊内容读取失败: ${item.category}/${item.file}`);
      return;
    }
    if (isScript) {
      const proto: ScriptPrototype = {
        id: item.file,
        name: item.name,
        description: "",
        code: source,
      };
      const rel = await getScriptsStore().createScript(name.trim(), proto);
      if (rel) logStore.log("success", `已按创意工坊原型「${item.name}」创建脚本: ${rel}`);
      return;
    }
    const rel = await assetsStore.createShaderFromSource(root, dir, name.trim(), source);
    if (rel) logStore.log("success", `已按创意工坊效果「${item.name}」创建着色器: ${rel}`);
  }

  /** 新建空白预制体（assets/prefabs 语义上的目录均可；模板创建） */
  async function doNewPrefab(dir: string): Promise<void> {
    const root = projectStore.currentPath;
    if (!root) return;
    if (!ctx.importAllowedDir(dir) || ctx.isSrcDir(dir)) {
      logStore.log("warn", ctx.isSrcDir(dir) ? "src 目录不允许新建预制体" : "内置目录只读，不允许新建预制体");
      return;
    }
    const name = await prompt({
      title: "新建预制体",
      label: dir || "项目根",
      initial: "NewPrefab",
      confirmText: "创建",
    });
    if (!name?.trim()) return;
    await assetsStore.createPrefabAsset(root, dir, name.trim());
  }

  /** 新建关键帧动画剪辑（.anim；模板创建） */
  async function doNewAnim(dir: string): Promise<void> {
    const root = projectStore.currentPath;
    if (!root) return;
    if (!ctx.importAllowedDir(dir) || ctx.isSrcDir(dir)) {
      logStore.log("warn", ctx.isSrcDir(dir) ? "src 目录不允许新建动画" : "内置目录只读，不允许新建动画");
      return;
    }
    const name = await prompt({
      title: "新建动画",
      label: dir || "项目根",
      initial: "NewAnimation",
      confirmText: "创建",
    });
    if (!name?.trim()) return;
    await assetsStore.createAnimAsset(root, dir, name.trim());
  }

  /** 新建材质资产（到 dir；材质与着色器分离，默认挂内置 PBR 着色器；弹窗命名，重名自动去重） */
  async function doNewMaterial(dir: string): Promise<void> {
    const root = projectStore.currentPath;
    if (!root) return;
    if (!ctx.importAllowedDir(dir)) {
      logStore.log("warn", ctx.isSrcDir(dir)
        ? "src 目录不允许新建材质"
        : "内置目录只读，不允许新建材质");
      return;
    }
    const name = await prompt({
      title: "新建材质",
      label: dir || "项目根",
      initial: "NewMaterial",
      confirmText: "创建",
    });
    if (!name?.trim()) return;
    await assetsStore.createMaterialAsset(root, dir, name.trim());
  }

  /** 新建着色器资产（.shader；PBR/Unlit/卡通等渲染程序；弹窗命名，重名自动去重） */
  async function doNewShader(dir: string, kind: string): Promise<void> {
    const root = projectStore.currentPath;
    if (!root) return;
    if (!ctx.importAllowedDir(dir)) {
      logStore.log("warn", ctx.isSrcDir(dir)
        ? "src 目录不允许新建着色器"
        : "内置目录只读，不允许新建着色器");
      return;
    }
    const name = await prompt({
      title: "新建着色器",
      label: dir || "项目根",
      initial: SHADER_KIND_STEMS[normalizeShaderKind(kind)] ?? "NewShader",
      confirmText: "创建",
    });
    if (!name?.trim()) return;
    await assetsStore.createShaderAsset(root, dir, kind, name.trim());
  }

  /** 新建天空盒材质资产（.mat；程序化/立方体两种；弹窗命名，重名自动去重） */
  async function doNewSkybox(dir: string, kind: "procedural" | "cube"): Promise<void> {
    const root = projectStore.currentPath;
    if (!root) return;
    if (!ctx.importAllowedDir(dir)) {
      logStore.log("warn", ctx.isSrcDir(dir)
        ? "src 目录不允许新建天空盒"
        : "内置目录只读，不允许新建天空盒");
      return;
    }
    const name = await prompt({
      title: "新建天空盒",
      label: dir || "项目根",
      initial: kind === "procedural" ? "ProceduralSky" : "SkyBox",
      confirmText: "创建",
    });
    if (!name?.trim()) return;
    await assetsStore.createSkyboxAsset(root, dir, kind, name.trim());
  }

  /** 新建 TextureCube 资产（立方体纹理；默认引用内置全景图，创建即可用；弹窗命名，重名自动去重） */
  async function doNewTextureCube(dir: string): Promise<void> {
    const root = projectStore.currentPath;
    if (!root) return;
    if (!ctx.importAllowedDir(dir)) {
      logStore.log("warn", ctx.isSrcDir(dir)
        ? "src 目录不允许新建 TextureCube"
        : "内置目录只读，不允许新建 TextureCube");
      return;
    }
    const name = await prompt({
      title: "新建 TextureCube",
      label: dir || "项目根",
      initial: "NewTextureCube",
      confirmText: "创建",
    });
    if (!name?.trim()) return;
    await assetsStore.createTextureCubeAsset(root, dir, name.trim());
  }

  /** 导入按钮：打开多文件选择对话框，导入到目标目录 */
  async function doImport(dir: string = ctx.currentDir.value): Promise<void> {
    const root = projectStore.currentPath;
    if (!root) return;
    if (!ctx.importAllowedDir(dir)) {
      logStore.log("warn", ctx.isSrcDir(dir)
        ? "src 目录不允许导入资产（脚本目录，用「新建脚本」创建）"
        : "内置目录只读，不允许导入资产");
      return;
    }
    const picked = await api.pickImportFiles(`导入资产到 ${dir || "项目根"}`);
    if (!picked || picked.length === 0) return;
    await assetsStore.importPaths(root, dir, picked);
  }

  /** 导入目录按钮：多选文件夹后整体复制到目标目录 */
  async function doImportFolder(dir: string = ctx.currentDir.value): Promise<void> {
    const root = projectStore.currentPath;
    if (!root) return;
    if (!ctx.importAllowedDir(dir)) {
      logStore.log("warn", ctx.isSrcDir(dir)
        ? "src 目录不允许导入文件夹（脚本目录，用「新建脚本」创建）"
        : "内置目录只读，不允许导入文件夹");
      return;
    }
    const picked = await api.pickImportFolders(`导入文件夹到 ${dir || "项目根"}`);
    if (!picked || picked.length === 0) return;
    await assetsStore.importPaths(root, dir, picked);
  }

  return {
    doNewFolder,
    doNewScene,
    doNewScript,
    doNewFromWorkshop,
    doNewMaterial,
    doNewShader,
    doNewSkybox,
    doNewTextureCube,
    doNewPrefab,
    doNewAnim,
    doImport,
    doImportFolder,
  };
}
