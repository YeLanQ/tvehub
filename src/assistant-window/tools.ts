// 助手工具面：目录（OpenAI function-calling 格式）与执行器。
// 前端助手只做决策（调哪个工具 + 参数）；实际执行统一交后端大脑决策中心
// （brain_execute）：门控（行动边界三区 + 任务审批会话）→ devtools 命令模式
// 派发（权限门控 → Rust 直答 → 中控转发编辑器执行器）→ 观测回写。执行错误
// 以 { error } 结构回喂模型自纠。brain.* 大脑工具见 ./brain.ts。

import { api, type BrainExecOutcome } from "../lib/api";
import { findSkill, routeSkill, SKILLS, type AssistantSkill } from "./skills";
import { BRAIN_CATALOG, execBrainTool, type ToolSpec } from "./brain";

export type { ToolSpec };

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  };
}

/** 编辑器操作目录（全部经大脑决策中心派发；方法语义与 devtools 权限清单一致） */
const CATALOG: ToolSpec[] = [
  { method: "editor.state", description: "读编辑器当前状态：项目/场景/视图模式/选中/撤销栈。" },
  { method: "project.list", description: "列出最近项目（path/name/sceneCount）。" },
  { method: "project.create", description: "新建项目（默认 3D 模板，含场景/脚本/配置，无需编辑器）。", params: { name: "项目名", parent: "父目录绝对路径；缺省用默认项目位置（未设置时需显式提供）" }, required: ["name"] },
  { method: "project.open", description: "在编辑器中打开项目：无活跃编辑器窗口时新建一个编辑器窗口（等同首页打开，返回即就绪）；有活跃编辑器时切换其工作区。", params: { path: "项目绝对路径" }, required: ["path"] },
  { method: "project.close", description: "关闭当前项目回首页。" },
  { method: "scene.list", description: "列出项目内全部 .scene 场景（可带 root 指定工作区，无需打开编辑器）。", params: { root: "工作区项目根（缺省=当前工作区）" } },
  { method: "scene.open", description: "在编辑器中打开场景（需编辑器已开项目）。", params: { rel: "场景相对路径" }, required: ["rel"] },
  { method: "scene.save", description: "保存编辑器当前场景（需编辑器已开项目）。" },
  { method: "scene.write", description: "直写 .scene 场景文档（无需编辑器；引擎格式锁定：写入前按引擎同款规则校验 JSON 对象与 root 节点结构，校验不过拒写，不会产生引擎打不开的场景）。流程：asset.read 读原文 → 修改 → scene.write 整体回写 → project.open / scene.open 重载生效。节点级修改优先用 node.*（编辑器内可撤销）。", params: { rel: "场景相对路径（如 assets/Main.scene）", content: "完整场景文档 JSON 文本", root: "工作区项目根（缺省=当前工作区）" }, required: ["rel", "content"] },
  { method: "shader.write", description: "直写 .shader 效果着色器资产（引擎格式锁定：写入前按引擎着色器解析校验 Shader 指令行/Base 渲染分支/钩子名，校验不过拒写并回喂具体原因）。流程：先 load_repo 读工坊同类效果原型或 asset.read 读现有着色器，修改后 shader.write 整体回写。新建文件先 asset.create（type=shader）拿模板。", params: { path: "着色器相对路径（如 assets/fx/Wave.shader）", content: "完整着色器源码", root: "工作区项目根（缺省=当前工作区）" }, required: ["path", "content"] },
  { method: "scene.tree", description: "读编辑器会话的场景文档 JSON（需编辑器已开项目；未打开时可用 asset.read 直读 .scene 文件文本）。" },
  { method: "node.select", description: "选中节点（编辑器高亮）。", params: { id: "节点 id，空串取消选中" } },
  {
    method: "node.add",
    description:
      "添加节点。kind: group/mesh/light/camera/skybox/fog/audio/particle/nav/logic/terrain/ui/model；" +
      "mesh 用 subtype(box/sphere/…)、light 用 subtype(point/directional/spot/ambient)、model/audio/terrain 用 path=资产相对路径；" +
      "parent/parentId 指定父节点（值可为节点 id 或 \"root\"，缺省挂根）。" +
      "注意：脚本不是子节点——给节点挂用户脚本/组件一律用 node.component.add，不要 kind=script。",
    params: { kind: "节点类型", subtype: "子类型（mesh/light 用）", parentId: "父节点 id（或 parent）", name: "名称", path: "资产路径（model/audio/terrain）" },
    required: ["kind"],
  },
  { method: "node.remove", description: "删除节点。", params: { id: "节点 id" }, required: ["id"] },
  { method: "node.component.add", description: "给节点添加组件（属性面板组件卡同源；一次撤销）。脚本组件：不传 type，给 id=目标节点 id + script=脚本 .ts 相对路径（如 src/Player.ts）；内置组件：type=rigidBody/collider/light/audioSource/animationClip（light 可带 lightKind）。已挂载的同名脚本组件幂等返回；单实例内置组件重复挂载报错。", params: { id: "目标节点 id", script: "脚本 .ts 相对路径（脚本组件用；与 type 二选一）", type: "内置组件类型", lightKind: "灯光类型（type=light 时可选）" }, required: ["id"] },
  { method: "node.rename", description: "重命名节点。", params: { id: "节点 id", name: "新名称" }, required: ["id", "name"] },
  {
    method: "node.set",
    description:
      "设置节点属性。两种写法任选：① {id, prop, value} 单属性；② {id, ...字段} 字段包" +
      "（name/visible/active/tag/transform/position/rotation/scale 等可混写；transform 与" +
      "position/rotation/scale 支持部分字段逐轴合并，未给的分量保持原值）。",
    params: { id: "节点 id", prop: "属性名（写法①）", value: "值（写法①）" },
    required: ["id"],
  },
  { method: "preview.open", description: "导出并打开预览（切到预览视图）。" },
  { method: "preview.close", description: "关闭预览回场景视图。" },
  { method: "preview.start", description: "启动预览服务，返回 URL。" },
  { method: "preview.stop", description: "停止预览服务。" },
  { method: "preview.screenshot", description: "截取编辑器视口 PNG（base64）。" },
  { method: "asset.list", description: "列出项目资产（name/path/kind/size；无需打开编辑器）。", params: { root: "工作区项目根（缺省=当前工作区）" } },
  { method: "asset.read", description: "读项目内文本资产（二进制拒绝；.scene 可直读文本）。缺省整读（≤512KB，超长只回预览+totalLines）；给 startLine/endLine（1 基闭区间）则按行分页读，返回 startLine/endLine/totalLines/hasMore/nextStartLine——大文件或整读被截断时务必翻页读全再改写，不要拿半截内容当全文。", params: { path: "资产相对路径", startLine: "起始行（1 基，可缺省）", endLine: "结束行（闭区间，可缺省=到文件尾）", root: "工作区项目根（缺省=当前工作区）" }, required: ["path"] },
  { method: "asset.write", description: "写项目内文本资产（脚本/文档/普通 JSON 等；自动建父目录）。引擎结构化格式已锁定：.scene 必须走 scene.write；.shader 必须走 shader.write；.meta/.fsm/.bt/.mat/.terrain/.terrainmat/根 *.config.json/二进制模型音视频拒绝直写。", params: { path: "资产相对路径", content: "完整文本内容", root: "工作区项目根（缺省=当前工作区）" }, required: ["path", "content"] },
  { method: "asset.create", description: "新建资产（需编辑器已开项目；未打开时可用 asset.write 写文本文件代替）。", params: { type: "类型", dir: "目标目录（缺省 assets）", name: "名称（缺省自动）" }, required: ["type"] },
  { method: "asset.select", description: "选中资产（检查器预览）。", params: { path: "资产相对路径" }, required: ["path"] },
  { method: "asset.delete", description: "删除资产。", params: { path: "资产相对路径" }, required: ["path"] },
  { method: "asset.rename", description: "重命名资产。", params: { path: "旧路径", newName: "新名称" }, required: ["path", "newName"] },
  { method: "file.index", description: "为工作区大文本文件建模块索引（切分+摘要+向量化，落盘缓存），返回文件摘要与模块目录（标题/行号）。@引用的大文件发送时已自动建索引；文件改动后可用它刷新。", params: { path: "文件相对路径", root: "工作区项目根（缺省=当前工作区）" }, required: ["path"] },
  { method: "file.search", description: "在已索引的大文件内按语义模糊匹配检索模块，返回相关段落摘录与行号——需要大文件的局部内容时优先用它，不要用 asset.read 整读。索引缺失/文件已变会自动重建。", params: { path: "文件相对路径", query: "检索关键词或语义描述", topK: "命中条数（缺省 2，上限 5）", root: "工作区项目根（缺省=当前工作区）" }, required: ["path", "query"] },
  { method: "file.module", description: "读已索引文件的单个模块全文：按 file.index 模块目录里的 no（序号，1 基）或 title（标题，精确优先、片段模糊兜底）定位，返回模块正文与行区间。要完整读大文件的某一段时用它（file.search 只给摘录，file.module 给全文）。", params: { path: "文件相对路径", no: "模块序号（file.index 目录顺序；与 title 二选一）", title: "模块标题（支持片段匹配）", root: "工作区项目根（缺省=当前工作区）" }, required: ["path"] },
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

/** 全量工具目录（devtools 方法 + brain 大脑工具 + load_skill/load_doc），发给 LLM 的 tools 数组 */
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
    {
      type: "function",
      function: {
        name: "load_doc",
        description:
          "读取应用内置官方文档全文（编辑器操作/SDK API）。文档 id 见系统提示词「可加载资料索引」" +
          "（如 sdk/tween.md），带 id 调用、勿空参试探；大脑知识命中给出的文档摘要需要展开时也用它。",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "文档相对路径，如 sdk/tween.md" } },
          required: ["id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "load_repo",
        description:
          "读取创意工坊资源全文（public/repos 的脚本原型/效果着色器等文本资产）。" +
          "可用 id 见系统提示词「可加载资料索引」（如 code/Rotator.ts），带 id 调用、勿空参试探；" +
          "写脚本/效果前先读相关原型全文再动手，不要凭文件名猜内容。",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "资源相对 id：<分类>/<文件名>" } },
          required: ["id"],
        },
      },
    },
  ];
}

/** 接受工作区 root 覆盖的方法（助手自动注入当前工作区项目根） */
export const ROOT_METHODS = new Set([
  "scene.list",
  "scene.write",
  "shader.write",
  "asset.list",
  "asset.read",
  "asset.write",
  "file.index",
  "file.search",
  "file.module",
]);

/** 工具执行确认回调：决策中心对黄灯写操作返回 needConfirm 时，由 UI 弹出
 * 请求用户批准；resolve(true)=批准并重发，resolve(false)=用户拒绝。 */
export type ConfirmFn = (info: { method: string; reason: string }) => Promise<boolean>;

/** 注入工作区 root（纯函数便于单测）：目录内方法且调用方未显式指定时补上 */
export function injectWorkspaceRoot(
  name: string,
  params: Record<string, unknown>,
  workspaceRoot?: string,
): Record<string, unknown> {
  if (workspaceRoot && ROOT_METHODS.has(name) && !params.root) {
    return { ...params, root: workspaceRoot };
  }
  return params;
}

/**
 * node.add 参数归一（纯函数便于单测；助手通道专用，devtools 直连命令层不经过）：
 * ① rel 与 subtype 互补——模型惯写 rel 当脚本路径、惯写 subtype 当 kind 细分；
 * ② parent → parentId 别名；③ name 半角逗号截断（名字里跟说明会把「跟随相机,
 * 弹性」整段吞进名字）与首尾空白；未提供 name 时不注入空 name（保持引擎默认名）。
 */
export function normalizeNodeAddArgs(params: Record<string, unknown>): Record<string, unknown> {
  const p = { ...params };
  const hasSub = p.subtype != null && String(p.subtype).trim() !== "";
  const hasRel = p.rel != null && String(p.rel).trim() !== "";
  if (hasRel && !hasSub) p.subtype = String(p.rel).trim();
  else if (!hasRel && hasSub) p.rel = String(p.subtype).trim();
  if (p.parent != null && p.parentId == null) {
    p.parentId = p.parent;
    delete p.parent;
  }
  if (typeof p.name === "string") {
    const name = p.name.split(/[,，]/)[0].trim();
    if (name) p.name = name;
    else delete p.name;
  }
  return p;
}

/** 技能加载参数解析（纯函数便于单测）：显式 id > 关键词路由（routeSkill）>
 * 问句剥词元匹配注册表 id > 注册表首项。弱模型漏传 id 的 load_skill({}) 从
 * 当前任务文本推断本意技能，省掉一次错误往返。 */
export function parseAssistantSkill(
  explicitId: unknown,
  task: string,
  registry: AssistantSkill[],
): string {
  const explicit = String(explicitId ?? "").trim();
  if (explicit) return explicit;
  const ids = new Set(registry.map((s) => s.id));
  const routed = routeSkill(task);
  if (routed && ids.has(routed.id)) return routed.id;
  const tokens = String(task ?? "")
    .split(/[\s,，。、:：；;()（）「」《》“”"']+/)
    .filter((t) => t.length >= 2);
  const wanted = new Set(tokens.map((t) => t.toLowerCase()));
  const hit = registry.find((s) => wanted.has(s.id.toLowerCase()));
  return hit?.id ?? registry[0]?.id ?? "";
}

/** 决策中心回执 → 工具结果（纯函数便于单测）：ok 透传 result；needConfirm
 * 无确认回调时按错误回喂；denied/异常一律 { error } 结构让模型自行调整 */
export function outcomeToToolResult(out: BrainExecOutcome, method: string): unknown {
  if (out.status === "ok") {
    return out.result ?? { error: `「${method}」执行回执缺少结果` };
  }
  if (out.status === "denied") {
    return { error: `大脑拒绝执行「${method}」: ${out.reason}` };
  }
  return { error: `「${method}」需用户确认后执行: ${out.reason}` };
}

/**
 * 助手通道语义改写（纯函数便于单测）：模型惯把「挂脚本」写成 node.add 的
 * kind=script 子节点——用户语义是"把脚本作为组件挂到节点属性面板"。该形态
 * 统一改写为 node.component.add 组件挂载；缺目标节点/脚本路径时回喂教学
 * 错误。编辑器与 devtools 直连命令层不经过此改写。
 */
export function rewriteScriptAttach(
  name: string,
  params: Record<string, unknown>,
): { name: string; params: Record<string, unknown> } | { error: string } {
  const kind = String(params.kind ?? params.type ?? "").toLowerCase();
  if (name !== "node.add" || (kind !== "script" && kind !== "scriptnode")) {
    return { name, params };
  }
  const target = params.parentId ?? params.parent;
  const script = params.rel ?? params.script ?? params.path ?? params.subtype;
  if (!target || !script) {
    return {
      error:
        '挂脚本是作为「组件」挂到目标节点的属性面板，不是子节点：node.component.add { id: "节点id", script: "src/X.ts" }（节点 id 可用 scene.tree 查询；不要用 node.add kind=script）',
    };
  }
  return { name: "node.component.add", params: { id: target, script } };
}

/** 工作区内容写操作：成功执行后投递 assistant:workspace-changed，助手面板
 *  的浮动文件树即时刷新（不必关开重查）。经大脑决策中心的方法集中在此。 */
const WORKSPACE_WRITE_METHODS = new Set([
  "asset.write",
  "scene.write",
  "shader.write",
  "scene.save",
  "asset.create",
  "asset.delete",
  "asset.rename",
  "node.add",
  "node.remove",
  "node.rename",
  "node.set",
  "node.component.add",
]);

function notifyWorkspaceChanged(method: string): void {
  if (!WORKSPACE_WRITE_METHODS.has(method)) return;
  window.dispatchEvent(new CustomEvent("assistant:workspace-changed", { detail: { method } }));
}

/**
 * 执行一个工具调用。永不抛错——失败返回 { error } 结构回喂模型自纠；
 * load_skill 读本地注册表；brain.* 直连大脑（决策咨询，不入观测）；
 * 其余全部经后端大脑决策中心（brain_execute）：绿灯只读直接执行；黄灯写
 * 操作未批准时返回 needConfirm——有确认回调则弹批准，批准登记审批会话后
 * 自动重发（同任务后续黄灯调用在有效期内直接放行）；观测由后端在执行闭环
 * 内回写，前端不再上报。
 */
export async function execAssistantTool(
  name: string,
  argsJson: string,
  workspaceRoot?: string,
  task = "",
  requestConfirm?: ConfirmFn,
): Promise<{ error: string } | unknown> {
  let params: Record<string, unknown> = {};
  if (argsJson && argsJson.trim()) {
    try {
      params = JSON.parse(argsJson) as Record<string, unknown>;
    } catch {
      return { error: `参数 JSON 解析失败（工具 ${name}）：请重发合法 JSON` };
    }
  }
  // 助手通道参数归一：node.add 别名（rel/parent/逗号名）集中在此，命令层兼容 devtools 旧契约
  if (name === "node.add") params = normalizeNodeAddArgs(params);
  // 助手通道语义改写：kind=script 子节点 → 节点挂脚本组件（用户语义即"挂组件"）
  const rewritten = rewriteScriptAttach(name, params);
  if ("error" in rewritten) return { error: rewritten.error };
  name = rewritten.name;
  params = rewritten.params;
  try {
    if (name === "load_skill") {
      const id = parseAssistantSkill(params.id, task, SKILLS);
      const skill = findSkill(id);
      if (skill) {
        return { id: skill.id, name: skill.name, content: skill.body };
      }
      // 前端注册表是硬编码子集；大脑注入的内嵌技能 id 以构建期为单一事实源
      const embedded = await api.brainSkillGet(id).catch(() => null);
      if (embedded) {
        return { id: embedded.id, name: embedded.name, content: embedded.body };
      }
      return { error: `未知技能: ${id}` };
    }
    if (name === "load_doc") {
      const args = params as { id?: string };
      const rawId = String(args.id ?? "").trim();
      // 缺 id：回喂文档目录（而非只报错），模型一轮内即可选定正确文档
      if (!rawId) {
        const docs = await api.docsList().catch(() => []);
        return { error: "缺少 id（文档相对路径）", docs };
      }
      const id = rawId.replace(/^\/+|\.md$/g, "") + ".md";
      const doc = await api.docsRead(id).catch(() => null);
      if (!doc) {
        const docs = await api.docsList().catch(() => []);
        return { error: `未知文档: ${args.id}（id 需与下列目录一致，勿凭空构造）`, docs };
      }
      return { id: doc.id, title: doc.title, content: doc.body };
    }
    if (name === "load_repo") {
      const args = params as { id?: string };
      const rawId = String(args.id ?? "").trim();
      // 缺 id：回喂工坊资源目录（含外部 repos 最新状态），模型一轮内选定
      if (!rawId) {
        const repos = await api.reposDocList().catch(() => []);
        return { error: "缺少 id（格式 <分类>/<文件名>）", repos };
      }
      const doc = await api.reposDocRead(rawId).catch(() => null);
      if (!doc) {
        const repos = await api.reposDocList().catch(() => []);
        return { error: `未知工坊资源: ${rawId}（id 需与下列目录一致，勿凭空构造）`, repos };
      }
      return { id: doc.id, title: doc.title, content: doc.body };
    }
    if (name.startsWith("brain.")) {
      return await execBrainTool(name, params, task);
    }
    params = injectWorkspaceRoot(name, params, workspaceRoot);
    let out = await api.brainExecute({ task, method: name, params });
    if (out.status === "needConfirm" && requestConfirm) {
      const approved = await requestConfirm({ method: name, reason: out.reason });
      if (!approved) {
        return { error: `用户拒绝执行「${name}」，请改为只读方案或终止任务` };
      }
      // 批准登记审批会话（同任务后续黄灯调用直接放行），重发本次调用
      await api.brainApprove(task);
      out = await api.brainExecute({ task, method: name, params });
    }
    const result = outcomeToToolResult(out, name);
    if (out.status === "ok") notifyWorkspaceChanged(name);
    return result;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
