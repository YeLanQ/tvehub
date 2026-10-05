// vendored three WebGPU 构建（three.webgpu.min.js，构建期 vendor 至产物，仓库内无
// 实体文件）的类型声明。@types/three 未覆盖该构建入口（官方 "three/webgpu" 亦无
// 完整 .d.ts），这里只声明运行时消费的最小 API：TSL 命名空间 + 节点材质类 +
// 基础值类型。结构对齐 src/runtime/core/glslToTsl.ts 的 TslNode/TslFnLib（本文件
// 在 check-layers 台账登记）。

/** TSL 节点（不透明结构：动态成员经索引签名放行） */
export interface TslNode {
  value?: unknown;
  toVar(): TslNode;
  assign(value: TslNode): TslNode;
  add(other: unknown): TslNode;
  sub(other: unknown): TslNode;
  mul(other: unknown): TslNode;
  div(other: unknown): TslNode;
  negate(): TslNode;
  normalize(): TslNode;
  [field: string]: unknown;
}

/** THREE.TSL 命名空间（节点材质 Hook 后端消费面） */
export interface TslNamespace {
  Fn(body: (...args: unknown[]) => TslNode | null): () => TslNode;
  uniform<T>(value: T): TslNode & { value: T };
  attribute(name: string, type?: string): TslNode;
  float(value?: number): TslNode;
  vec2(...a: unknown[]): TslNode;
  vec3(...a: unknown[]): TslNode;
  vec4(...a: unknown[]): TslNode;
  mix(a: unknown, b: unknown, t: unknown): TslNode;
  clamp(x: unknown, lo: unknown, hi: unknown): TslNode;
  min(a: unknown, b: unknown): TslNode;
  oneMinus(x: unknown): TslNode;
  positionLocal: TslNode;
  positionView: TslNode;
  positionWorld: TslNode;
  normalLocal: TslNode;
  normalView: TslNode;
  normalWorld: TslNode;
  materialColor: TslNode;
  materialOpacity: TslNode;
  materialEmissive: TslNode;
  modelWorldMatrix: TslNode;
  modelViewMatrix: TslNode;
  cameraViewMatrix: TslNode;
  cameraProjectionMatrix: TslNode;
  cameraPosition: TslNode;
  modelNormalMatrix: TslNode;
  uv(): TslNode;
  [name: string]: unknown;
}

export declare const TSL: TslNamespace;

/** 节点材质（Material 派生 + 节点槽位；类形仅作 instanceof 分派） */
export declare class NodeMaterial {
  needsUpdate: boolean;
  userData: Record<string, unknown>;
  addEventListener(type: string, cb: () => void): void;
  positionNode: TslNode | null;
  colorNode: TslNode | null;
  opacityNode: TslNode | null;
  emissiveNode: TslNode | null;
  normalNode: TslNode | null;
  constructor(parameters?: Record<string, unknown>);
}
export declare class MeshPhysicalNodeMaterial extends NodeMaterial {}
export declare class MeshBasicNodeMaterial extends NodeMaterial {}
export declare class MeshToonNodeMaterial extends NodeMaterial {}

/** 节点精灵材质（SpriteNodeMaterial：视空间 billboard + 节点槽位） */
export declare class SpriteNodeMaterial extends NodeMaterial {
  map: unknown;
  sizeAttenuation: boolean;
  constructor(parameters?: Record<string, unknown>);
}

export declare class Color {
  constructor(hex?: number);
  setHex(hex: number): this;
  r: number;
  g: number;
  b: number;
}
export declare class Vector3 {
  constructor(x?: number, y?: number, z?: number);
  set(x: number, y: number, z: number): this;
}
export declare class Vector4 {
  constructor(x?: number, y?: number, z?: number, w?: number);
  set(x: number, y: number, z: number, w: number): this;
}
export declare class DataTexture {
  needsUpdate: boolean;
  constructor(
    data: Uint8Array | Float32Array,
    width: number,
    height: number,
    format?: number,
  );
}
export declare const NormalBlending: number;
export declare const AdditiveBlending: number;
export declare const RGBAFormat: number;
