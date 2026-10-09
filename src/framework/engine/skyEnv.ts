// ---------------------------------------------------------------------------
// 天空背景应用（场景环境级）：场景图中第一个「启用且可见」的天空盒节点决定
// scene.background（程序化渐变 / 三段色带 / TextureCube 贴图 / Nishita 大气散射），
// 含贴图与材质参数的版本化缓存、天空环境光（半球光）与正交预览的全屏天空面。
// ---------------------------------------------------------------------------
import * as THREE from "three";
import type { EditorEngine } from "./EditorEngine";
import { SkyboxNode } from "../prototype/derived/Primitives";
import type { Node } from "../prototype/Node";
import { EDITOR_BACKGROUND_COLOR } from "./modules/RendererManager";
import {
  buildBandSkyTexture,
  buildProceduralSkyTexture,
  fetchSkyMatParams,
  fetchTexCubeDoc,
  loadTexCubeTexture as loadTexCubeTextureAsset,
  type SkyMatParams,
} from "./modules/skyboxTextures";
import { buildNishitaSkyEquirect } from "./modules/nishitaSky";

/** 混合两个 RGB hex 颜色（t=0 全 a，t=1 全 b） */
function mixHexColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return ((r & 255) << 16) | ((g & 255) << 8) | (bl & 255);
}

/**
 * 依据场景图应用/移除天空背景：
 * 场景中第一个 启用且可见 的天空盒节点决定 scene.background（程序化渐变 /
 * 三段色带 / TextureCube 贴图），节点增删、属性修改、启停切换都会触发重算；
 * 无天空盒时回退编辑器默认纯色背景。
 * 立方体天空盒的 TextureCube（.texcube）为异步加载：先用三段色带兜底，
 * 加载完成后热替换背景；引用缺失/加载失败保持色带（与旧版表现一致）。
 */
export function applySkyFromGraph(engine: EditorEngine): void {
  const scene = engine.renderer.scene;
  const release = (): void => {
    if (engine.skyApplied) {
      engine.skyApplied.texture.dispose();
      engine.skyApplied = null;
    }
  };
  const sky = findSkyboxNode(engine);
  if (!sky) {
    if (engine.skyApplied) {
      release();
      scene.background = new THREE.Color(EDITOR_BACKGROUND_COLOR);
    }
    removeSkyEnvLight(engine);
    return;
  }
  // 签名含贴图引用与其内容版本：检查器改写 .texcube/.mat 后版本 bump 触发重载
  const cubeVer =
    sky.skyKind === "cube" ? (engine.texCubeVersions.get(sky.cubeMap) ?? 0) : -1;
  const matVer =
    sky.skyKind === "cube" ? (engine.skyMatVersions.get(sky.material) ?? 0) : -1;
  const sig = [
    sky.id,
    sky.skyKind,
    sky.cubeMap,
    cubeVer,
    sky.material,
    matVer,
    engine.skyEpoch,
    sky.topColor,
    sky.horizonColor,
    sky.groundColor,
    sky.sunDisk,
    sky.sunColor,
    sky.sunSize,
    sky.sunGlow,
    sky.sunAzimuth,
    sky.sunElevation,
  ].join("|");
  if (engine.skyApplied?.sig === sig) return;
  release();
  // 兜底（三段色带/程序化）期间背景属性回中性；cube 贴图加载完成后应用材质参数
  setSkyBgProps(engine, { rotation: 0, intensity: 1, blurriness: 0 });
  try {
    // 立方体：三段色带先兜底（未绑定/加载中/失败均保持可看）；贴图到位后热替换
    const tex =
      sky.skyKind === "procedural"
        ? buildProceduralSkyTexture(sky)
        : buildBandSkyTexture(sky);
    scene.background = tex;
    engine.skyApplied = { sig, texture: tex };
    if (sky.skyKind === "cube") {
      // 材质链路：绑定 .mat 的 cubeMap 优先，节点 cubeMap 兜底；
      // 材质的旋转/强度/模糊经 scene 背景属性生效
      void (async (): Promise<THREE.Texture | null> => {
        let mat: SkyMatParams | null = null;
        if (sky.material) {
          mat = await loadSkyMatParams(engine, sky.material);
          if (engine.skyApplied?.sig !== sig) return null;
        }
        const texRel = mat?.cubeMap || sky.cubeMap || "";
        if (!texRel) return null;
        const loaded = await loadTexCubeTexture(engine, texRel);
        if (engine.skyApplied?.sig !== sig) return null;
        setSkyBgProps(engine, {
          rotation: mat?.rotation ?? 0,
          intensity: mat?.strength ?? 1,
          blurriness: mat?.blur ?? 0,
        });
        return loaded;
      })().then((loaded) => {
        // 异步返回时签名可能已变（节点切换/再次修改）：过期结果直接丢弃
        const applied = engine.skyApplied;
        if (!applied || applied.sig !== sig || !loaded) return;
        applied.texture.dispose();
        applied.texture = loaded;
        scene.background = loaded;
      });
    }
    if (sky.skyKind === "procedural" && sky.material) {
      // 程序化材质链路：Nishita 大气散射，
      // 参数来自绑定 .mat（日轮/太阳/海拔/空气/气溶胶/臭氧/多重散射）
      void (async (): Promise<THREE.Texture | null> => {
        const mat = await loadSkyMatParams(engine, sky.material);
        if (engine.skyApplied?.sig !== sig || !mat) return null;
        const gl = engine.renderer.glRenderer;
        if (!gl) return null; // WebGPU 后端：保留色带兜底
        const nishita = buildNishitaSkyEquirect(gl, {
          sunDisc: mat.sunDisc,
          sunSize: mat.sunSize,
          sunStrength: mat.sunStrength,
          sunElevation: mat.sunElevation,
          sunRotation: mat.sunRotation,
          altitude: mat.altitude,
          air: mat.air,
          dust: mat.dust,
          ozone: mat.ozone,
          ms: mat.ms,
        });
        if (engine.skyApplied?.sig !== sig) return null;
        setSkyBgProps(engine, { rotation: 0, intensity: mat.strength, blurriness: 0 });
        return nishita;
      })().then((loaded) => {
        const applied = engine.skyApplied;
        if (!applied || applied.sig !== sig || !loaded) return;
        applied.texture.dispose();
        applied.texture = loaded;
        scene.background = loaded;
      });
    }
  } catch (e) {
    console.warn(`[sky] 天空盒背景生成失败: ${String(e)}`);
    scene.background = new THREE.Color(EDITOR_BACKGROUND_COLOR);
  }
  // 天空作为环境光照参与网格材质：半球光（天空色/地面色）随天空变化
  applySkyEnvLight(engine, sky);
}

/**
 * 加载 TextureCube（.texcube）资产为天空纹理（带缓存与内容版本；
 * 解析/加载失败返回 null，调用方保持色带兜底）。
 */
export function loadTexCubeTexture(engine: EditorEngine, rel: string): Promise<THREE.Texture | null> {
  const key = `${engine.texCubeVersions.get(rel) ?? 0}|${rel}`;
  const cached = engine.texCubeCache.get(key);
  if (cached) return cached;
  const resolver = engine.textureUrlResolver;
  const task = (async (): Promise<THREE.Texture | null> => {
    if (!resolver || !rel) return null;
    const url = resolver(rel);
    if (!url) return null;
    const doc = await fetchTexCubeDoc(url);
    if (!doc) return null;
    const res = await loadTexCubeTextureAsset(
      doc,
      resolver,
      engine.renderer.activeBackend === "webgpu",
    );
    return res?.texture ?? null;
  })().catch((e) => {
    console.warn(`[sky] TextureCube 加载失败 '${rel}': ${String(e)}`);
    return null;
  });
  engine.texCubeCache.set(key, task);
  return task;
}

/**
 * 外部（检查器写盘等）通知某 .texcube 内容已更新：bump 版本使缓存与
 * 天空签名失效并立即重算背景；贴图未变化时无副作用。
 */
export function invalidateTexCube(engine: EditorEngine, rel: string): void {
  if (!rel) return;
  engine.texCubeVersions.set(rel, (engine.texCubeVersions.get(rel) ?? 0) + 1);
  for (const key of [...engine.texCubeCache.keys()]) {
    if (key.endsWith(`|${rel}`)) engine.texCubeCache.delete(key);
  }
  engine.skyEpoch++;
  applySkyFromGraph(engine);
}

/** 加载天空盒材质参数（.mat cube 分支；带缓存与内容版本，失败返回 null） */
export function loadSkyMatParams(engine: EditorEngine, rel: string): Promise<SkyMatParams | null> {
  const key = `${engine.skyMatVersions.get(rel) ?? 0}|${rel}`;
  const cached = engine.skyMatCache.get(key);
  if (cached) return cached;
  const resolver = engine.textureUrlResolver;
  const task = (async (): Promise<SkyMatParams | null> => {
    if (!resolver || !rel) return null;
    const url = resolver(rel);
    if (!url) return null;
    return await fetchSkyMatParams(url);
  })().catch(() => null);
  engine.skyMatCache.set(key, task);
  return task;
}

/** 外部（检查器写盘）通知某天空盒材质已更新：失效缓存并重算天空背景 */
export function invalidateSkyMaterial(engine: EditorEngine, rel: string): void {
  if (!rel) return;
  engine.skyMatVersions.set(rel, (engine.skyMatVersions.get(rel) ?? 0) + 1);
  for (const key of [...engine.skyMatCache.keys()]) {
    if (key.endsWith(`|${rel}`)) engine.skyMatCache.delete(key);
  }
  engine.skyEpoch++;
  applySkyFromGraph(engine);
}

/** 应用天空背景属性（旋转/强度/模糊；three 的 scene 背景属性） */
export function setSkyBgProps(engine: EditorEngine, props: { rotation: number; intensity: number; blurriness: number }): void {
  engine.skyBgProps = props;
  engine.renderer.scene.backgroundRotation.set(0, THREE.MathUtils.degToRad(props.rotation), 0);
  engine.renderer.scene.backgroundIntensity = props.intensity;
  engine.renderer.scene.backgroundBlurriness = Math.max(0, Math.min(1, props.blurriness));
}

/**
 * 天空环境光：天空盒激活时向场景注入一盏与天空配色一致的半球光，
 * 使网格材质的明暗/环境色随天空颜色变化（天空顶/地平线混色为天空光，
 * 下方色为地面反射光）。无天空盒/被停用时移除。
 */
export function applySkyEnvLight(engine: EditorEngine, sky: SkyboxNode): void {
  if (!engine.skyLight) {
    const light = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.55);
    // 引擎注入的环境光照明全部层（three 新建灯光默认只算层 0，会被分层渲染
    // 当作"部分掩码灯光"，且多层场景下只照亮层 0）
    light.layers.enableAll();
    light.name = "__skyEnvLight";
    engine.renderer.scene.add(light);
    engine.skyLight = light;
  }
  engine.skyLight.color.setHex(mixHexColor(sky.topColor, sky.horizonColor, 0.5));
  engine.skyLight.groundColor.setHex(sky.groundColor & 0xffffff);
}

export function removeSkyEnvLight(engine: EditorEngine): void {
  if (engine.skyLight) {
    engine.skyLight.parent?.remove(engine.skyLight);
    engine.skyLight = null;
  }
}

/**
 * 正交预览的天空背景面（每帧调用）：仅 预览模式 + 正交活动相机 + 天空盒
 * 清除标志 + 有天空 时启用；uniforms 随活动相机与全局天空纹理更新。
 */
export function updateOrthoSkyQuad(engine: EditorEngine): void {
  const ocam = engine.renderer.getActiveCamera() as THREE.OrthographicCamera | null;
  const node = engine.previewMode ? engine.previewNode : null;
  if (
    !ocam ||
    ocam.isOrthographicCamera !== true ||
    !node ||
    node.clearFlags !== "skybox" ||
    !engine.skyApplied
  ) {
    if (engine.orthoSkyQuad?.visible) engine.orthoSkyQuad.visible = false;
    return;
  }
  const quad = ensureOrthoSkyQuad(engine);
  syncOrthoSkyQuadUniforms(engine, ocam);
  quad.visible = true;
}

/** 天空背景面 uniforms 贴合指定正交相机与全局天空纹理（预览与画中画共用） */
export function syncOrthoSkyQuadUniforms(engine: EditorEngine, ocam: THREE.OrthographicCamera): void {
  const quad = ensureOrthoSkyQuad(engine);
  const u = quad.material.uniforms;
  // 天空纹理两种形态：等距柱状 2D（按光线方向采样 equirectUv）与
  // TextureCube 六面（CubeTexture，直接按光线方向 cube 采样）
  const tex = engine.skyApplied!.texture;
  const isCube = (tex as THREE.Texture & { isCubeTexture?: boolean }).isCubeTexture === true;
  u.uIsCube.value = isCube ? 1 : 0;
  u.tSky.value = isCube ? null : tex;
  u.tSkyCube.value = isCube ? tex : null;
  // 色调映射与透视背景一致：线性 HDR（等距柱状程序化）随渲染器 toneMapping，
  // sRGB 显示域内容（TextureCube）不再映射（同 WebGLBackground 按 colorSpace 判定）
  if (quad.userData.toneMappedForCube !== isCube) {
    quad.userData.toneMappedForCube = isCube;
    quad.material.toneMapped = !isCube;
    quad.material.needsUpdate = true;
  }
  // 天空材质参数：旋转（绕世界 Y）与强度
  u.uSkyRotation.value = THREE.MathUtils.degToRad(engine.skyBgProps.rotation);
  u.uSkyIntensity.value = engine.skyBgProps.intensity;
  // 相机不在场景图内（预览相机）或本帧渲染尚未推进 matrixWorld 时需手动刷新，
  // 否则采到上一帧的姿态（拖动/动画移动相机时天空滞后一帧）
  ocam.updateMatrixWorld();
  (u.projInverse.value as THREE.Matrix4).copy(ocam.projectionMatrixInverse);
  (u.camWorld.value as THREE.Matrix4).copy(ocam.matrixWorld);
}

/** 惰性创建全屏天空背景面（三角形铺满 NDC；最先绘制、不读写深度） */
export function ensureOrthoSkyQuad(engine: EditorEngine): THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> {
  if (!engine.orthoSkyQuad) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    const material = new THREE.ShaderMaterial({
      uniforms: {
        tSky: { value: null },
        tSkyCube: { value: null },
        uIsCube: { value: 0 },
        uSkyRotation: { value: 0 },
        uSkyIntensity: { value: 1 },
        projInverse: { value: new THREE.Matrix4() },
        camWorld: { value: new THREE.Matrix4() },
      },
      vertexShader: /* glsl */ `
        varying vec2 vNdc;
        void main() {
          vNdc = position.xy;
          gl_Position = vec4( position.xy, 1.0, 1.0 );
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tSky;
        uniform samplerCube tSkyCube;
        uniform float uIsCube;
        uniform float uSkyRotation;
        uniform float uSkyIntensity;
        uniform mat4 projInverse;
        uniform mat4 camWorld;
        varying vec2 vNdc;
        #include <common>
        void main() {
          vec4 nearP = projInverse * vec4( vNdc, -1.0, 1.0 );
          vec4 farP = projInverse * vec4( vNdc, 1.0, 1.0 );
          vec3 dir = normalize(
            ( camWorld * vec4( farP.xyz / farP.w, 1.0 ) ).xyz -
            ( camWorld * vec4( nearP.xyz / nearP.w, 1.0 ) ).xyz
          );
          // 天空旋转：采样方向绕世界 Y 轴反向旋转（与 scene.backgroundRotation 一致）
          float cr = cos( uSkyRotation );
          float sr = sin( uSkyRotation );
          vec3 sdir = normalize( vec3( cr * dir.x - sr * dir.z, dir.y, sr * dir.x + cr * dir.z ) );
          vec3 col = uIsCube > 0.5
            ? textureCube( tSkyCube, sdir ).rgb
            : texture2D( tSky, equirectUv( sdir ) ).rgb;
          gl_FragColor = vec4( col * uSkyIntensity, 1.0 );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    const quad = new THREE.Mesh(geometry, material);
    quad.name = "__orthoSkyQuad";
    quad.renderOrder = -1000000; // 最先绘制，被其后绘制的场景物体覆盖
    quad.frustumCulled = false;
    quad.visible = false;
    // 分层多 pass 渲染（Culling Mask）：天空背景面只在首个 pass 绘制，
    // 后续 pass 由 RendererManager 据此标记隐藏（叠加 pass 不能再画天空）
    quad.userData.skyOnlyFirstPass = true;
    engine.renderer.scene.add(quad);
    engine.orthoSkyQuad = quad;
  }
  return engine.orthoSkyQuad;
}

/** 深度优先查找第一个 启用且可见 的天空盒节点（场景树的文档序） */
export function findSkyboxNode(engine: EditorEngine): SkyboxNode | null {
  const root = engine.graph.root;
  if (!root) return null;
  const stack: Node[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n instanceof SkyboxNode && n.active && n.visible) return n;
    const ids = n.childIds;
    for (let i = ids.length - 1; i >= 0; i--) {
      const c = engine.graph.get(ids[i]);
      if (c) stack.push(c);
    }
  }
  return null;
}
