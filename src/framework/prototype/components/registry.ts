// 组件描述符注册表：类型键 → 描述符的单一映射 + 泛型化公共链路。
//
// 原先 parseNodeComponents / cloneNodeComponents / cloneComponentForWrite
// 按组件类型各有一条 if/else 链（且 component-registry 的创建/重置又是一组
// 平行 switch），新增内置组件要同步改多处；现在每种组件在自己的描述符模块
// 实现 ComponentDescriptor 接口，在此登记一条即可，公共链路只查表派发。

import { nextId } from "../../../platform_abstraction/id";
import type { JsonRecord } from "../types";
import { audioSourceDescriptor } from "./audioSourceComponent";
import { animationClipDescriptor } from "./animationClipComponent";
import { colliderDescriptor } from "./colliderComponent";
import { lightDescriptor } from "./lightComponent";
import { rigidBodyDescriptor } from "./rigidBodyComponent";
import { scriptDescriptor } from "./scriptComponent";
import type {
  ComponentDescriptor,
  ComponentType,
  INodeComponent,
  NodeComponentRef,
} from "./types";

/** 类型键 → 描述符（键与 ComponentType 联合一一对应，漏登会在编译期报错） */
const DESCRIPTORS: {
  [K in ComponentType]: ComponentDescriptor<Extract<NodeComponentRef, { type: K }>>;
} = {
  script: scriptDescriptor,
  rigidBody: rigidBodyDescriptor,
  collider: colliderDescriptor,
  light: lightDescriptor,
  audioSource: audioSourceDescriptor,
  animationClip: animationClipDescriptor,
};

/** 按类型键取描述符（联合类型入参：必然已登记） */
export function descriptorOf(type: ComponentType): ComponentDescriptor<INodeComponent>;
/** 按字符串取描述符（解析原始 JSON 用；未登记的类型返回 null，调用方剔除） */
export function descriptorOf(type: string): ComponentDescriptor<INodeComponent> | null;
export function descriptorOf(type: string): ComponentDescriptor<INodeComponent> | null {
  return (DESCRIPTORS as Record<string, ComponentDescriptor<INodeComponent>>)[type] ?? null;
}

/** 组件引用 JSON 收敛（非法项剔除；各类型字段缺失回退默认） */
export function parseNodeComponents(value: unknown): NodeComponentRef[] {
  if (!Array.isArray(value)) return [];
  const out: NodeComponentRef[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as JsonRecord;
    // 未知 type（旧数据只有 script 无 type 字段）按 script 收敛；未登记 type 剔除
    const type = typeof raw.type === "string" ? raw.type : "script";
    const descriptor = descriptorOf(type);
    if (!descriptor) continue;
    const id = typeof raw.id === "string" && raw.id ? raw.id : nextId("comp");
    const enabled = raw.enabled !== false;
    const parsed = descriptor.parse(raw, { id, enabled });
    // 描述符按各自类型产出，此处收敛回联合（type 字面量已在描述符内固定）
    if (parsed) out.push(parsed as NodeComponentRef);
  }
  return out;
}

/** 组件引用深拷贝（id 重新生成，避免克隆节点后实例 id 重复） */
export function cloneNodeComponents(list: NodeComponentRef[]): NodeComponentRef[] {
  // 描述符按各自类型产出，此处收敛回联合
  return list.map((c) => descriptorOf(c.type).cloneForInstance(c) as NodeComponentRef);
}

/** 组件引用深拷贝（保留 id；序列化用；写出约定见各自描述符） */
export function cloneComponentForWrite(c: NodeComponentRef): NodeComponentRef {
  return descriptorOf(c.type).cloneForWrite(c) as NodeComponentRef;
}
