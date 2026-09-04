/** 工程模板：新建项目弹窗与模板管理页共用的数据结构 */
export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  /** 模板类别标识："3d" / "empty" 等；自定义模板为 "custom" */
  kind: string;
  builtin: boolean;
  path?: string | null;
}

/** 内置工程模板（数据驱动，模板管理不硬编码；新增模板即自动注册） */
export const BUILTIN_PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: "builtin:3d",
    name: "3D 模板",
    description: "包含基础场景、相机和光源的 3D 项目模板",
    kind: "3d",
    builtin: true,
    path: null,
  },
  {
    id: "builtin:empty",
    name: "空场景",
    description: "空白场景，从零开始创建",
    kind: "empty",
    builtin: true,
    path: null,
  },
];

/** 新建项目弹窗的模板类别（左侧栏） */
export interface CreateCat {
  id: string;
  label: string;
  match: (t: ProjectTemplate) => boolean;
}

/**
 * 从已加载的模板动态推导新建项目弹窗的模板类别（不硬编码）。
 * - 内置模板按 kind 分组：每个 kind 一个类别，标签取该 kind 下首个模板名称；
 * - 自定义模板归入「自定义模板」类别，仅在存在自定义模板时显示。
 */
export function createProjectCats(templates: ProjectTemplate[]): CreateCat[] {
  const cats: CreateCat[] = [];
  const seenKinds = new Set<string>();
  for (const t of templates) {
    if (!t.builtin) continue;
    if (seenKinds.has(t.kind)) continue;
    seenKinds.add(t.kind);
    cats.push({
      id: t.kind,
      label: t.name,
      match: (x) => x.builtin && x.kind === t.kind,
    });
  }
  if (templates.some((t) => !t.builtin)) {
    cats.push({ id: "custom", label: "自定义模板", match: (t) => !t.builtin });
  }
  return cats;
}