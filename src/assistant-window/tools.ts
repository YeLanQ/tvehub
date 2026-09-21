// 助手工具面：目录（OpenAI function-calling 格式）与执行器。
// 所有编辑器操作统一经 devtools 内部桥（devtoolsCall）——与外部控制端同一
// method → command 映射与工具权限门控；执行错误以 { error } 结构回喂模型自纠。
// brain.* 大脑工具见 ./brain.ts（直连进程内 Rust 大脑，含执行后自动观测）。

import { api } from "../lib/api";
import { findSkill } from "./skills";
import { BRAIN_CATALOG, execBrainTool, observeExecution, type ToolSpec } from "./brain";

export type { ToolSpec };

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  };
}

/** 编辑器操作目录（全部走内部 devtools；方法语义与 devtools 权限清单一致） */
const CATALOG: ToolSpec[] = [
  { method: "editor.state", description: "读编辑器当前状态：项目/场景/视图模式/选中/撤销栈。" },
  { method: "project.list", description: "列出最近项目（path/name/sceneCount）。" },
  { method: "project.create", description: "新建项目（默认 3D 模板，含场景/脚本/配置，无需编辑器）。", params: { name: "项目名", parent: "父目录绝对路径；缺省用默认项目位置，再缺省弹目录选择" }, required: ["name"] },
  { method: "project.open", description: "在编辑器中打开项目（切换编辑器工作区；不需要打开也能读写资产）。", params: { path: "项目绝对路径" }, required: ["path"] },
  { method: "project.close", description: "关闭当前项目回首页。" },
  { method: "scene.list", description: "列出项目内全部 .scene 场景（可带 root 指定工作区，无需打开编辑器）。", params: { root: "工作区项目根（缺省=当前工作区）" } },
  { method: "scene.open", description: "在编辑器中打开场景（需编辑器已开项目）。", params: { rel: "场景相对路径" }, required: ["rel"] },
  { method: "scene.save", description: "保存编辑器当前场景（需编辑器已开项目）。" },
  { method: "scene.tree", description: "读编辑器会话的场景文档 JSON（需编辑器已开项目；未打开时可用 asset.read 直读 .scene 文件文本）。" },
  { method: "node.select", description: "选中节点（编辑器高亮）。", params: { id: "节点 id，空串取消选中" } },
  {
    method: "node.add",
    description:
      "添加节点。kind: group/mesh/light/camera/skybox/fog/audio/particle/nav/logic/terrain/ui/script/model；mesh 用 subtype(box/sphere/…)、light 用 subtype(point/directional/spot/ambient)、model 用 path（资产相对路径）。",
    params: { kind: "节点类型", subtype: "子类型（mesh/light 用）", parentId: "父节点 id，缺省挂根", name: "名称", path: "模型资产路径（kind=model 时）" },
    required: ["kind"],
  },
  { method: "node.remove", description: "删除节点。", params: { id: "节点 id" }, required: ["id"] },
  { method: "node.rename", description: "重命名节点。", params: { id: "节点 id", name: "新名称" }, required: ["id", "name"] },
  { method: "node.set", description: "设置节点属性（visible/active/tag 等）。", params: { id: "节点 id", prop: "属性名", value: "值" }, required: ["id", "prop", "value"] },
  { method: "preview.open", description: "导出并打开预览（切到预览视图）。" },
  { method: "preview.close", description: "关闭预览回场景视图。" },
  { method: "preview.start", description: "启动预览服务，返回 URL。" },
  { method: "preview.stop", description: "停止预览服务。" },
  { method: "preview.screenshot", description: "截取编辑器视口 PNG（base64）。" },
  { method: "asset.list", description: "列出项目资产（name/path/kind/size；无需打开编辑器）。", params: { root: "工作区项目根（缺省=当前工作区）" } },
  { method: "asset.read", description: "读项目内文本资产内容（≤512KB，二进制拒绝；.scene 可直读文本）。", params: { path: "资产相对路径", root: "工作区项目根（缺省=当前工作区）" }, required: ["path"] },
  { method: "asset.write", description: "写项目内文本资产（自动建父目录；改脚本/材质/场景 JSON 等文本用，无需打开编辑器）。", params: { path: "资产相对路径", content: "完整文本内容", root: "工作区项目根（缺省=当前工作区）" }, required: ["path", "content"] },
  { method: "asset.create", description: "新建资产（需编辑器已开项目；未打开时可用 asset.write 写文本文件代替）。", params: { type: "类型", dir: "目标目录（缺省 assets）", name: "名称（缺省自动）" }, required: ["type"] },
  { method: "asset.select", description: "选中资产（检查器预览）。", params: { path: "资产相对路径" }, required: ["path"] },
  { method: "asset.delete", description: "删除资产。", params: { path: "资产相对路径" }, required: ["path"] },
  { method: "asset.rename", description: "重命名资产。", params: { path: "旧路径", newName: "新名称" }, required: ["path", "newName"] },
];

function specToTool(spec: ToolSpec): OpenAITool {
  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec.params ?? {})) {
    properties[k] = { type: "string", description: v };
  }
  return {
    type: "function",
    function: {
      name: spec.method,
      description: spec.description,
      parameters: { type: "object", properties },
    },
  };
}

/** 全量工具目录（devtools 方法 + brain 大脑工具 + load_skill），发给 LLM 的 tools 数组 */
export function assistantTools(): OpenAITool[] {
  return [
    ...CATALOG.map(specToTool),
    ...BRAIN_CATALOG.map(specToTool),
    {
      type: "function",
      function: {
        name: "load_skill",
        description: "加载领域技能全文（操作手册/脚本模板/交付纪律）。索引见系统提示词。",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "技能 id" } },
          required: ["id"],
        },
      },
    },
  ];
}

/** 接受工作区 root 覆盖的方法（助手自动注入当前工作区项目根） */
const ROOT_METHODS = new Set(["scene.list", "asset.list", "asset.read", "asset.write"]);

/**
 * 执行一个工具调用。永不抛错——失败返回 { error } 结构回喂模型自纠；
 * load_skill 读本地注册表；brain.* 直连大脑（不走 devtools，也不入观测）；
 * project.create 在前端完成（模板 fetch + 建项目，不依赖编辑器）；其余经
 * devtools 内部桥，自动注入当前工作区 root。每次执行结束后异步上报大脑
 * （任务/成败/耗时）——驱动因果链进化与效能门控，不阻塞工具返回。
 */
export async function execAssistantTool(
  name: string,
  argsJson: string,
  workspaceRoot?: string,
  task = "",
): Promise<{ error: string } | unknown> {
  const started = performance.now();
  try {
    if (name === "load_skill") {
      const args = JSON.parse(argsJson || "{}") as { id?: string };
      const skill = findSkill(String(args.id ?? ""));
      if (!skill) return { error: `未知技能: ${args.id}` };
      return { id: skill.id, name: skill.name, content: skill.body };
    }
    let params: Record<string, unknown> = {};
    if (argsJson && argsJson.trim()) {
      params = JSON.parse(argsJson) as Record<string, unknown>;
    }
    if (name.startsWith("brain.")) {
      return await execBrainTool(name, params, task);
    }
    let result: { error: string } | unknown;
    if (name === "project.create") {
      result = await createWorkspaceProject(params);
    } else {
      if (workspaceRoot && ROOT_METHODS.has(name) && !params.root) {
        params.root = workspaceRoot;
      }
      result = await api.devtoolsCall(name, params);
    }
    observeExecution(name, started, result, task);
    return result;
  } catch (e) {
    const result = { error: e instanceof Error ? e.message : String(e) };
    observeExecution(name, started, result, task);
    return result;
  }
}

/** 新建项目（前端流程）：默认 3D 模板 → fetch 模板文件 → Rust 脚手架 + 登记最近 */
export async function createWorkspaceProject(
  params: Record<string, unknown>,
): Promise<{ error: string } | unknown> {
  const name = String(params.name ?? "").trim();
  if (!name) return { error: "缺少 name 参数" };
  let parent = typeof params.parent === "string" ? params.parent.trim() : "";
  if (!parent) {
    const def = await api.getDefaultProjectDir();
    parent = def ?? (await api.pickProjectFolder()) ?? "";
  }
  if (!parent) return { error: "未提供 parent 且用户取消了目录选择" };
  const tplRes = await fetch("/templates/3d/template.json");
  if (!tplRes.ok) return { error: `读取默认模板失败: HTTP ${tplRes.status}` };
  const tpl = (await tplRes.json()) as { files?: string[] };
  const files: Record<string, string> = {};
  for (const rel of tpl.files ?? []) {
    const res = await fetch(`/templates/3d/${rel}`);
    if (!res.ok) return { error: `读取模板文件失败: ${rel} (HTTP ${res.status})` };
    files[rel] = await res.text();
  }
  return await api.createProject(parent, name, "builtin:3d", files);
}
