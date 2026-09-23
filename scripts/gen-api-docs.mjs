// SDK API 参考文档生成器：src/framework/scripting/tve.d.ts（类型契约唯一
// 事实源）→ public/docs/sdk/api.md（全量 API 参考，勿手改）。
//
// 用法：pnpm gen:api-docs
//
// tve.d.ts 变更后重跑本脚本即可同步文档；教程页（sdk/*.md 其余文件）仍为
// 手写内容，本脚本不触碰。声明级示例来自 scripts/api-docs/examples/*.md
// （按声明名一文件），渲染时注入；示例块（```ts tve）由 pnpm docs:test
// 逐块验证。覆盖门禁：class/function/const 与核心 API 接口必须配示例，
// 纯数据形状类型在 EXEMPT 豁免——缺示例即非零退出（防止新 API 裸奔）。

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractModel } from "./api-docs/extract.mjs";
import { exampleOf, renderModel } from "./api-docs/render.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "src", "framework", "scripting", "tve.d.ts");
const target = path.join(root, "public", "docs", "sdk", "api.md");

// 无需独立示例的声明（纯数据形状 / 别名，用法被引用方示例覆盖）：
// type/const/function 之外的接口，凡未列于此且未配 examples/*.md 都会拦。
const EXEMPT = new Set([
  // 基础类型与形状
  "Vec3", "PropType", "EntityKind", "NodeClass", "ComponentClass", "PropDef", "ScriptNodeKind",
  "ComponentProps", "GraphInputValue",
  // 粒子/地形/逻辑形状
  "ParticleShape", "ParticleSettings", "ParticleState", "TerrainSettingsSnapshot",
  "BTStatus", "LogicStateInfo", "BTActionLeaf", "BTActionSession", "BTActionHandler",
  // UI 形状
  "UIScaleMode", "UIVec2", "UIPadding", "UIAnchorBase", "UIWidgetBase",
  // tween 形状
  "EaseName", "TweenValue",
  // 通用设施形状
  "DataCenterOptions", "DataCenterStats", "DelegateToken",
  // 门面形状与别名
  "RigidBodyFacade", "AnimLoopMode", "AnimStateDef", "AnimConditionDef", "AnimTransitionDef",
  "BoneTransform", "BoneHierarchyEntry", "MorphGroup", "SkinInfo", "IKLinkDef", "IKEntry",
  "BoneAttachOptions", "BoneAttachmentEntry", "AnimEventPayload",
  "LightAddOptions", "AudioSourceAddOptions", "AnimationClipAddOptions", "SkeletalAnimationAddOptions",
  // engine 子形状
  "TimeState", "PointerState", "PhysicsRayHit", "UIScreenMetrics", "UIRect", "UIPoint",
]);

const model = extractModel(source);
const declCount = model.sections.reduce((n, s) => n + s.decls.length, 0);
const body = renderModel(model);

const page = [
  "<!-- 由 scripts/gen-api-docs.mjs 自动生成，来源 src/framework/scripting/tve.d.ts，请勿手改。 -->",
  "",
  "# tve SDK API 参考",
  "",
  "<!-- 生成物说明：本页是类型契约的全量参考；入门与专题讲解见 SDK 总览等手写文档。 -->",
  "<!-- 声明级示例来自 scripts/api-docs/examples/（ts tve 标记块随 pnpm docs:test 验证）。 -->",
  "",
  body,
].join("\n");

writeFileSync(target, page);

// —— 覆盖门禁：核心声明必须配示例 ——
const missing = model.sections
  .flatMap((s) => s.decls)
  .filter((d) => !EXEMPT.has(d.name) && !exampleOf(d.name, d.kind))
  .map((d) => `${d.kind} ${d.name}`);

const exampleCount = model.sections
  .flatMap((s) => s.decls)
  .filter((d) => exampleOf(d.name, d.kind)).length;

if (missing.length) {
  console.error(`✗ 以下 ${missing.length} 个声明缺示例（scripts/api-docs/examples/<名>.md）：`);
  for (const name of missing) console.error(`  - ${name}`);
  process.exit(1);
}
console.log(`✓ public/docs/sdk/api.md 生成完成（${model.sections.length} 个分节 / ${declCount} 个声明 / ${exampleCount} 个声明级示例）`);
