// 高度雾渲染注入（fogKind = "height"）：与编辑器 framework/fog/heightFog.ts
// 同一算法镜像 ——
// - WebGL：一次性 patch 内置 fog chunk（恒定安装，strength=0 时严格等价内置雾，
//   不触碰 program 缓存）；高度参数经共享 uniform 对象传入（cloneUniforms 对
//   普通对象按引用复制，ShaderLib 含雾模板注入同一实例，写一次全材质生效）。
// - WebGPU：scene.fogNode（TSL 雾节点，优先于 scene.fog）—— 自定义 Fn 与
//   GLSL 端同公式（exp2 距离因子 × 中点海拔衰减）。TSL 只存在于 three 的
//   WebGPU 构建（经典构建不含），由调用方把已加载的 THREE.TSL 命名空间传入
//   （WebGPU 后端下该包本就随渲染器加载，模块缓存保证单实例）。
//
// 时点要求：ensureHeightFogChunk 必须先于任何材质 program 编译调用
// （player 在 buildSceneTree / renderer.compile 之前调用一次）。
import * as THREE from "../core/three.module.min.js";

/** 高度雾共享参数（GLSL uniform vec3 uFogHeight）：x=基准海拔 y=衰减标度 z=强度 */
const HEIGHT_FOG_UNIFORM = { value: { x: 0, y: 20, z: 0 } };

let chunkPatched = false;

/** 幂等安装 fog chunk patch + ShaderLib uFogHeight 注入（先于一切 program 编译） */
export function ensureHeightFogChunk() {
  if (chunkPatched) return;
  chunkPatched = true;

  const chunk = THREE.ShaderChunk;
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

	#ifdef FOG_EXP2

		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );

	#else

		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );

	#endif

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
  for (const def of Object.values(THREE.ShaderLib)) {
    if (def && def.uniforms && "fogColor" in def.uniforms) {
      def.uniforms.uFogHeight = HEIGHT_FOG_UNIFORM;
    }
  }
}

/** 写入高度雾参数（幂等）：所有含雾材质共享同一参数对象 */
export function setHeightFogParams(heightY, heightFalloff, strength) {
  HEIGHT_FOG_UNIFORM.value.x = heightY;
  HEIGHT_FOG_UNIFORM.value.y = Math.max(1e-4, heightFalloff);
  HEIGHT_FOG_UNIFORM.value.z = Math.min(1, Math.max(0, strength));
}

let tslNodeState = null;

/**
 * WebGPU 路径：scene.fogNode（TSL 雾节点，优先于 scene.fog）。
 * @param tsl THREE.TSL 命名空间（来自 three 的 WebGPU 构建；缺失时告警并保持
 *            scene.fog 普通指数雾兜底）
 */
export function applyHeightFogNodeWebGPU(scene, settings, tsl) {
  if (!tsl) {
    console.warn("[fog] WebGPU 高度雾需要 TSL 命名空间，回退普通指数雾");
    return;
  }
  try {
    if (!tslNodeState) {
      const { Fn, uniform, positionWorld, positionView, cameraPosition, fog } = tsl;
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
      tslNodeState = {
        node: fog(uColor, heightFogFactor()),
        uColor,
        uDensity,
        uBaseY,
        uFalloff,
      };
    }
    tslNodeState.uColor.value.setHex(settings.color & 0xffffff);
    tslNodeState.uDensity.value = settings.density;
    tslNodeState.uBaseY.value = settings.heightY;
    tslNodeState.uFalloff.value = Math.max(1e-4, settings.heightFalloff);
    scene.fogNode = tslNodeState.node;
  } catch (e) {
    console.warn(`[fog] WebGPU 高度雾不可用（${e?.message ?? e}），回退普通指数雾`);
  }
}

/** 关闭 WebGPU 高度雾（恢复 scene.fog 原生处理；幂等） */
export function clearHeightFogWebGPU(scene) {
  scene.fogNode = null;
}
