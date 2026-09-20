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
 * 用法：pnpm test（单次）/ pnpm test:watch / pnpm test:coverage
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
      reporter: ["text", "html"],
      include: ["src/ui-kit/**", "src/app/**", "src/components/**"],
      exclude: ["src/**/*.spec.ts", "src/**/*.d.ts", "**/*.scss"],
    },
  },
});
