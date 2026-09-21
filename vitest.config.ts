import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

/**
 * 单元/组件测试配置（vitest）。
 *
 * 有意不复用 vite.config.ts：那份配置在 buildStart 挂了模板索引 / web 预览清单 /
 * 许可证同步 / 主题生成等产物生成插件，还有 Tauri 专用的运行时资产直出中间件；
 * 测试只需要 Vue SFC 编译 + jsdom 环境，独立一份最小配置，避免跑测试触发产物
 * 生成或多页入口逻辑。
 *
 * 用法：pnpm test（单次）/ pnpm test:watch / pnpm test:coverage（HTML + XML 报告）
 * 约定：测试与被测文件同目录，命名 *.spec.ts（详见 tests/README.md）。
 */
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.spec.ts"],
    exclude: ["**/node_modules/**", "dist/**", "src/runtime/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "cobertura", "json-summary"],
      reportsDirectory: "coverage",
      // 覆盖率口径 = 「单元可测面」：ui-kit / components 与 framework 引擎模块。
      // src/app 视图层与重 three/Tauri IPC 的面（Viewport、docks、编辑器壳）不进
      // 单测口径——它们归 pnpm smoke 冒烟回归（见 tests/README.md 约定）。
      include: [
        "src/ui-kit/**",
        "src/components/**",
        "src/framework/**",
      ],
      exclude: [
        "src/**/*.spec.ts",
        "src/**/*.d.ts",
        "**/*.scss",
        "src/framework/scripting/tve.d.ts",
        // 渲染主链路与编辑器引擎壳（EditorEngine/SceneSynchronizer/Renderer）走
        // smoke 与手工验证，不进单测口径
        "src/framework/engine/**",
        "src/framework/render/**",
        // WASM/GPU 后端与 worker（headless 无法单元化）
        "src/framework/physics/backend/**",
        "src/framework/mesh/model-decode-worker.ts",
      ],
      // 阈值（vitest 5 的 glob 键形式：每个键一个独立结算桶，仅统计匹配文件）：
      // 未达标 pnpm test:coverage 以非零码退出（CI-ready 语义）。
      // - 基元核心（Node/Transform/注册表/prefab/types/组件注册表）与各纯逻辑
      //   模块 90/85；派生节点层（prototype/nodes、组件描述符等）宽桶 75/70；
      // - ui（ui-kit 基础组件层）70/60（当前基线 ~74/64，目标逐步提到 80/75）；
      // - 其余 framework 模块不设门槛、仅入报告（渲染/物理等重面归 smoke）。
      thresholds: {
        "src/framework/prototype/Node.ts": { statements: 90, branches: 85, functions: 85, lines: 90 },
        "src/framework/prototype/Transform.ts": { statements: 90, branches: 85, functions: 85, lines: 90 },
        "src/framework/prototype/PrototypeRegistry.ts": { statements: 90, branches: 85, functions: 85, lines: 90 },
        "src/framework/prototype/prefab.ts": { statements: 90, branches: 85, functions: 85, lines: 90 },
        "src/framework/prototype/types.ts": { statements: 90, branches: 85, functions: 85, lines: 90 },
        "src/framework/prototype/components/registry.ts": { statements: 90, branches: 85, functions: 85, lines: 90 },
        "src/framework/prototype/**": { statements: 75, branches: 70, functions: 70, lines: 75 },
        "src/framework/factory/**": { statements: 90, branches: 85, functions: 85, lines: 90 },
        "src/framework/layers/**": { statements: 90, branches: 85, functions: 85, lines: 90 },
        "src/framework/fsm/**": { statements: 90, branches: 85, functions: 85, lines: 90 },
        "src/framework/scene/ScenePrototype.ts": { statements: 90, branches: 85, functions: 85, lines: 90 },
        "src/framework/animation/clip.ts": { statements: 90, branches: 85, functions: 85, lines: 90 },
        "src/framework/material/tsl/**": { statements: 90, branches: 85, functions: 85, lines: 90 },
        "src/framework/lighting/shadow.ts": { statements: 90, branches: 85, functions: 85, lines: 90 },
        "src/framework/logic/types.ts": { statements: 90, branches: 85, functions: 85, lines: 90 },
        "src/framework/terrain/types.ts": { statements: 90, branches: 85, functions: 85, lines: 90 },
        "src/framework/terrain/paint.ts": { statements: 90, branches: 85, functions: 85, lines: 90 },
        "src/framework/terrain/sculpt.ts": { statements: 90, branches: 85, functions: 85, lines: 90 },
        "src/ui-kit/**": { statements: 70, branches: 60, functions: 65, lines: 70 },
        "src/components/**": { statements: 70, branches: 60, functions: 65, lines: 70 },
      },
    },
  },
});
