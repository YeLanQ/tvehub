// ---------------------------------------------------------------------------
// 高度雾渲染注入（fogKind = "height" 的着色器实现）。
//
// three.js 核心只有线性/指数雾；高度雾（雾浓度随世界海拔衰减）必须做着色器
// 级注入。双端策略：
// - WebGL：一次性 patch 内置 fog chunk（恒定安装，整个会话不变）——高度衰减
//   在 strength=0 时数学上严格等价内置行为，因此普通线性/指数雾不受影响，
//   也不触碰 program 缓存与材质 needsUpdate。高度参数经"共享 uniform 对象"
//   传入：cloneUniforms 对普通对象按引用复制，把同一个 {x,y,z} 注入 ShaderLib
//   全部含雾模板后，所有材质共享同一实例，改参数只写一次（渲染器每帧上传）。
// - WebGPU：scene.fogNode（TSL 雾节点）优先于 scene.fog —— 用自定义 TSL Fn
//   组装与 GLSL 端同语义的高度衰减因子，参数走 TSL.uniform（改参只写 .value）。
//
// 时点要求：ensureHeightFogChunk 必须先于任何 program 编译调用
// （编辑器在 EditorEngine 构造函数；播放器在 buildSceneTree 之前）。
//
// 已知取舍（项目内均不成立或可接受）：
// - 世界 Y 取 modelMatrix * position（蒙皮前），蒙皮网格为近似值；
//   精灵着色器作用域没有 transformed，position 是唯一全量可用的顶点源；
// - InstancedMesh/BatchedMesh 未含实例矩阵（项目当前没有这两种渲染路径）。
// ---------------------------------------------------------------------------

import * as THREE from "three";
import type { FogSettings } from "./types";

/**
 * 高度雾共享参数（GLSL `uniform vec3 uFogHeight`，同时是 TSL 端的取值源）：
 * x = 基准海拔 heightY；y = 衰减标度 heightFalloff；z = 强度（0 = 关闭，
 * 数学上严格回到内置雾；height 类型为 1）。
 * 必须是普通对象——cloneUniforms 对不可克隆值按引用复制，各材质模板克隆后
 * 仍指向本对象，实现"写一次、全部材质生效"。
 */
const HEIGHT_FOG_UNIFORM: { value: { x: number; y: number; z: number } } = {
  value: { x: 0, y: 20, z: 0 },
};

let chunkPatched = false;

/** 内置雾片段着色器公式（r185 原文；patch 后必须原样保留以保证 strength=0 等价） */
const STOCK_FOG_FACTOR = `#ifdef FOG_EXP2

		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );

	#else

		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );

	#endif`;

/**
 * 幂等安装高度雾补丁（先于一切 program 编译调用一次即可，重复调用无操作）。
 * 1) 重写 fog_* chunk：顶点补世界 Y varying，片元在内置雾因子后叠加海拔衰减；
 * 2) 向 ShaderLib 中所有含雾 uniform 的材质模板（basic/lambert/phong/standard/
 *    physical/toon/matcap/points/line/dashed/sprite）注入共享 uFogHeight。
 */
export function ensureHeightFogChunk(): void {
  if (chunkPatched) return;
  chunkPatched = true;

  const chunk = THREE.ShaderChunk as Record<string, string | undefined>;
  chunk.fog_pars_vertex = `#ifdef USE_FOG

	varying float vFogDepth;

	varying float vFogWorldY;

#endif
`;

  chunk.fog_vertex = `#ifdef USE_FOG

	vFogDepth = - mvPosition.z;

	// 世界海拔（雾带高度判定用）：position 为 prefix 全量可用属性（精灵着色器
	// 无 transformed / 蒙皮 morph 均可回退到此），矩阵乘法在顶点阶段一次完成
	vFogWorldY = ( modelMatrix * vec4( position, 1.0 ) ).y;

#endif
`;

  chunk.fog_pars_fragment = `#ifdef USE_FOG

	uniform vec3 fogColor;

	varying float vFogDepth;

	varying float vFogWorldY;

	// 高度雾参数（共享对象）：x=基准海拔 y=衰减标度 z=强度（0=关闭）
	uniform vec3 uFogHeight;

	#ifdef FOG_EXP2

		uniform float fogDensity;

	#else

		uniform float fogNear;
		uniform float fogFar;

	#endif

#endif
`;

  chunk.fog_fragment = `#ifdef USE_FOG

	${STOCK_FOG_FACTOR}

	// 高度衰减：取相机与片元的中点海拔，高出基准面越多雾越薄（透射率乘衰减）；
	// z=0 时 fogHeightAtten = 1，pow(T,1) = T，严格回到内置雾行为
	float fogHeightMidY = ( cameraPosition.y + vFogWorldY ) * 0.5;
	float fogHeightAtten = mix( 1.0, exp( - max( fogHeightMidY - uFogHeight.x, 0.0 ) / max( uFogHeight.y, 1e-4 ) ), uFogHeight.z );
	fogFactor = 1.0 - pow( 1.0 - fogFactor, fogHeightAtten );

	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );

#endif
`;

  // 内置材质的 uniforms 在 three 模块加载期已从 UniformsLib.fog 合并克隆，
  // 此后再改 UniformsLib 无效；直接向 ShaderLib 模板补注入（渲染器在取 program
  // 时才 clone 模板，共享对象引用因此穿透到每个材质）
  const lib = THREE.ShaderLib as unknown as Record<string, { uniforms: Record<string, unknown> }>;
  for (const def of Object.values(lib)) {
    if (def && def.uniforms && "fogColor" in def.uniforms) {
      def.uniforms.uFogHeight = HEIGHT_FOG_UNIFORM;
    }
  }
}

/**
 * 写入高度雾参数（幂等）：材质侧零处理——所有含雾材质共享同一参数对象，
 * 渲染器每帧从 uniform 对象取值上传。
 */
export function setHeightFogParams(heightY: number, heightFalloff: number, strength: number): void {
  HEIGHT_FOG_UNIFORM.value.x = heightY;
  HEIGHT_FOG_UNIFORM.value.y = Math.max(1e-4, heightFalloff);
  HEIGHT_FOG_UNIFORM.value.z = Math.min(1, Math.max(0, strength));
}

/** 仅开关高度衰减（线性/指数雾与无雾场景必须显式归零，防止上个高度雾节点的参数残留） */
export function setHeightFogStrength(strength: number): void {
  HEIGHT_FOG_UNIFORM.value.z = Math.min(1, Math.max(0, strength));
}

// ---------------------------------------------------------------------------
// WebGPU 路径：scene.fogNode（TSL）—— 与 GLSL 端同语义的高度衰减因子
// ---------------------------------------------------------------------------

interface TslFogApi {
  setParams(settings: Pick<FogSettings, "color" | "density" | "heightY" | "heightFalloff">): void;
}

let tslFog: TslFogApi | null = null;
let tslLoad: Promise<void> | null = null;
let tslFogNode: unknown = null;
/** 期望生效标记：首次 import three/tsl 是异步的，回落期间被 clear 则放弃应用 */
let tslDesired = false;

/**
 * 在 WebGPU 后端应用高度雾（scene.fogNode 优先于 scene.fog）。
 * 首次调用异步加载 three/tsl，加载完成前 WebGPU 先以 scene.fog（普通 exp2）
 * 兜底渲染；后续调用同步更新 uniform。失败仅告警，保持 exp2 兜底。
 */
export function applyHeightFogWebGPU(
  scene: THREE.Scene,
  settings: Pick<FogSettings, "color" | "density" | "heightY" | "heightFalloff">,
): void {
  tslDesired = true;
  if (tslFog) {
    tslFog.setParams(settings);
    setSceneFogNode(scene, tslFogNode);
    return;
  }
  if (!tslLoad) {
    tslLoad = (async (): Promise<void> => {
      const tsl = await import("three/tsl");
      const { Fn, uniform, positionWorld, positionView, cameraPosition } = tsl;
      const uColor = uniform(new THREE.Color(0xffffff));
      const uDensity = uniform(0.02);
      const uBaseY = uniform(0);
      const uFalloff = uniform(20);
      // 与 GLSL 端 fog_fragment 同公式：exp2 距离因子 × 海拔衰减（中点海拔）
      const heightFogFactor = Fn(() => {
        const viewZ = positionView.z.negate();
        const midY = cameraPosition.y.add(positionWorld.y).mul(0.5);
        const above = midY.sub(uBaseY).max(0);
        const atten = above.div(uFalloff.max(1e-4)).negate().exp();
        const optical = uDensity.mul(uDensity).mul(viewZ).mul(viewZ).mul(atten);
        return optical.negate().exp().oneMinus();
      });
      const node = tsl.fog(uColor, heightFogFactor());
      tslFog = {
        setParams(s) {
          uColor.value.setHex(s.color & 0xffffff);
          uDensity.value = s.density;
          uBaseY.value = s.heightY;
          uFalloff.value = Math.max(1e-4, s.heightFalloff);
        },
      };
      tslFogNode = node;
    })();
  }
  void tslLoad.then(() => {
    if (!tslDesired || !tslFog) return;
    tslFog.setParams(settings);
    setSceneFogNode(scene, tslFogNode);
  }).catch((e) => {
    console.warn(`[fog] WebGPU 高度雾不可用（${String(e)}），回退普通指数雾`);
  });
}

/** 关闭 WebGPU 高度雾（恢复 scene.fog 原生处理；幂等） */
export function clearHeightFogWebGPU(scene: THREE.Scene): void {
  tslDesired = false;
  setSceneFogNode(scene, null);
}

/** scene.fogNode 仅存在于 WebGPU 渲染路径（three/webgpu 的 Nodes 读取），经典类型无此字段 */
function setSceneFogNode(scene: THREE.Scene, node: unknown): void {
  (scene as unknown as { fogNode: unknown }).fogNode = node;
}
