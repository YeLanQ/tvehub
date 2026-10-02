// 由 runtime/scripts/manifest.mjs 自动生成（vite 启动/构建与 pnpm build
// 时重建；请勿手动编辑。双渠道运行时清单统一事实源）
export interface ChannelRuntimeFile { key: string; rel: string; url: string; }
export interface ChannelRuntimeSpec { id: "web" | "wechat"; base: ChannelRuntimeFile[]; groups: Record<string, ChannelRuntimeFile[]>; }
export const CHANNEL_RUNTIMES: Record<"web" | "wechat", ChannelRuntimeSpec> = {
  "web": {
    "id": "web",
    "base": [
      {
        "key": "engine/core/lights.mjs",
        "rel": "engine/core/lights.mjs",
        "url": "/engine/core/lights.mjs"
      },
      {
        "key": "engine/core/log.mjs",
        "rel": "engine/core/log.mjs",
        "url": "/engine/core/log.mjs"
      },
      {
        "key": "engine/core/particles.mjs",
        "rel": "engine/core/particles.mjs",
        "url": "/engine/core/particles.mjs"
      },
      {
        "key": "engine/core/scripts.mjs",
        "rel": "engine/core/scripts.mjs",
        "url": "/engine/core/scripts.mjs"
      },
      {
        "key": "engine/core/three.core.min.js",
        "rel": "engine/core/three.core.min.js",
        "url": "/engine/core/three.core.min.js"
      },
      {
        "key": "engine/core/three.module.min.js",
        "rel": "engine/core/three.module.min.js",
        "url": "/engine/core/three.module.min.js"
      },
      {
        "key": "engine/core/tve.mjs",
        "rel": "engine/core/tve.mjs",
        "url": "/engine/core/tve.mjs"
      },
      {
        "key": "engine/core/tve/component-base.mjs",
        "rel": "engine/core/tve/component-base.mjs",
        "url": "/engine/core/tve/component-base.mjs"
      },
      {
        "key": "engine/core/tve/component-facades.mjs",
        "rel": "engine/core/tve/component-facades.mjs",
        "url": "/engine/core/tve/component-facades.mjs"
      },
      {
        "key": "engine/core/tve/component-light.mjs",
        "rel": "engine/core/tve/component-light.mjs",
        "url": "/engine/core/tve/component-light.mjs"
      },
      {
        "key": "engine/core/tve/component-registry.mjs",
        "rel": "engine/core/tve/component-registry.mjs",
        "url": "/engine/core/tve/component-registry.mjs"
      },
      {
        "key": "engine/core/tve/data-center.mjs",
        "rel": "engine/core/tve/data-center.mjs",
        "url": "/engine/core/tve/data-center.mjs"
      },
      {
        "key": "engine/core/tve/decorators.mjs",
        "rel": "engine/core/tve/decorators.mjs",
        "url": "/engine/core/tve/decorators.mjs"
      },
      {
        "key": "engine/core/tve/delegate.mjs",
        "rel": "engine/core/tve/delegate.mjs",
        "url": "/engine/core/tve/delegate.mjs"
      },
      {
        "key": "engine/core/tve/engine-api.mjs",
        "rel": "engine/core/tve/engine-api.mjs",
        "url": "/engine/core/tve/engine-api.mjs"
      },
      {
        "key": "engine/core/tve/entity.mjs",
        "rel": "engine/core/tve/entity.mjs",
        "url": "/engine/core/tve/entity.mjs"
      },
      {
        "key": "engine/core/tve/input.mjs",
        "rel": "engine/core/tve/input.mjs",
        "url": "/engine/core/tve/input.mjs"
      },
      {
        "key": "engine/core/tve/logic-api.mjs",
        "rel": "engine/core/tve/logic-api.mjs",
        "url": "/engine/core/tve/logic-api.mjs"
      },
      {
        "key": "engine/core/tve/math.mjs",
        "rel": "engine/core/tve/math.mjs",
        "url": "/engine/core/tve/math.mjs"
      },
      {
        "key": "engine/core/tve/node-types.mjs",
        "rel": "engine/core/tve/node-types.mjs",
        "url": "/engine/core/tve/node-types.mjs"
      },
      {
        "key": "engine/core/tve/pool.mjs",
        "rel": "engine/core/tve/pool.mjs",
        "url": "/engine/core/tve/pool.mjs"
      },
      {
        "key": "engine/core/tve/runtime.mjs",
        "rel": "engine/core/tve/runtime.mjs",
        "url": "/engine/core/tve/runtime.mjs"
      },
      {
        "key": "engine/core/tve/state.mjs",
        "rel": "engine/core/tve/state.mjs",
        "url": "/engine/core/tve/state.mjs"
      },
      {
        "key": "engine/core/tve/ui-api.mjs",
        "rel": "engine/core/tve/ui-api.mjs",
        "url": "/engine/core/tve/ui-api.mjs"
      },
      {
        "key": "engine/core/tween.mjs",
        "rel": "engine/core/tween.mjs",
        "url": "/engine/core/tween.mjs"
      },
      {
        "key": "engine/core/utils.mjs",
        "rel": "engine/core/utils.mjs",
        "url": "/engine/core/utils.mjs"
      },
      {
        "key": "engine/runtime/animation-worker.mjs",
        "rel": "engine/runtime/animation-worker.mjs",
        "url": "/engine/runtime/animation-worker.mjs"
      },
      {
        "key": "engine/runtime/animation.mjs",
        "rel": "engine/runtime/animation.mjs",
        "url": "/engine/runtime/animation.mjs"
      },
      {
        "key": "engine/runtime/animclip.mjs",
        "rel": "engine/runtime/animclip.mjs",
        "url": "/engine/runtime/animclip.mjs"
      },
      {
        "key": "engine/runtime/asset-bundle.mjs",
        "rel": "engine/runtime/asset-bundle.mjs",
        "url": "/engine/runtime/asset-bundle.mjs"
      },
      {
        "key": "engine/runtime/audio.mjs",
        "rel": "engine/runtime/audio.mjs",
        "url": "/engine/runtime/audio.mjs"
      },
      {
        "key": "engine/runtime/batching.mjs",
        "rel": "engine/runtime/batching.mjs",
        "url": "/engine/runtime/batching.mjs"
      },
      {
        "key": "engine/runtime/camera.mjs",
        "rel": "engine/runtime/camera.mjs",
        "url": "/engine/runtime/camera.mjs"
      },
      {
        "key": "engine/runtime/fog.mjs",
        "rel": "engine/runtime/fog.mjs",
        "url": "/engine/runtime/fog.mjs"
      },
      {
        "key": "engine/runtime/graph-behaviors.mjs",
        "rel": "engine/runtime/graph-behaviors.mjs",
        "url": "/engine/runtime/graph-behaviors.mjs"
      },
      {
        "key": "engine/runtime/graph-core-modules.mjs",
        "rel": "engine/runtime/graph-core-modules.mjs",
        "url": "/engine/runtime/graph-core-modules.mjs"
      },
      {
        "key": "engine/runtime/graph-kernel.mjs",
        "rel": "engine/runtime/graph-kernel.mjs",
        "url": "/engine/runtime/graph-kernel.mjs"
      },
      {
        "key": "engine/runtime/graph-prop-path.mjs",
        "rel": "engine/runtime/graph-prop-path.mjs",
        "url": "/engine/runtime/graph-prop-path.mjs"
      },
      {
        "key": "engine/runtime/graph-runtime.mjs",
        "rel": "engine/runtime/graph-runtime.mjs",
        "url": "/engine/runtime/graph-runtime.mjs"
      },
      {
        "key": "engine/runtime/heightFog.mjs",
        "rel": "engine/runtime/heightFog.mjs",
        "url": "/engine/runtime/heightFog.mjs"
      },
      {
        "key": "engine/runtime/layerpass.mjs",
        "rel": "engine/runtime/layerpass.mjs",
        "url": "/engine/runtime/layerpass.mjs"
      },
      {
        "key": "engine/runtime/loaders/BufferGeometryUtils.js",
        "rel": "engine/runtime/loaders/BufferGeometryUtils.js",
        "url": "/engine/runtime/loaders/BufferGeometryUtils.js"
      },
      {
        "key": "engine/runtime/loaders/CCDIKSolver.js",
        "rel": "engine/runtime/loaders/CCDIKSolver.js",
        "url": "/engine/runtime/loaders/CCDIKSolver.js"
      },
      {
        "key": "engine/runtime/loaders/FBXLoader.js",
        "rel": "engine/runtime/loaders/FBXLoader.js",
        "url": "/engine/runtime/loaders/FBXLoader.js"
      },
      {
        "key": "engine/runtime/loaders/GLTFLoader.js",
        "rel": "engine/runtime/loaders/GLTFLoader.js",
        "url": "/engine/runtime/loaders/GLTFLoader.js"
      },
      {
        "key": "engine/runtime/loaders/NURBSCurve.js",
        "rel": "engine/runtime/loaders/NURBSCurve.js",
        "url": "/engine/runtime/loaders/NURBSCurve.js"
      },
      {
        "key": "engine/runtime/loaders/NURBSUtils.js",
        "rel": "engine/runtime/loaders/NURBSUtils.js",
        "url": "/engine/runtime/loaders/NURBSUtils.js"
      },
      {
        "key": "engine/runtime/loaders/OBJLoader.js",
        "rel": "engine/runtime/loaders/OBJLoader.js",
        "url": "/engine/runtime/loaders/OBJLoader.js"
      },
      {
        "key": "engine/runtime/loaders/SkeletonUtils.js",
        "rel": "engine/runtime/loaders/SkeletonUtils.js",
        "url": "/engine/runtime/loaders/SkeletonUtils.js"
      },
      {
        "key": "engine/runtime/loaders/compressed.mjs",
        "rel": "engine/runtime/loaders/compressed.mjs",
        "url": "/engine/runtime/loaders/compressed.mjs"
      },
      {
        "key": "engine/runtime/loaders/fflate.module.js",
        "rel": "engine/runtime/loaders/fflate.module.js",
        "url": "/engine/runtime/loaders/fflate.module.js"
      },
      {
        "key": "engine/runtime/loaders/meshopt_decoder.module.js",
        "rel": "engine/runtime/loaders/meshopt_decoder.module.js",
        "url": "/engine/runtime/loaders/meshopt_decoder.module.js"
      },
      {
        "key": "engine/runtime/lod.mjs",
        "rel": "engine/runtime/lod.mjs",
        "url": "/engine/runtime/lod.mjs"
      },
      {
        "key": "engine/runtime/logic.mjs",
        "rel": "engine/runtime/logic.mjs",
        "url": "/engine/runtime/logic.mjs"
      },
      {
        "key": "engine/runtime/material.mjs",
        "rel": "engine/runtime/material.mjs",
        "url": "/engine/runtime/material.mjs"
      },
      {
        "key": "engine/runtime/mesh.mjs",
        "rel": "engine/runtime/mesh.mjs",
        "url": "/engine/runtime/mesh.mjs"
      },
      {
        "key": "engine/runtime/model.mjs",
        "rel": "engine/runtime/model.mjs",
        "url": "/engine/runtime/model.mjs"
      },
      {
        "key": "engine/runtime/nav.mjs",
        "rel": "engine/runtime/nav.mjs",
        "url": "/engine/runtime/nav.mjs"
      },
      {
        "key": "engine/runtime/nodes.mjs",
        "rel": "engine/runtime/nodes.mjs",
        "url": "/engine/runtime/nodes.mjs"
      },
      {
        "key": "engine/runtime/pak.mjs",
        "rel": "engine/runtime/pak.mjs",
        "url": "/engine/runtime/pak.mjs"
      },
      {
        "key": "engine/runtime/particles.mjs",
        "rel": "engine/runtime/particles.mjs",
        "url": "/engine/runtime/particles.mjs"
      },
      {
        "key": "engine/runtime/physics-worker.mjs",
        "rel": "engine/runtime/physics-worker.mjs",
        "url": "/engine/runtime/physics-worker.mjs"
      },
      {
        "key": "engine/runtime/physics.mjs",
        "rel": "engine/runtime/physics.mjs",
        "url": "/engine/runtime/physics.mjs"
      },
      {
        "key": "engine/runtime/resource.mjs",
        "rel": "engine/runtime/resource.mjs",
        "url": "/engine/runtime/resource.mjs"
      },
      {
        "key": "engine/runtime/shader.mjs",
        "rel": "engine/runtime/shader.mjs",
        "url": "/engine/runtime/shader.mjs"
      },
      {
        "key": "engine/runtime/shaderHooks.mjs",
        "rel": "engine/runtime/shaderHooks.mjs",
        "url": "/engine/runtime/shaderHooks.mjs"
      },
      {
        "key": "engine/runtime/shadow.mjs",
        "rel": "engine/runtime/shadow.mjs",
        "url": "/engine/runtime/shadow.mjs"
      },
      {
        "key": "engine/runtime/sky.mjs",
        "rel": "engine/runtime/sky.mjs",
        "url": "/engine/runtime/sky.mjs"
      },
      {
        "key": "engine/runtime/stage.mjs",
        "rel": "engine/runtime/stage.mjs",
        "url": "/engine/runtime/stage.mjs"
      },
      {
        "key": "engine/runtime/terrain.mjs",
        "rel": "engine/runtime/terrain.mjs",
        "url": "/engine/runtime/terrain.mjs"
      },
      {
        "key": "engine/runtime/textures.mjs",
        "rel": "engine/runtime/textures.mjs",
        "url": "/engine/runtime/textures.mjs"
      },
      {
        "key": "engine/runtime/ui.mjs",
        "rel": "engine/runtime/ui.mjs",
        "url": "/engine/runtime/ui.mjs"
      },
      {
        "key": "index.html",
        "rel": "index.html",
        "url": "/web-preview/index.html"
      },
      {
        "key": "player.mjs",
        "rel": "player.mjs",
        "url": "/web-preview/player.mjs"
      }
    ],
    "groups": {
      "physics:ammo": [
        {
          "key": "engine/runtime/physics-engines/ammo/ammo-esm.mjs",
          "rel": "engine/runtime/physics-engines/ammo/ammo-esm.mjs",
          "url": "/engine/runtime/physics-engines/ammo/ammo-esm.mjs"
        },
        {
          "key": "engine/runtime/physics-engines/ammo/ammo-glue.mjs",
          "rel": "engine/runtime/physics-engines/ammo/ammo-glue.mjs",
          "url": "/engine/runtime/physics-engines/ammo/ammo-glue.mjs"
        },
        {
          "key": "engine/runtime/physics-engines/ammo/ammo-wasm-b64.mjs",
          "rel": "engine/runtime/physics-engines/ammo/ammo-wasm-b64.mjs",
          "url": "/engine/runtime/physics-engines/ammo/ammo-wasm-b64.mjs"
        }
      ],
      "physics:jolt": [
        {
          "key": "engine/runtime/physics-engines/jolt.mjs",
          "rel": "engine/runtime/physics-engines/jolt.mjs",
          "url": "/engine/runtime/physics-engines/jolt.mjs"
        }
      ],
      "physics:rapier": [
        {
          "key": "engine/runtime/physics-engines/rapier.mjs",
          "rel": "engine/runtime/physics-engines/rapier.mjs",
          "url": "/engine/runtime/physics-engines/rapier.mjs"
        }
      ],
      "webgpu": [
        {
          "key": "engine/core/glslToTsl.mjs",
          "rel": "engine/core/glslToTsl.mjs",
          "url": "/engine/core/glslToTsl.mjs"
        },
        {
          "key": "engine/core/nodeMaterialHooks.mjs",
          "rel": "engine/core/nodeMaterialHooks.mjs",
          "url": "/engine/core/nodeMaterialHooks.mjs"
        },
        {
          "key": "engine/core/particleNodeMaterial.mjs",
          "rel": "engine/core/particleNodeMaterial.mjs",
          "url": "/engine/core/particleNodeMaterial.mjs"
        },
        {
          "key": "engine/core/three.webgpu.min.js",
          "rel": "engine/core/three.webgpu.min.js",
          "url": "/engine/core/three.webgpu.min.js"
        }
      ],
      "draco": [
        {
          "key": "engine/runtime/loaders/draco/draco_decoder.js",
          "rel": "engine/runtime/loaders/draco/draco_decoder.js",
          "url": "/engine/runtime/loaders/draco/draco_decoder.js"
        }
      ],
      "basis": [
        {
          "key": "engine/runtime/loaders/basis/basis_transcoder.js",
          "rel": "engine/runtime/loaders/basis/basis_transcoder.js",
          "url": "/engine/runtime/loaders/basis/basis_transcoder.js"
        }
      ]
    }
  },
  "wechat": {
    "id": "wechat",
    "base": [
      {
        "key": "code.js",
        "rel": "exports/wechat/runtime/code.js",
        "url": "/exports/wechat/runtime/code.js"
      },
      {
        "key": "engine/core/tve.js",
        "rel": "exports/wechat/runtime/engine/core/tve.js",
        "url": "/exports/wechat/runtime/engine/core/tve.js"
      },
      {
        "key": "engine/runtime/loaders/meshopt_decoder.wasm",
        "rel": "exports/wechat/runtime/engine/runtime/loaders/meshopt_decoder.wasm",
        "url": "/exports/wechat/runtime/engine/runtime/loaders/meshopt_decoder.wasm"
      }
    ],
    "groups": {
      "physics:ammo": [
        {
          "key": "engine/runtime/physics-engines/ammo/ammo-esm.js",
          "rel": "exports/wechat/runtime/engine/runtime/physics-engines/ammo/ammo-esm.js",
          "url": "/exports/wechat/runtime/engine/runtime/physics-engines/ammo/ammo-esm.js"
        },
        {
          "key": "engine/runtime/physics-engines/ammo/ammo.wasm",
          "rel": "exports/wechat/runtime/engine/runtime/physics-engines/ammo/ammo.wasm",
          "url": "/exports/wechat/runtime/engine/runtime/physics-engines/ammo/ammo.wasm"
        }
      ],
      "physics:jolt": [
        {
          "key": "engine/runtime/physics-engines/jolt.js",
          "rel": "exports/wechat/runtime/engine/runtime/physics-engines/jolt.js",
          "url": "/exports/wechat/runtime/engine/runtime/physics-engines/jolt.js"
        },
        {
          "key": "engine/runtime/physics-engines/jolt.wasm",
          "rel": "exports/wechat/runtime/engine/runtime/physics-engines/jolt.wasm",
          "url": "/exports/wechat/runtime/engine/runtime/physics-engines/jolt.wasm"
        }
      ],
      "physics:rapier": [
        {
          "key": "engine/runtime/physics-engines/rapier.js",
          "rel": "exports/wechat/runtime/engine/runtime/physics-engines/rapier.js",
          "url": "/exports/wechat/runtime/engine/runtime/physics-engines/rapier.js"
        },
        {
          "key": "engine/runtime/physics-engines/rapier.wasm",
          "rel": "exports/wechat/runtime/engine/runtime/physics-engines/rapier.wasm",
          "url": "/exports/wechat/runtime/engine/runtime/physics-engines/rapier.wasm"
        }
      ]
    }
  }
};
