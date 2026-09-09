// ---------------------------------------------------------------------------
// 组件注册表（编辑器侧元数据）：「添加组件」菜单、组件卡片标题/约束的单一事实源。
//
// 与 framework/prototype/components/ 的组件描述符对应：每种可挂载组件一条
// UI 元数据（展示名/分类/多实例约束）；创建默认引用与重置设置委托给框架层
// 描述符（ComponentDescriptor.createDefault / resetSettings），本文件不再
// 持有各组件类型的默认值拷贝。
// 新增内置组件时：在 framework/prototype/components/ 实现描述符并登记，
// 再在此追加一条 ComponentMeta。
// ---------------------------------------------------------------------------

import { nextId } from "../../platform_abstraction/id";
import {
  descriptorOf,
  type ComponentType,
  type LightComponentRef,
  type NodeComponentRef,
  type ScriptComponentRef,
  isLightComponent,
  isRigidBodyComponent,
} from "../../framework/prototype/components";
import type { LightComponentKind } from "../../framework/lighting/types";
import type { ColliderSettings, RigidBodySettings } from "../../framework/physics";

/** 组件分类（添加组件菜单的分组顺序即此顺序） */
export type ComponentCategory = "physics" | "lighting" | "audio" | "animation" | "script";

export const COMPONENT_CATEGORY_LABELS: Record<ComponentCategory, string> = {
  physics: "物理",
  lighting: "光照",
  audio: "音频",
  animation: "动画",
  script: "脚本",
};

/** 组件元数据（Unity 组件语义：label 为卡片标题，allowMultiple 为可重复挂载） */
export interface ComponentMeta {
  type: NodeComponentRef["type"];
  /** 卡片/菜单展示名（中英合排，如 "刚体 Rigid Body"） */
  label: string;
  category: ComponentCategory;
  /** 同节点可挂多个（false 时菜单项在已挂载后禁用） */
  allowMultiple: boolean;
}

export const COMPONENT_METAS: ComponentMeta[] = [
  { type: "rigidBody", label: "刚体 Rigid Body", category: "physics", allowMultiple: false },
  { type: "collider", label: "碰撞体 Collider", category: "physics", allowMultiple: true },
  { type: "light", label: "灯光 Light", category: "lighting", allowMultiple: false },
  { type: "audioSource", label: "音源 Audio Source", category: "audio", allowMultiple: true },
  { type: "animationClip", label: "动画剪辑 Animation Clip", category: "animation", allowMultiple: true },
  { type: "script", label: "脚本 Script", category: "script", allowMultiple: true },
];

/** 按组件类型取元数据 */
export function componentMetaOf(type: NodeComponentRef["type"]): ComponentMeta {
  const meta = COMPONENT_METAS.find((m) => m.type === type);
  if (!meta) throw new Error(`未登记的组件类型: ${type}`);
  return meta;
}

/** 节点是否还能挂该类型组件（多实例约束已满时 false） */
export function canAddComponent(node: { components: NodeComponentRef[] }, type: NodeComponentRef["type"]): boolean {
  const meta = componentMetaOf(type);
  if (meta.allowMultiple) return true;
  return !node.components.some((c) => c.type === type);
}

/** 创建默认组件引用（委托框架层描述符；light 可指定灯光类型） */
export function createComponentRef(
  type: NodeComponentRef["type"],
  opts: { lightKind?: LightComponentKind; clip?: string } = {},
): NodeComponentRef {
  if (type === "script") {
    // 脚本组件必须指定脚本路径，走 addScriptComponent 专用入口；这里仅占位
    throw new Error("脚本组件请用 createScriptComponentRef(script) 创建");
  }
  const descriptor = descriptorOf(type as ComponentType);
  // 联合类型已约束 type 必然已登记（运行期元数据与描述符不同步时显式报错）
  if (!descriptor) throw new Error(`未登记的组件类型: ${type}`);
  return descriptor.createDefault(opts) as NodeComponentRef;
}

/** 创建脚本组件引用（挂载指定脚本；属性留空由播放器按声明默认值补齐） */
export function createScriptComponentRef(script: string): ScriptComponentRef {
  return { id: nextId("comp"), type: "script", script, enabled: true, executionOrder: 0, props: {} };
}

/** 组件设置重置为该类型默认值（委托框架层描述符原地改写；保留 id/启用状态/脚本路径与执行顺序） */
export function resetComponentSettings(comp: NodeComponentRef): void {
  descriptorOf(comp.type)?.resetSettings(comp);
}

/** 灯光组件的灯光类型可选项（添加菜单/卡片类型下拉共用） */
export const LIGHT_KIND_OPTIONS: { value: LightComponentKind; label: string }[] = [
  { value: "point", label: "点光源 Point" },
  { value: "directional", label: "平行光 Directional" },
  { value: "spot", label: "聚光灯 Spot" },
  { value: "ambient", label: "环境光 Ambient" },
];

export type { ColliderSettings, LightComponentRef, RigidBodySettings, ScriptComponentRef };
export { isLightComponent, isRigidBodyComponent };
