// ---------------------------------------------------------------------------
// 层级面板「添加节点」菜单：菜单项定义 + "节点类型串 → node.add 参数" 映射。
//
// 纯数据/纯函数（不依赖 store 与 Vue），便于冒烟测试覆盖"每个菜单项都能落地成
// 正确的节点类型"——曾经踩过的坑：菜单里加了新项但映射表没跟上，类型串落到默认
// 分支被静默建成空组。现在未知类型串返回 null，调用方提示而不是兜底。
// ---------------------------------------------------------------------------

/** 菜单项（分组项只有 label + children；分隔线项只有 separator） */
export interface AddMenuItem {
  label?: string;
  /** 节点类型串（mesh:box / light:point / shadow / group …） */
  type?: string;
  children?: AddMenuItem[];
  /** 分隔线 */
  separator?: true;
}

/** node.add 命令参数（kind 必填；几何/灯光/天空盒类型在各自主分支的 subtype 里） */
export interface AddNodeArgs {
  kind: string;
  parentId: string;
  subtype?: string;
  /** 显式命名（菜单不传 → 用引擎默认名） */
  name?: string;
}

/** 菜单数据源：几何基元（几何注册表）与脚本节点类型（脚本类 static nodeType 声明） */
export interface AddMenuSources {
  geometry: Array<{ key: string; label: string }>;
  scripts: Array<{ rel: string; name: string }>;
}

/**
 * 「添加节点」菜单项定义（顺序 = 展示顺序）。
 * 与界面文案一一对应；新增节点类型时在这里与 addNodeArgs 同步补一处。
 */
export function addNodeMenuItems(src: AddMenuSources): AddMenuItem[] {
  const items: AddMenuItem[] = [];
  // 基元列表由几何工厂注册表驱动（新增基元自动出现在菜单）
  items.push({
    label: "网格",
    children: src.geometry.map((g) => ({ label: g.label, type: `mesh:${g.key}` })),
  });
  items.push({ separator: true });
  items.push({
    label: "灯光",
    children: [
      { label: "Point Light", type: "light:point" },
      { label: "Directional Light", type: "light:directional" },
      { label: "Spot Light", type: "light:spot" },
      { label: "Ambient", type: "light:ambient" },
    ],
  });
  items.push({ separator: true });
  items.push({ label: "Camera", type: "camera" });
  items.push({ label: "Group", type: "group" });
  items.push({ label: "Audio Source", type: "audio" });
  items.push({ separator: true });
  items.push({
    label: "天空盒",
    children: [
      { label: "Procedural Skybox", type: "skybox:procedural" },
      { label: "Cube Skybox", type: "skybox:cube" },
    ],
  });
  // 脚本节点类型：脚本类用 static nodeType 声明的可创建节点
  if (src.scripts.length > 0) {
    items.push({ separator: true });
    items.push({
      label: "脚本节点",
      children: src.scripts.map((s) => ({ label: s.name, type: `script:${s.rel}` })),
    });
  }
  return items;
}

/**
 * 菜单类型串 → node.add 参数。
 * @returns 未知类型串返回 null（调用方提示，不再静默建成空组）
 */
export function addNodeArgs(
  type: string,
  parentId: string,
  name?: string,
): AddNodeArgs | null {
  const args: AddNodeArgs = { kind: "group", parentId };
  if (type === "group" || type === "node" || type === "empty") {
    args.kind = "group";
  } else if (type.startsWith("mesh:")) {
    args.kind = "mesh";
    args.subtype = type.slice("mesh:".length);
  } else if (type.startsWith("light:")) {
    args.kind = "light";
    args.subtype = type.slice("light:".length);
  } else if (type.startsWith("skybox:")) {
    args.kind = "skybox";
    args.subtype = type.slice("skybox:".length);
  } else if (type.startsWith("script:")) {
    args.kind = "script";
    args.subtype = type.slice("script:".length);
  } else if (type === "camera") {
    args.kind = "camera";
  } else if (type === "audio") {
    args.kind = "audio";
  } else {
    return null;
  }
  if (name && name.trim()) args.name = name.trim();
  return args;
}

/** 收集菜单里全部叶子类型串（冒烟测试逐项核对"菜单项 → 节点类型"用） */
export function collectAddMenuTypes(items: readonly AddMenuItem[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly AddMenuItem[]): void => {
    for (const it of list) {
      if (it.type) out.push(it.type);
      if (it.children) walk(it.children);
    }
  };
  walk(items);
  return out;
}
