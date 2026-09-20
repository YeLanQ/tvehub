// 由 scripts/sync-licenses.mjs 自动生成（vite 启动/构建与 pnpm build 时重建；
// 数据源为 public/licenses/**；请勿手动编辑）
export interface DependencyLicenseFile {
  /** 副本文件名（原始文件名） */
  name: string;
  /** 运行时可 fetch 的路径（public 下，站内绝对路径） */
  path: string;
}
export interface DependencyLicense {
  id: string;
  name: string;
  version: string;
  license: string;
  homepage?: string;
  note?: string;
  /** 出处（包名@版本 / vendor 说明） */
  source?: string;
  /** 随附的许可证/声明副本；为空表示上游未随附正文（见 note） */
  files: DependencyLicenseFile[];
}
export const DEPENDENCY_LICENSES: DependencyLicense[] = [
  {
    "id": "dimforge-rapier3d-compat",
    "name": "@dimforge/rapier3d-compat",
    "version": "0.20.0",
    "license": "Apache-2.0",
    "homepage": "https://rapier.rs",
    "note": "物理引擎构建随产物分发（public/engine/runtime/physics-engines/rapier.mjs）",
    "source": "@dimforge/rapier3d-compat@0.20.0",
    "files": [
      {
        "name": "LICENSE",
        "path": "licenses/dimforge-rapier3d-compat/LICENSE"
      }
    ]
  },
  {
    "id": "gltf-transform-core",
    "name": "@gltf-transform/core",
    "version": "4.5.0",
    "license": "MIT",
    "homepage": "https://gltf-transform.dev/",
    "source": "@gltf-transform/core@4.5.0",
    "files": [
      {
        "name": "LICENSE.md",
        "path": "licenses/gltf-transform-core/LICENSE.md"
      }
    ]
  },
  {
    "id": "gltf-transform-extensions",
    "name": "@gltf-transform/extensions",
    "version": "4.5.0",
    "license": "MIT",
    "homepage": "https://gltf-transform.dev/extensions.html",
    "source": "@gltf-transform/extensions@4.5.0",
    "files": [
      {
        "name": "LICENSE.md",
        "path": "licenses/gltf-transform-extensions/LICENSE.md"
      }
    ]
  },
  {
    "id": "gltf-transform-functions",
    "name": "@gltf-transform/functions",
    "version": "4.5.0",
    "license": "MIT",
    "homepage": "https://gltf-transform.dev/functions.html",
    "source": "@gltf-transform/functions@4.5.0",
    "files": [
      {
        "name": "LICENSE.md",
        "path": "licenses/gltf-transform-functions/LICENSE.md"
      }
    ]
  },
  {
    "id": "tauri-apps-api",
    "name": "@tauri-apps/api",
    "version": "2.11.1",
    "license": "Apache-2.0 OR MIT",
    "homepage": "https://github.com/tauri-apps/tauri#readme",
    "source": "@tauri-apps/api@2.11.1",
    "files": [
      {
        "name": "LICENSE_APACHE-2.0",
        "path": "licenses/tauri-apps-api/LICENSE_APACHE-2.0"
      },
      {
        "name": "LICENSE_MIT",
        "path": "licenses/tauri-apps-api/LICENSE_MIT"
      }
    ]
  },
  {
    "id": "tauri-apps-plugin-opener",
    "name": "@tauri-apps/plugin-opener",
    "version": "2.5.5",
    "license": "MIT OR Apache-2.0",
    "homepage": "https://github.com/tauri-apps/plugins-workspace",
    "note": "上游仅随附 SPDX 文档（LICENSE.spdx），未附许可证正文",
    "source": "@tauri-apps/plugin-opener@2.5.5",
    "files": [
      {
        "name": "LICENSE.spdx",
        "path": "licenses/tauri-apps-plugin-opener/LICENSE.spdx"
      }
    ]
  },
  {
    "id": "vue-flow-background",
    "name": "@vue-flow/background",
    "version": "1.3.2",
    "license": "MIT",
    "homepage": "https://github.com/bcakmakoglu/vue-flow#readme",
    "source": "@vue-flow/background@1.3.2",
    "files": [
      {
        "name": "LICENSE",
        "path": "licenses/vue-flow-background/LICENSE"
      }
    ]
  },
  {
    "id": "vue-flow-controls",
    "name": "@vue-flow/controls",
    "version": "1.1.3",
    "license": "MIT",
    "homepage": "https://github.com/bcakmakoglu/vue-flow#readme",
    "source": "@vue-flow/controls@1.1.3",
    "files": [
      {
        "name": "LICENSE",
        "path": "licenses/vue-flow-controls/LICENSE"
      }
    ]
  },
  {
    "id": "vue-flow-core",
    "name": "@vue-flow/core",
    "version": "1.48.2",
    "license": "MIT",
    "homepage": "https://vueflow.dev",
    "source": "@vue-flow/core@1.48.2",
    "files": [
      {
        "name": "LICENSE",
        "path": "licenses/vue-flow-core/LICENSE"
      }
    ]
  },
  {
    "id": "vue-flow-minimap",
    "name": "@vue-flow/minimap",
    "version": "1.5.4",
    "license": "MIT",
    "homepage": "https://github.com/bcakmakoglu/vue-flow#readme",
    "source": "@vue-flow/minimap@1.5.4",
    "files": [
      {
        "name": "LICENSE",
        "path": "licenses/vue-flow-minimap/LICENSE"
      }
    ]
  },
  {
    "id": "vue-flow-node-resizer",
    "name": "@vue-flow/node-resizer",
    "version": "1.5.1",
    "license": "MIT",
    "homepage": "https://github.com/bcakmakoglu/vue-flow#readme",
    "source": "@vue-flow/node-resizer@1.5.1",
    "files": [
      {
        "name": "LICENSE",
        "path": "licenses/vue-flow-node-resizer/LICENSE"
      }
    ]
  },
  {
    "id": "ammo",
    "name": "ammo.js (Bullet Physics)",
    "version": "—",
    "license": "Zlib",
    "homepage": "https://github.com/kripken/ammo.js",
    "note": "物理引擎 ammo 后端随产物分发（public/engine/runtime/physics-engines/ammo/）；上游未随附许可证正文",
    "source": "引擎内置 vendor 资产（见 src/runtime/extra/README.md）",
    "files": []
  },
  {
    "id": "draco",
    "name": "Draco (draco_decoder)",
    "version": "—",
    "license": "Apache-2.0",
    "homepage": "https://github.com/google/draco",
    "note": "Draco 解码器随产物分发（public/engine/runtime/loaders/draco/），经 three examples/jsm/libs 拷贝；上游副本未随附许可证正文",
    "source": "引擎内置 vendor 资产（见 src/runtime/extra/README.md）",
    "files": []
  },
  {
    "id": "draco3dgltf",
    "name": "draco3dgltf",
    "version": "1.5.7",
    "license": "Apache-2.0",
    "homepage": "git+https://github.com/google/draco.git",
    "note": "压缩 glTF 资产处理用；上游包未随附许可证正文，见上游仓库",
    "source": "draco3dgltf@1.5.7",
    "files": []
  },
  {
    "id": "fflate",
    "name": "fflate",
    "version": "0.8.3",
    "license": "MIT",
    "homepage": "https://101arrowz.github.io/fflate",
    "note": "随产物分发（public/engine/runtime/loaders/fflate.module.js）",
    "source": "fflate@0.8.3",
    "files": [
      {
        "name": "LICENSE",
        "path": "licenses/fflate/LICENSE"
      }
    ]
  },
  {
    "id": "jolt-physics",
    "name": "jolt-physics",
    "version": "1.1.0",
    "license": "MIT",
    "homepage": "https://github.com/jrouwe/JoltPhysics.js",
    "note": "物理引擎构建随产物分发（public/engine/runtime/physics-engines/jolt.mjs）",
    "source": "jolt-physics@1.1.0",
    "files": [
      {
        "name": "LICENSE",
        "path": "licenses/jolt-physics/LICENSE"
      }
    ]
  },
  {
    "id": "ktx-software",
    "name": "KTX-Software (basis_transcoder)",
    "version": "—",
    "license": "Apache-2.0",
    "homepage": "https://github.com/KhronosGroup/KTX-Software",
    "note": "KTX2 转码器随产物分发（public/engine/runtime/loaders/basis/），经 three examples/jsm/libs 拷贝；上游副本未随附许可证正文",
    "source": "引擎内置 vendor 资产（见 src/runtime/extra/README.md）",
    "files": []
  },
  {
    "id": "meshoptimizer",
    "name": "meshoptimizer",
    "version": "1.2.0",
    "license": "MIT",
    "homepage": "https://github.com/zeux/meshoptimizer",
    "note": "随产物分发（public/engine/runtime/loaders/meshopt_decoder.module.js）",
    "source": "meshoptimizer@1.2.0",
    "files": [
      {
        "name": "LICENSE.md",
        "path": "licenses/meshoptimizer/LICENSE.md"
      }
    ]
  },
  {
    "id": "monaco-editor",
    "name": "monaco-editor",
    "version": "0.52.2",
    "license": "MIT",
    "homepage": "https://github.com/microsoft/monaco-editor",
    "source": "monaco-editor@0.52.2",
    "files": [
      {
        "name": "LICENSE",
        "path": "licenses/monaco-editor/LICENSE"
      },
      {
        "name": "ThirdPartyNotices.txt",
        "path": "licenses/monaco-editor/ThirdPartyNotices.txt"
      }
    ]
  },
  {
    "id": "three",
    "name": "three",
    "version": "0.185.1",
    "license": "MIT",
    "homepage": "https://threejs.org/",
    "source": "three@0.185.1",
    "files": [
      {
        "name": "LICENSE",
        "path": "licenses/three/LICENSE"
      }
    ]
  },
  {
    "id": "typescript",
    "name": "typescript",
    "version": "5.6.2",
    "license": "Apache-2.0",
    "homepage": "https://www.typescriptlang.org/",
    "source": "typescript@5.6.2",
    "files": [
      {
        "name": "LICENSE.txt",
        "path": "licenses/typescript/LICENSE.txt"
      }
    ]
  },
  {
    "id": "vue",
    "name": "vue",
    "version": "3.5.42",
    "license": "MIT",
    "homepage": "https://vuejs.org/",
    "source": "vue@3.5.42",
    "files": [
      {
        "name": "LICENSE",
        "path": "licenses/vue/LICENSE"
      }
    ]
  }
];
