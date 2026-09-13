// ---------------------------------------------------------------------------
// script-compile 的共享底座（常量表与公共类型）：
// - TsModule / loadTs：typescript 编译器的单例懒加载入口（约 7MB 惰性 chunk），
//   props.ts / meta.ts / compile.ts 均经此取得编译器实例；
// - ScriptPropType / ScriptPropDef：脚本属性 schema 的公共类型（检查器控件用），
//   由 props.ts（props schema 解析）与 meta.ts（装饰器/静态声明解析）共同产出，
//   经 index.ts 对外导出；
// - PROP_TYPES / NODE_REF_TYPE_KINDS：AST 解析查表用的常量表（属性类型白名单、
//   节点类型 token → 编辑器节点 typeKey 白名单），供 props.ts 与 meta.ts 使用。
// 依赖方向：constants ← props ← meta ← compile ← project（本文件不依赖同目录模块）。
// ---------------------------------------------------------------------------

import type * as ts from "typescript";

/** typescript 编译器（懒加载：首次编译/解析时引入，约 7MB 惰性 chunk；
 *  类型经上方 import type 静态引入，编译期擦除不影响懒加载） */
export type TsModule = typeof ts;
let tsPromise: Promise<TsModule> | null = null;

/** 取编译器实例：首次调用引入 typescript 并缓存 promise（并发调用共享同一次加载） */
export async function loadTs(): Promise<TsModule> {
  if (!tsPromise) tsPromise = import("typescript");
  return tsPromise;
}

/** 脚本属性类型（与 tve.d.ts PropType 一致；检查器按此渲染控件；
 *  entity = 场景节点引用，value 为节点 id，default ''，filter 限定可选节点类型） */
export type ScriptPropType = "number" | "string" | "boolean" | "color" | "vec3" | "entity";

export interface ScriptPropDef {
  key: string;
  type: ScriptPropType;
  default: number | string | boolean | { x: number; y: number; z: number };
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  /** entity 专用：允许引用的节点 typeKey 白名单（空数组 = 任意节点） */
  filter?: string[];
}

/** 基本类型字面量（entity 节点引用不用字符串书写，经 @property({ type: 节点类 }) 识别） */
export const PROP_TYPES = ["number", "string", "boolean", "color", "vec3"];

/**
 * @property({ type: 节点类 }) 的节点类型 token 名 → 允许的编辑器节点 typeKey
 * （null = 任意场景节点）。与 tve.mjs 的节点类型类对应（大小写别名同义）。
 */
export const NODE_REF_TYPE_KINDS: Record<string, string[] | null> = {
  Entity: null,
  Transform: null,
  transform: null,
  MeshNode: ["meshNode"],
  meshNode: ["meshNode"],
  LightNode: [
    "lightNode",
    "pointLightNode",
    "directionalLightNode",
    "ambientLightNode",
    "spotLightNode",
  ],
  lightNode: [
    "lightNode",
    "pointLightNode",
    "directionalLightNode",
    "ambientLightNode",
    "spotLightNode",
  ],
  CameraNode: ["cameraNode"],
  cameraNode: ["cameraNode"],
  SkyboxNode: ["skyboxNode"],
  skyboxNode: ["skyboxNode"],
  FogNode: ["fogNode"],
  fogNode: ["fogNode"],
  ParticleSystemNode: ["particleSystemNode"],
  particleSystemNode: ["particleSystemNode"],
  TerrainNode: ["terrainNode"],
  terrainNode: ["terrainNode"],
  UICanvasNode: ["uiCanvasNode"],
  uiCanvasNode: ["uiCanvasNode"],
  UIImageNode: ["uiImageNode"],
  uiImageNode: ["uiImageNode"],
  UITextNode: ["uiTextNode"],
  uiTextNode: ["uiTextNode"],
  UIButtonNode: ["uiButtonNode"],
  uiButtonNode: ["uiButtonNode"],
};
