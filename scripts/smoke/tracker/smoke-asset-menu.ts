// ---------------------------------------------------------------------------
// 资产面板右键菜单冒烟测试（Node 运行；vite --ssr 打包）：
// asset-menu 是纯函数模块（结构/守卫集中于此），这里用桩 AssetMenuApi 覆盖
// 「创意工坊」子菜单：创意工坊 ▸ 标签（仓库分类）▸ 该标签内容，以及
// 可见范围（不局限 src）、内容适配（src 内不出现效果项）、点击行为。
// 运行：pnpm smoke asset-menu
// ---------------------------------------------------------------------------
import {
  buildEntryMenu,
  buildContentMenu,
  buildBlankMenu,
  type AssetMenuApi,
  type MenuWorkshopCategory,
  type MenuWorkshopItem,
} from "../../../src/app/lib/asset-menu";
import type { ChildEntry } from "../../../src/app/lib/asset-browser";
import {
  MENU_EDGE_MARGIN,
  SUBMENU_LIP,
  clampMenuX,
  clampMenuY,
  pickSubmenuX,
  type CtxMenuItem,
} from "../../../src/lib/editor/context-menu";
import { createSuite } from "../harness.mjs";

const { ok, finish } = createSuite();

/** 桩分类数据（与实际一致：标签名 = repos 目录名首字母大写） */
const workshops: MenuWorkshopCategory[] = [
  {
    id: "code",
    label: "Code",
    items: [
      { category: "code", file: "Spin.ts", name: "Spin", kind: "script" },
      { category: "code", file: "Follow.ts", name: "Follow", kind: "script" },
    ],
  },
  {
    id: "effect",
    label: "Effect",
    items: [
      { category: "effect", file: "HologramExt.shader", name: "HologramExt", kind: "shader" },
      { category: "effect", file: "DissolveExt.shader", name: "DissolveExt", kind: "shader" },
    ],
  },
];

/** 桩菜单 API：记录回调参数，守卫与真实面板一致 */
function makeApi(over: Partial<AssetMenuApi> = {}): {
  api: AssetMenuApi;
  calls: Record<string, unknown[]>;
} {
  const calls: Record<string, unknown[]> = {};
  const track =
    (name: string) =>
    (...args: unknown[]): void => {
      calls[name] = args;
    };
  const api: AssetMenuApi = {
    isInternal: (p) => p === "internal" || p.startsWith("internal/"),
    isProtected: (p) => p === "assets" || p === "src" || p === "internal" || p.startsWith("internal/"),
    isSrcDir: (d) => d === "src" || d.startsWith("src/"),
    importAllowed: (d) => !(d === "src" || d.startsWith("src/")) && !d.startsWith("internal"),
    shaderTypes: () => [{ key: "physical", label: "PBR着色器" }],
    onOpenDir: track("onOpenDir"),
    onAddModelToScene: track("onAddModelToScene"),
    onCompressDraco: track("onCompressDraco"),
    onAddAudioToScene: track("onAddAudioToScene"),
    onInstantiatePrefab: track("onInstantiatePrefab"),
    onOpenScript: track("onOpenScript"),
    onCopyInternal: track("onCopyInternal"),
    onCopy: track("onCopy"),
    onRename: track("onRename"),
    onDelete: track("onDelete"),
    onNewScene: track("onNewScene"),
    onNewScript: track("onNewScript"),
    workshops: () => workshops,
    onNewFromWorkshop: track("onNewFromWorkshop"),
    onNewFolder: track("onNewFolder"),
    onNewMaterial: track("onNewMaterial"),
    onNewShader: track("onNewShader"),
    onNewSkybox: track("onNewSkybox"),
    onNewTextureCube: track("onNewTextureCube"),
    onNewPrefab: track("onNewPrefab"),
    onNewAnim: track("onNewAnim"),
    onImport: track("onImport"),
    onImportFolder: track("onImportFolder"),
    onCopyPath: track("onCopyPath"),
    onRefresh: track("onRefresh"),
    ...over,
  };
  return { api, calls };
}

const dirEntry = (path: string): ChildEntry => ({ path, name: path.split("/").pop() ?? path, kind: "dir" });
const internalFileMenu = (api: AssetMenuApi): CtxMenuItem[] =>
  buildEntryMenu({ path: "internal/shaders/PBR.shader", name: "PBR.shader", kind: "shader" }, api);
const labels = (items: CtxMenuItem[]): string[] =>
  items.filter((i) => !("separator" in i)).map((i) => i.label ?? "");
const workshop = (items: CtxMenuItem[]): CtxMenuItem | undefined =>
  items.find((i) => i.label === "创意工坊");
/** 创意工坊 ▸ 标签名 → 该标签下的内容名列表 */
const workshopTree = (items: CtxMenuItem[]): Record<string, string[]> => {
  const ws = workshop(items);
  const out: Record<string, string[]> = {};
  for (const cat of ws?.children ?? []) {
    out[cat.label ?? ""] = (cat.children ?? []).map((c) => c.label ?? "");
  }
  return out;
};

// —— 1. 结构与可见范围 ——
console.log("[1] 创意工坊 ▸ 标签 ▸ 内容");
{
  const { api } = makeApi();

  const assetsChild = workshopTree(buildEntryMenu(dirEntry("assets/materials"), api));
  ok(!!assetsChild.Code && !!assetsChild.Effect, "assets 子目录：Code 与 Effect 两个标签");
  ok(assetsChild.Code?.join(",") === "Spin,Follow", "Code 标签下为该分类内容（脚本原型）");
  ok(assetsChild.Effect?.join(",") === "HologramExt,DissolveExt", "Effect 标签下为该分类内容（效果原型）");
  ok(labels(buildEntryMenu(dirEntry("assets/materials"), api)).includes("新建材质"), "原有新建项保留");

  const srcTree = workshopTree(buildEntryMenu(dirEntry("src"), api));
  ok(!!srcTree.Code && !srcTree.Effect, "src 目录：只显示 Code（着色器不能建在 src）");
  ok(labels(buildEntryMenu(dirEntry("src"), api)).includes("新建脚本"), "src 目录仍保留「新建脚本」");

  const srcSub = workshopTree(buildEntryMenu(dirEntry("src/utils"), api));
  ok(!!srcSub.Code && !srcSub.Effect, "src 子目录：只显示 Code");

  const assetsRoot = workshopTree(buildEntryMenu(dirEntry("assets"), api));
  ok(!!assetsRoot.Code && !!assetsRoot.Effect, "assets 固定根目录：两个标签都在");

  const other = workshopTree(buildEntryMenu(dirEntry("docs"), api));
  ok(!!other.Code, "其它项目目录：出现创意工坊");

  ok(!workshop(buildEntryMenu(dirEntry("internal/shaders"), api)), "内置只读目录：无创意工坊");
  ok(!workshop(internalFileMenu(api)), "内置文件：无创意工坊");
}

// —— 2. 空白处右键 ——
console.log("[2] 空白处右键");
{
  const { api } = makeApi();
  ok(!!workshop(buildContentMenu("assets/materials", api)), "内容区（assets 子目录）有创意工坊");
  ok(!!workshop(buildContentMenu("src", api)), "内容区（src）有创意工坊");
  ok(!!workshop(buildBlankMenu(api)), "目录树空白处（assets 根）有创意工坊");
  ok(!workshop(buildContentMenu("internal/materials", api)), "内置目录内容区无创意工坊");
}

// —— 3. 点击行为 ——
console.log("[3] 点击行为");
{
  const { api, calls } = makeApi();
  const tree = workshop(buildEntryMenu(dirEntry("assets/materials"), api))!;
  const effectCat = tree.children!.find((c) => c.label === "Effect")!;
  effectCat.children![0].onClick?.({} as never);
  const args = calls.onNewFromWorkshop ?? [];
  ok(args[0] === "assets/materials", "回调带右键目录");
  ok((args[1] as MenuWorkshopItem)?.file === "HologramExt.shader", "回调带来源文件");
  ok(
    (args[1] as MenuWorkshopItem)?.kind === "shader",
    "效果项 kind = shader（落盘当前目录为 .shader 资产）",
  );

  const { api: api2, calls: calls2 } = makeApi();
  const tree2 = workshop(buildEntryMenu(dirEntry("assets/materials"), api2))!;
  const codeCat = tree2.children!.find((c) => c.label === "Code")!;
  codeCat.children![1].onClick?.({} as never);
  ok((calls2.onNewFromWorkshop?.[1] as MenuWorkshopItem)?.kind === "script", "脚本项 kind = script（落盘 src/）");
  ok(
    (calls2.onNewFromWorkshop?.[1] as MenuWorkshopItem)?.file === "Follow.ts",
    "脚本项带来源文件",
  );
}

// —— 4. 空数据与原有菜单项 ——
console.log("[4] 空数据与原有菜单项");
{
  const empty = makeApi({ workshops: () => [] });
  ok(!workshop(buildEntryMenu(dirEntry("src"), empty.api)), "无分类时：src 菜单无创意工坊");
  ok(!workshop(buildEntryMenu(dirEntry("assets/materials"), empty.api)), "无分类时：assets 菜单无创意工坊");
  ok(!workshop(buildContentMenu("assets", empty.api)), "无分类时：内容区菜单无创意工坊");

  const onlyEffect = makeApi({ workshops: () => [workshops[1]] });
  ok(!workshop(buildEntryMenu(dirEntry("src"), onlyEffect.api)), "src 下效果分类无可用项 → 不显示空子菜单");

  const { api } = makeApi();
  const file = buildEntryMenu({ path: "assets/models/x.glb", name: "x.glb", kind: "glb" }, api);
  ok(labels(file).includes("添加到场景"), "模型文件仍有「添加到场景」");
  ok(
    labels(file).includes("复制") && labels(file).includes("重命名") && labels(file).includes("删除"),
    "普通文件仍有复制/重命名/删除",
  );
  ok(!!workshop(file), "assets 下文件项带所在目录的创意工坊");
  ok(!workshop(internalFileMenu(api)), "内置文件项无创意工坊");
  const srcFile = buildEntryMenu({ path: "src/Spin.ts", name: "Spin.ts", kind: "ts" }, api);
  ok(labels(srcFile).includes("打开脚本"), "脚本文件仍有「打开脚本」");
  ok(labels(internalFileMenu(api)).includes("复制到项目"), "内置文件仍有「复制到项目」");
}

// —— 5. 菜单定位：子菜单不覆盖上一级、不越出窗口 ——
console.log("[5] 菜单定位（子菜单溢出翻转）");
{
  const W = 1280;
  // 窗口中部：贴父菜单右侧（子菜单左边缘 = 锚点），不与父级内容重叠
  ok(
    pickSubmenuX({ anchorRight: 400, parentLeft: 200, width: 200, windowWidth: W, ancestorRanges: [] }) ===
      400,
    "空间充足：贴父菜单右侧展开",
  );

  // 贴右边缘：右侧放不下 → 翻到父菜单左侧，右边缘仅与父级左边缘贴合 SUBMENU_LIP
  const flipped = pickSubmenuX({
    anchorRight: W - 40,
    parentLeft: W - 240,
    width: 200,
    windowWidth: W,
    ancestorRanges: [],
  });
  ok(flipped === W - 240 - 200 + SUBMENU_LIP, "贴右边缘：翻到父菜单左侧");
  ok(flipped + 200 <= W - MENU_EDGE_MARGIN, "翻到左侧后仍在窗口内");
  ok(flipped + 200 <= W - 240 + SUBMENU_LIP, "右边缘只与父级边缘重叠 lip（不盖住父级）");

  // 三级链贴右边缘（与实测一致）：第 1 级收拢到 [1072,1272]，第 2 级翻到其左侧 [874,1074]，
  // 第 3 级贴父级右侧会压住第 1 级 → 应改翻到父级左侧 [676,876]，两级都不被覆盖
  const lvl0Left = W - 200 - MENU_EDGE_MARGIN; // 1072
  const lvl1Left = lvl0Left - 200 + SUBMENU_LIP; // 874
  const third = pickSubmenuX({
    anchorRight: lvl1Left + 200 - 6, // 父项右边缘（菜单内缩 6px）
    parentLeft: lvl1Left,
    width: 200,
    windowWidth: W,
    ancestorRanges: [[lvl0Left, W - MENU_EDGE_MARGIN]],
  });
  ok(third === lvl1Left - 200 + SUBMENU_LIP, "三级链：改翻到父级左侧");
  ok(third + 200 <= lvl1Left + SUBMENU_LIP, "三级链：不覆盖直接父级（只贴合 lip）");
  ok(third + 200 <= lvl0Left + SUBMENU_LIP, "三级链：不覆盖第 1 级");

  // 两侧都放不下（窗口极窄）：收拢到窗口内，不越界
  const narrow = pickSubmenuX({
    anchorRight: 300,
    parentLeft: 100,
    width: 260,
    windowWidth: 400,
    ancestorRanges: [[0, 100]],
  });
  ok(narrow >= MENU_EDGE_MARGIN && narrow + 260 <= 400 - MENU_EDGE_MARGIN, "空间不足：收拢进窗口");

  // 根级水平收拢 + 垂直收拢（贴右下角右键）
  ok(clampMenuX(1270, 200, W) === W - 200 - MENU_EDGE_MARGIN, "根级贴右边缘：水平收拢");
  ok(clampMenuX(10, 200, W) === 10, "根级空间充足：保持鼠标位置");
  ok(clampMenuY(710, 120, 720) === 720 - 120 - MENU_EDGE_MARGIN, "贴下边缘：垂直收拢");
  ok(clampMenuY(20, 120, 720) === 20, "上方空间充足：保持鼠标位置");
}

finish();