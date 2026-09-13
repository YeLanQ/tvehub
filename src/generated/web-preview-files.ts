// 由 scripts/gen-web-preview-files.mjs 自动生成（vite 启动/构建与 pnpm build
// 时重建；请勿手动编辑）
export const WEB_PREVIEW_RUNTIME_FILES: string[] = [
  "engine/core/lights.mjs",
  "engine/core/log.mjs",
  "engine/core/particles.mjs",
  "engine/core/scripts.mjs",
  "engine/core/three.core.min.js",
  "engine/core/three.module.min.js",
  "engine/core/tve.mjs",
  "engine/core/tve/component-base.mjs",
  "engine/core/tve/component-facades.mjs",
  "engine/core/tve/component-light.mjs",
  "engine/core/tve/component-registry.mjs",
  "engine/core/tve/data-center.mjs",
  "engine/core/tve/decorators.mjs",
  "engine/core/tve/delegate.mjs",
  "engine/core/tve/engine-api.mjs",
  "engine/core/tve/entity.mjs",
  "engine/core/tve/input.mjs",
  "engine/core/tve/math.mjs",
  "engine/core/tve/node-types.mjs",
  "engine/core/tve/pool.mjs",
  "engine/core/tve/runtime.mjs",
  "engine/core/tve/state.mjs",
  "engine/core/tve/ui-api.mjs",
  "engine/core/tween.mjs",
  "engine/core/utils.mjs",
  "engine/runtime/animation.mjs",
  "engine/runtime/animclip.mjs",
  "engine/runtime/audio.mjs",
  "engine/runtime/camera.mjs",
  "engine/runtime/fog.mjs",
  "engine/runtime/layerpass.mjs",
  "engine/runtime/loaders/BufferGeometryUtils.js",
  "engine/runtime/loaders/CCDIKSolver.js",
  "engine/runtime/loaders/FBXLoader.js",
  "engine/runtime/loaders/GLTFLoader.js",
  "engine/runtime/loaders/NURBSCurve.js",
  "engine/runtime/loaders/NURBSUtils.js",
  "engine/runtime/loaders/OBJLoader.js",
  "engine/runtime/loaders/SkeletonUtils.js",
  "engine/runtime/loaders/fflate.module.js",
  "engine/runtime/material.mjs",
  "engine/runtime/mesh.mjs",
  "engine/runtime/model.mjs",
  "engine/runtime/nodes.mjs",
  "engine/runtime/pak.mjs",
  "engine/runtime/particles.mjs",
  "engine/runtime/physics.mjs",
  "engine/runtime/shader.mjs",
  "engine/runtime/shaderHooks.mjs",
  "engine/runtime/sky.mjs",
  "engine/runtime/stage.mjs",
  "engine/runtime/terrain.mjs",
  "engine/runtime/textures.mjs",
  "engine/runtime/ui.mjs",
  "index.html",
  "player.mjs"
];
export const WEB_PREVIEW_PHYSICS_FILES_BY_BACKEND: Record<string, string[]> = {
  "ammo": [
    "engine/runtime/physics-engines/ammo/ammo-esm.mjs",
    "engine/runtime/physics-engines/ammo/ammo-glue.mjs",
    "engine/runtime/physics-engines/ammo/ammo-wasm-b64.mjs"
  ],
  "jolt": [
    "engine/runtime/physics-engines/jolt.mjs"
  ],
  "rapier": [
    "engine/runtime/physics-engines/rapier.mjs"
  ]
};
export const WEB_PREVIEW_WEBGPU_FILES: string[] = [
  "engine/core/three.webgpu.min.js",
  "engine/core/particleNodeMaterial.mjs",
  "engine/core/glslToTsl.mjs",
  "engine/core/nodeMaterialHooks.mjs"
];
