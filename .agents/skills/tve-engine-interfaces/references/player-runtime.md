# 单元：播放运行时模块与帧循环（`src/runtime/` → player.mjs）

## 契约

**模块清单**（源 → 产物映射：`src/runtime/` 下 `core/X.ts` 编译为 `public/engine/core/` 下同名 `.mjs`，`runtime/X.ts` 同理进 `public/engine/runtime/`）：

- core/：tve.ts（SDK）、scripts.ts（脚本宿主）、tween.ts、log.ts（postLog）、
  utils.ts、particles.ts（GLSL 粒子材质）、particleNodeMaterial.ts + nodeMaterialHooks.ts
  + glslToTsl.ts（WebGPU/TSL，与 framework/material/tsl 词法器镜像）、lights.ts
- runtime/：stage（createRenderer/createStage）、nodes（buildSceneTree 场景树重建）、
  camera、shadow（refitShadowCameras）、mesh、model（GLTF/FBX 实例化）、material、
  textures、sky、fog/heightFog、terrain、particles、animation(+worker)/animclip、
  audio、physics(+worker)、nav、logic、ui、batching（静态批处理）、layerpass
  （Culling Mask 分 pass）、lod、shader(+Hooks)、graph-kernel/runtime/behaviors、
  pak/asset-bundle/resource（打包资产 shim）、loaders/compressed

**player.mjs 只做装配**（952 行，源即产物手写维护）：main() 流程 =
读 scene.json/config.json（或 `window.__TVE_BUILD_DATA` 内联）→ createRenderer/
createStage → buildSceneTree → loadModels/loadMaterialParams/applyMeshTextures →
sky/fog/terrain → createPhysicsWorker → createUI → createLogic → createScripts →
createGraphBehaviors → createNavRuntime → createClipAnimations/createAnimationsWorker
→ createParticles → createAudios → createRenderCamera → requestAnimationFrame(frame)。

**帧循环固定顺序**（frame() 本体；动顺序前先读懂注释链）：

```
tickShaderTime → scripts.fixedUpdate(dt)      // 1/60 固定步长，0..n 次
→ scripts.update(dt) → nav.update → logicApi.update → graphBehaviors.update
→ animations.update → physicsApi.update → clipAnims.update → audiosApi.update
→ particlesApi.update                          // 位姿更新后再发射（world 出生点跟上）
→ scripts.lateUpdate(dt) → syncPose()          // 相机节点位姿回填渲染相机
→ refitShadowCameras(scene)                    // 每 20 帧节拍（静态冻结场景跳过）
→ uiApi.update(cam) → applyClearFlags
→ uiApi.beginRender → layerPassBits/renderLayerPasses（掩码全开=单 pass 零开销）
→ uiApi.endRender
```

**帧调度层（功耗，frame() 之外包一层 scheduleFrame）**：目标帧率
`performance.frameRate`（config.json 与场景 settings.performance 通用键；缺省 60，
0 = 不限）——高刷屏锁 60 降 CPU/GPU 功耗；页面隐藏（document.hidden）或容器
不可见（IntersectionObserver）时暂停整个循环，恢复后丢弃暂停期间的巨大帧间隔。
`performance.powerPreference`（"high-performance" / "low-power"，缺省 "default"）
控制 GPU 偏好——缺省不再强制独显（原 high-performance 使混合 GPU 设备功耗数倍）。
静态场景（无脚本/剪辑/物理/UI 画布/导航）且无投影灯时还会整体关闭阴影管线
（`renderer.shadowMap.enabled = false`；有脚本时不推断——tve Light 组件可运行时开
castShadow）。

## 使用例

新增"每帧推进"的系统：照 audios/particles 的装配方式在 player.mjs 挂进循环
（顺序有语义：晚于位姿更新、早于 lateUpdate），同步改 `src/generated/
web-preview-files.ts` 清单（自动生成，见 build-assets.md）。

## 测试例

真实测试例：`scripts/smoke/tracker/smoke-runtime-modules.mjs`（P0）——
全模块**链接检查 + 导出面断言**（如 particles.mjs 必须导出
`createGlslParticleMaterial`/`FADE_OUT_FRACTION`）；`smoke-script-hooks.mjs`
断言 fixedUpdate 步长与三段更新时序。改帧循环顺序/模块导出后必跑
`pnpm test:regression:core`。
