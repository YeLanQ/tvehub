// ---------------------------------------------------------------------------
// 微信渠道 · Draco 主线程内联解码器（DRACOLoader 的结构替换件）。
//
// 为什么不用 DRACOLoader：微信沙箱无 Worker，且基础库把 globalThis.Function
// hijack 成只放行 "return this" 尾参的补丁（new Function/eval 全灭）——
// DRACOLoader 的「fetch 解码器文本 → Blob → Worker」链无法存活。本实现把
// 解码收回主线程，解码器用 wasm 形态（2026-10-03/04 的 wasm 腿曾因字节/
// 用户目录路径被基础库拒绝而废弃；物理 wasm 与 meshopt wasm 落地后证明唯一
// 可靠通路 = 包内路径直连 WXWebAssembly，本文件改走同一条链）：
// - 胶水 = 包内真实模块文件 engine/runtime/loaders/draco/draco_wasm_wrapper.js
//   （emscripten 产物、零动态求值，随包由 runtime/scripts/wechat/draco.mjs 从
//   public/engine vendor 产物拷入），经桥接钩子 __tveLoadModule require；
//   零 Blob、零 Worker、零 fetch；
// - wasm = 包内文件 engine/runtime/loaders/draco/draco_decoder.wasm，经桥接
//   钩子 __tveInstantiateWasmFile(路径, imports) 实例化——与物理引擎/meshopt
//   wasm 同一条链（基础库只认代码包内路径；字节直传与用户目录路径均被拒）。
//   接线用 emscripten 标准配置口 instantiateWasm(imports, receiveInstance)
//   运行期注入，不做构建期文本改写（wrapper 的工厂回调契约稳定，无上游
//   minified 锚点漂移风险）；
// - 解码序列与 three r185 DRACOLoader 内置 DRACOWorker 逐句对齐
//   （decodeGeometry / decodeIndex / decodeAttribute 的移植），TypedArray
//   构造器用词法内建表查值（沙箱内 globalThis 运行期查值有视图隔离前科）；
// - 接口面 = GLTFLoader 实际消费的最小子集（preload + decodeDracoFile +
//   dispose），注入路径见 compressed.ts 与 framework/mesh/compressed-gltf.ts
//   的 dracoDecoder 参数。仅支持 glTF 的 unique-ID 形态（KHR_draco_mesh_
//   compression 恒如此；播放运行时无独立 .drc 入口）。
//
// 钩子名 __tveLoadModule / __tveInstantiateWasmFile / 前缀 "tve:" 是
// runtime/bridge/protocol.ts 的 TVE_LOAD_MODULE / TVE_INSTANTIATE_WASM_FILE /
// TVE_SPEC_PREFIX 在引擎源内的字面量登记（引擎产物不 import 桥接层，交叉常量
// 以注释对齐）。
// ---------------------------------------------------------------------------
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ColorManagement,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  SRGBColorSpace,
} from "three";

/** Draco 模块的 TypedArray 构造器全集（词法内建表——沙箱内经 globalThis 运行期
 *  查值不可靠；键 = glTF accessor componentType.name） */
type TypedArrayConstructor =
  | typeof Float32Array
  | typeof Int8Array
  | typeof Int16Array
  | typeof Int32Array
  | typeof Uint8Array
  | typeof Uint16Array
  | typeof Uint32Array;
type TypedArray = InstanceType<TypedArrayConstructor>;

const TYPED_ARRAYS: Record<string, TypedArrayConstructor> = {
  Float32Array,
  Int8Array,
  Int16Array,
  Int32Array,
  Uint8Array,
  Uint16Array,
  Uint32Array,
};

/** TypedArray 名 → 模块上的 Draco 数据类型枚举名（dracoDT_* 经索引签名查值） */
const DRACO_DATA_TYPES: Record<string, string> = {
  Float32Array: "DT_FLOAT32",
  Int8Array: "DT_INT8",
  Int16Array: "DT_INT16",
  Int32Array: "DT_INT32",
  Uint8Array: "DT_UINT8",
  Uint16Array: "DT_UINT16",
  Uint32Array: "DT_UINT32",
};

/** 解码状态句柄（draco.StatusWrapper） */
interface DracoStatus {
  ok(): boolean;
  error_msg(): string;
}

/** 解码目标几何句柄（draco.Mesh / draco.PointCloud） */
interface DracoGeometryHandle {
  ptr: number;
  num_points(): number;
  num_faces(): number;
}

/** 顶点属性句柄（draco.PointAttribute） */
interface DracoAttribute {
  num_components(): number;
}

/** draco.Decoder 实例面（解码调用集，与 DRACOWorker 一致） */
interface DracoDecoder {
  GetEncodedGeometryType(array: Int8Array): number;
  DecodeArrayToMesh(array: Int8Array, byteLength: number, geometry: DracoGeometryHandle): DracoStatus;
  DecodeArrayToPointCloud(array: Int8Array, byteLength: number, geometry: DracoGeometryHandle): DracoStatus;
  GetAttributeByUniqueId(geometry: DracoGeometryHandle, id: number): DracoAttribute;
  GetAttributeDataArrayForAllPoints(
    geometry: DracoGeometryHandle,
    attribute: DracoAttribute,
    dataType: number,
    byteLength: number,
    ptr: number,
  ): boolean;
  GetTrianglesUInt32Array(geometry: DracoGeometryHandle, byteLength: number, ptr: number): boolean;
}

/** DracoDecoderModule 工厂装饰后的模块面（wasm 构建） */
interface DracoModule {
  Decoder: new () => DracoDecoder;
  Mesh: new () => DracoGeometryHandle;
  PointCloud: new () => DracoGeometryHandle;
  TRIANGULAR_MESH: number;
  POINT_CLOUD: number;
  HEAPF32: { buffer: ArrayBuffer };
  _malloc(byteLength: number): number;
  _free(ptr: number): void;
  destroy(target: unknown): void;
  /** DT_* 数据类型枚举（经 DRACO_DATA_TYPES 的名字查值，见 dracoDataType） */
  [enumName: string]: unknown;
}

/** DracoDecoderModule 工厂签名（UMD 尾 module.exports = DracoDecoderModule；
 *  MODULARIZE 形态：调厂返回模块就绪 Promise） */
type DracoDecoderFactory = (config: {
  onModuleLoaded?: (module: DracoModule) => void;
  /** emscripten 标准实例化配置口：返回 Promise 时 wrapper 丢弃返回值、只认
   *  receiveInstance 回调——拒绳须自行接走（见 ensureModule 的 reject 接线） */
  instantiateWasm?: (
    imports: Record<string, unknown>,
    receiveInstance: (instance: { exports: unknown }) => void,
  ) => Promise<unknown> | null;
}) => Promise<DracoModule> | void;

/** 解码产物（对齐 DRACOWorker 的消息几何形态，供组装 BufferGeometry） */
interface DecodedGeometryData {
  index: { array: Uint32Array; itemSize: 1 } | null;
  attributes: Array<{
    name: string;
    count: number;
    itemSize: number;
    array: TypedArray;
    stride: number;
    vertexColorSpace?: string;
  }>;
}

/** 包内解码器胶水说明符 + wasm 包内路径（load-module 剥前缀 + 小写后 require
 *  包内键；wasm 路径经 __tveInstantiateWasmFile 直连 WXWebAssembly，与物理
 *  引擎/meshopt wasm 同目录布局同源） */
const DRACO_WRAPPER_SPEC = "tve:engine/runtime/loaders/draco/draco_wasm_wrapper.js";
const DRACO_WASM_PATH = "engine/runtime/loaders/draco/draco_decoder.wasm";

/** 模块枚举查值（索引签名收窄：DT_* 恒为数字） */
function dracoEnum(draco: DracoModule, name: string): number {
  const value = draco[name];
  if (typeof value !== "number") {
    throw new Error(`[draco-inline] Draco 模块缺少枚举 ${name}（解码器构建形态异常）`);
  }
  return value;
}

/** TypedArray 名 → Draco 数据类型枚举值 */
function dracoDataType(draco: DracoModule, typeName: string): number {
  const enumName = DRACO_DATA_TYPES[typeName];
  if (!enumName) throw new Error(`[draco-inline] 不支持的属性类型 ${typeName}`);
  return dracoEnum(draco, enumName);
}

/**
 * DRACOLoader 的主线程内联替换件（仅微信渠道；见文件头）。
 * 解码同步执行（一次性加载期成本），模块经 __tveLoadModule 懒加载并缓存。
 */
export class DracoInlineLoader {
  private module: Promise<DracoModule> | null = null;

  /** GLTFDracoMeshCompressionExtension 构造期调用：预热模块加载 */
  preload(): this {
    this.ensureModule();
    return this;
  }

  /** GLTFLoader 扩展的解码入口（KHR_draco_mesh_compression 恒 unique-ID 形态） */
  decodeDracoFile(
    buffer: ArrayBufferLike,
    callback: (geometry: BufferGeometry) => void,
    attributeIDs: Record<string, number>,
    attributeTypes: Record<string, string>,
    vertexColorSpace: string,
    onError: (error: unknown) => void = () => {},
  ): void {
    this.ensureModule()
      .then((draco) => {
        try {
          callback(
            createGeometry(
              decodeGeometrySync(draco, new Int8Array(buffer), attributeIDs, attributeTypes, vertexColorSpace),
            ),
          );
        } catch (e) {
          onError(e);
        }
      })
      .catch(onError);
  }

  /** 兼容 DRACOLoader 消费方的清理入口：模块跨模型复用，不做真销毁 */
  dispose(): this {
    return this;
  }

  private ensureModule(): Promise<DracoModule> {
    this.module ??= new Promise<DracoModule>((resolve, reject) => {
      const load = (globalThis as { __tveLoadModule?: (spec: string) => Promise<unknown> })
        .__tveLoadModule;
      const instantiateWasmFile = (
        globalThis as {
          __tveInstantiateWasmFile?: (
            path: string,
            imports: Record<string, unknown>,
          ) => Promise<{ instance: { exports: unknown } }>;
        }
      ).__tveInstantiateWasmFile;
      if (typeof load !== "function" || typeof instantiateWasmFile !== "function") {
        reject(
          new Error(
            "[draco-inline] 桥接钩子 __tveLoadModule/__tveInstantiateWasmFile 缺席（内联解码器仅微信渠道可用）",
          ),
        );
        return;
      }
      load(DRACO_WRAPPER_SPEC).then(
        (exported) => {
          const factory = typeof exported === "function" ? exported : (exported as { default?: unknown }).default;
          if (typeof factory !== "function") {
            reject(new Error("[draco-inline] draco_wasm_wrapper.js 导出形态异常（缺 DracoDecoderModule 工厂，请重建微信运行时）"));
            return;
          }
          // 双就绪口都接（wrapper 的 MODULARIZE 形态两个都给）：onModuleLoaded
          // 回调 + 工厂返回的 ready Promise，先到先定；wasm 链的拒绳在这里收拢
          // ——wrapper 丢弃 instantiateWasm 的返回 Promise，拒绝不自动传播
          let settled = false;
          const settle = (fn: (v: never) => void, value: never) => {
            if (settled) return;
            settled = true;
            fn(value);
          };
          try {
            const ready = (factory as DracoDecoderFactory)({
              onModuleLoaded: (draco) => settle(resolve, draco as never),
              instantiateWasm: (imports, receiveInstance) =>
                instantiateWasmFile(DRACO_WASM_PATH, imports).then(
                  (result) => {
                    if (!result || !result.instance) {
                      throw new Error("[draco-inline] wasm 实例化结果缺 instance（平台端点形态异常）");
                    }
                    receiveInstance(result.instance);
                  },
                  (e) =>
                    settle(
                      reject as (v: never) => void,
                      new Error(`[draco-inline] Draco wasm 实例化失败: ${e instanceof Error ? e.message : String(e)}`) as never,
                    ),
                ),
            });
            if (ready && typeof (ready as PromiseLike<DracoModule>).then === "function") {
              (ready as PromiseLike<DracoModule>).then(
                (draco) => settle(resolve, draco as never),
                (e) =>
                  settle(
                    reject as (v: never) => void,
                    new Error(`[draco-inline] 解码器模块初始化失败: ${e instanceof Error ? e.message : String(e)}`) as never,
                  ),
              );
            }
          } catch (e) {
            reject(new Error(`[draco-inline] 解码器工厂调用失败: ${e instanceof Error ? e.message : String(e)}`));
          }
        },
        (e) => reject(new Error(`[draco-inline] 解码器胶水加载失败: ${e instanceof Error ? e.message : String(e)}`)),
      );
    });
    return this.module;
  }
}

/** 解码主体（DRACOWorker.decodeGeometry 移植；decoder 用后即毁） */
function decodeGeometrySync(
  draco: DracoModule,
  array: Int8Array,
  attributeIDs: Record<string, number>,
  attributeTypes: Record<string, string>,
  vertexColorSpace: string,
): DecodedGeometryData {
  const decoder = new draco.Decoder();
  try {
    const geometryType = decoder.GetEncodedGeometryType(array);
    let dracoGeometry: DracoGeometryHandle;
    let decodingStatus: DracoStatus;
    if (geometryType === draco.TRIANGULAR_MESH) {
      dracoGeometry = new draco.Mesh();
      decodingStatus = decoder.DecodeArrayToMesh(array, array.byteLength, dracoGeometry);
    } else if (geometryType === draco.POINT_CLOUD) {
      dracoGeometry = new draco.PointCloud();
      decodingStatus = decoder.DecodeArrayToPointCloud(array, array.byteLength, dracoGeometry);
    } else {
      throw new Error("[draco-inline] 未知的 Draco 几何类型");
    }
    if (!decodingStatus.ok() || dracoGeometry.ptr === 0) {
      throw new Error(`[draco-inline] 解码失败: ${decodingStatus.error_msg()}`);
    }

    const geometry: DecodedGeometryData = { index: null, attributes: [] };
    for (const attributeName of Object.keys(attributeIDs)) {
      const typeName = attributeTypes[attributeName] ?? "";
      if (!TYPED_ARRAYS[typeName]) throw new Error(`[draco-inline] 属性 ${attributeName} 类型缺失或不受支持`);
      const attribute = decoder.GetAttributeByUniqueId(dracoGeometry, attributeIDs[attributeName]);
      const decoded = decodeAttribute(draco, decoder, dracoGeometry, attributeName, typeName, attribute);
      if (attributeName === "color") decoded.vertexColorSpace = vertexColorSpace;
      geometry.attributes.push(decoded);
    }
    if (geometryType === draco.TRIANGULAR_MESH) {
      geometry.index = decodeIndex(draco, decoder, dracoGeometry);
    }
    draco.destroy(dracoGeometry);
    return geometry;
  } finally {
    draco.destroy(decoder);
  }
}

/** 索引解码（DRACOWorker.decodeIndex 移植：UInt32 落盘读回） */
function decodeIndex(
  draco: DracoModule,
  decoder: DracoDecoder,
  dracoGeometry: DracoGeometryHandle,
): { array: Uint32Array; itemSize: 1 } {
  const numIndices = dracoGeometry.num_faces() * 3;
  const byteLength = numIndices * 4;
  const ptr = draco._malloc(byteLength);
  try {
    decoder.GetTrianglesUInt32Array(dracoGeometry, byteLength, ptr);
    return { array: new Uint32Array(draco.HEAPF32.buffer, ptr, numIndices).slice(), itemSize: 1 };
  } finally {
    draco._free(ptr);
  }
}

/** 顶点属性解码（DRACOWorker.decodeAttribute 移植：4 字节对齐补齐 Interleaved） */
function decodeAttribute(
  draco: DracoModule,
  decoder: DracoDecoder,
  dracoGeometry: DracoGeometryHandle,
  attributeName: string,
  typeName: string,
  attribute: DracoAttribute,
): { name: string; count: number; itemSize: number; array: TypedArray; stride: number; vertexColorSpace?: string } {
  const constructor = TYPED_ARRAYS[typeName];
  const count = dracoGeometry.num_points();
  const itemSize = attribute.num_components();
  const bytesPerElement = constructor.BYTES_PER_ELEMENT;
  const srcByteStride = itemSize * bytesPerElement;
  const dstByteStride = Math.ceil(srcByteStride / 4) * 4;
  const dstStride = dstByteStride / bytesPerElement;
  const srcByteLength = count * srcByteStride;
  const ptr = draco._malloc(srcByteLength);
  try {
    decoder.GetAttributeDataArrayForAllPoints(
      dracoGeometry,
      attribute,
      dracoDataType(draco, typeName),
      srcByteLength,
      ptr,
    );
    const srcArray = new constructor(draco.HEAPF32.buffer, ptr, srcByteLength / bytesPerElement);
    let dstArray: TypedArray;
    if (srcByteStride === dstByteStride) {
      dstArray = srcArray.slice();
    } else {
      dstArray = new constructor((count * dstByteStride) / bytesPerElement);
      let dstOffset = 0;
      for (let i = 0; i < count; i++) {
        dstArray.set(srcArray.subarray(i * itemSize, i * itemSize + itemSize), dstOffset);
        dstOffset += dstStride;
      }
    }
    return { name: attributeName, count, itemSize, array: dstArray, stride: dstStride };
  } finally {
    draco._free(ptr);
  }
}

/** 组装 BufferGeometry（DRACOLoader._createGeometry 移植） */
function createGeometry(geometryData: DecodedGeometryData): BufferGeometry {
  const geometry = new BufferGeometry();
  if (geometryData.index) {
    geometry.setIndex(new BufferAttribute(geometryData.index.array, 1));
  }
  for (const { name, array, itemSize, stride, vertexColorSpace } of geometryData.attributes) {
    let attribute: BufferAttribute | InterleavedBufferAttribute;
    if (itemSize === stride) {
      attribute = new BufferAttribute(array, itemSize);
    } else {
      attribute = new InterleavedBufferAttribute(new InterleavedBuffer(array, stride), itemSize, 0);
    }
    if (name === "color") {
      assignVertexColorSpace(attribute, vertexColorSpace);
      attribute.normalized = !(array instanceof Float32Array);
    }
    geometry.setAttribute(name, attribute);
  }
  return geometry;
}

/** 顶点色色彩空间换算（DRACOLoader._assignVertexColorSpace 移植） */
function assignVertexColorSpace(attribute: BufferAttribute | InterleavedBufferAttribute, inputColorSpace?: string): void {
  if (inputColorSpace !== SRGBColorSpace) return;
  const color = new Color();
  for (let i = 0; i < attribute.count; i++) {
    color.fromBufferAttribute(attribute, i);
    ColorManagement.colorSpaceToWorking(color, SRGBColorSpace);
    attribute.setXYZ(i, color.r, color.g, color.b);
  }
}
