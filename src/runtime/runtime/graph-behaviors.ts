// ---------------------------------------------------------------------------
// 场景图行为解释器（预览/发布运行时入口；稳定产物路径 engine/runtime/graph-behaviors.mjs）。
//
// 本文件是薄门面：装配 kernel（类型无关引擎）+ 内置运行时模块（core-*）+
// 注入模块（L1 脚本图模块，经 modules 参数进入）。解释场景图文档，把图上对
// 原型定义的操作作为运行时行为执行 —— 不修改场景数据，只在运行期改变实体的
// 表现（与脚本语义一致：位姿/可见性/状态机事件）。
//
// 架构分层：
// - graph-kernel.ts     引擎：exec 链级联（推模型）/ 数据流拉模型 / 实体集通道 /
//                       容器递归调度 / 驱动器实例缓存 / 事件入口绑定 / 点击射线
// - graph-runtime.ts    kernel ↔ 模块的 handler 契约（GraphRuntimeModule）
// - graph-core-modules  内置类型语义（entity/ops/drivers/data/exec/containers）
//
// 类型语义扩展 = 注册一个 GraphRuntimeModule（与框架层 registerModule 的
// 类型目录按同一类型键对齐）；kernel 不含任何类型特判。
// 旧图兼容：无 exec 入边的 op/driver 节点按注册表 trigger 字段独立执行。
// ---------------------------------------------------------------------------

import type { ScriptGraphDoc } from "../../framework/graph";
import { createGraphKernel } from "./graph-kernel";
import { createCoreGraphModules } from "./graph-core-modules";
import type { GraphBehaviorsCtx, GraphBehaviorsHandle, GraphRuntimeModule } from "./graph-runtime";

export type { GraphBehaviorsCtx, GraphBehaviorsHandle, GraphRuntimeModule } from "./graph-runtime";

/**
 * 场景图引用到的实体 id 集（原型 entityId + 匹配节点命中的场景实体）。
 * 用途：静态批处理排除——批处理会把原网格置 visible=false 并渲染烘焙副本，
 * 而图在运行期移动的是树中的原对象，被吞掉后位姿变化没有任何视觉表现
 * （player 在 optimizeScene 之前调用本函数并把结果作为 excludeNodeIds）。
 */
export function graphReferencedEntityIds(
  graph: ScriptGraphDoc,
  sceneNodes: ({ id?: string; type?: string; tag?: string; json?: { id?: string; type?: string; tag?: string } })[],
): string[] {
  const ids = new Set<string>();
  const matches: { mode: "tag" | "type"; pattern: string }[] = [];
  for (const n of graph.nodes) {
    if (n.unresolved) continue;
    if (n.type === "entity.proto") {
      if (n.entityId) ids.add(n.entityId);
    } else if (n.type === "entity.match") {
      const pattern = n.matchPattern ?? "";
      if (pattern) matches.push({ mode: n.matchMode === "type" ? "type" : "tag", pattern });
    }
  }
  if (matches.length) {
    for (const entry of sceneNodes) {
      // 兼容 buildSceneTree 的 { json, obj } 条目与裸场景 JSON
      const src = entry?.json ?? entry;
      const id = typeof src?.id === "string" ? src.id : "";
      if (!id) continue;
      const kind = typeof src.type === "string" ? src.type : "";
      const tag = typeof src.tag === "string" ? src.tag : "";
      for (const m of matches) {
        if (m.mode === "type" ? kind === m.pattern : tag === m.pattern) {
          ids.add(id);
          break;
        }
      }
    }
  }
  return [...ids];
}

/**
 * 装配图行为：内置 core 模块 + 外部注入模块按序合并（先注册的类型键语义优先）。
 * player 检测到 config.scriptGraph 即调用本工厂（config.scriptGraphModules
 * 提供注入模块 URL 列表）。
 */
export function createGraphBehaviors(
  ctx: GraphBehaviorsCtx,
  modules: GraphRuntimeModule[] = [],
): GraphBehaviorsHandle {
  return createGraphKernel(ctx, [...createCoreGraphModules(), ...modules]);
}
