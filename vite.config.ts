import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import fs from "node:fs";
import path from "node:path";
import {
  WEB_PREVIEW_ROOTS,
  generateWebPreviewFiles,
} from "./scripts/gen-web-preview-files.mjs";
import { buildRuntime } from "./scripts/build-runtime.mjs";
import {
  LICENSE_ROOT,
  syncLicenses,
  generateLicenseRegistry,
} from "./scripts/sync-licenses.mjs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// 应用显示版本：单一来源 = src-tauri/tauri.conf.json 的 version（semver + 构建号，
// 也是 exe 文件版本资源的来源），构建期注入 __APP_VERSION__（+N 规范为第 4 段 .N）
function appDisplayVersion(): string {
  try {
    const conf = JSON.parse(fs.readFileSync(path.resolve(__dirname, "src-tauri/tauri.conf.json"), "utf-8"));
    return String(conf.version ?? "").replace(/\+([0-9A-Za-z.-]+)$/, ".$1");
  } catch {
    return "";
  }
}
const APP_VERSION = appDisplayVersion();

/**
 * 模板注册表插件：扫描 public/templates/（项目模板）与 public/exports/web/
 * （web 导出模板）下含 template.json 的目录，把模板元信息生成到
 * src/generated/template-registry.ts。开发服务器启动/模板文件变化时自动重建，
 * 构建（buildStart）时同样生成 —— 前端直接 import 该模块（模板列表零 fetch 依赖），
 * 模板目录下新增模板即自动注册。
 * 同一插件顺带维护第三方许可：依赖许可证副本同步 + 清单生成（见
 * scripts/sync-licenses.mjs：public/licenses/** → src/generated/license-registry.ts，
 * 首页「偏好设置 → 关于」消费；目录变化时重建清单）。
 */
const TEMPLATE_ROOT = "public/templates";
const WEB_EXPORT_ROOT = "public/exports/web";
const REGISTRY_PATH = "src/generated/template-registry.ts";

// 网页运行产物清单的扫描/生成在 scripts/gen-web-preview-files.mjs（单一事实来源：
// 同一函数也被 package.json 的 build 脚本在 vue-tsc 之前调用，避免干净检出的
// 类型检查因生成文件缺失而报 TS2307）。

interface TplMeta {
  name?: string;
  description?: string;
  kind?: string;
  files?: string[];
  mode?: string;
}

function readTplMeta(dir: string): TplMeta {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "template.json"), "utf-8")) as TplMeta;
  } catch {
    return {};
  }
}

function listTemplateDirs(root: string): string[] {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(abs, e.name, "template.json")))
    .map((e) => e.name)
    .sort();
}

function generateTemplateRegistry() {
  const projectTemplates = listTemplateDirs(TEMPLATE_ROOT).map((dir) => {
    const m = readTplMeta(path.join(TEMPLATE_ROOT, dir));
    return {
      id: `builtin:${dir}`,
      dir,
      name: m.name ?? dir,
      description: m.description ?? "",
      kind: m.kind ?? "3d",
      files: m.files ?? [],
    };
  });

  // web 导出模板：mode 决定产物形态（multi=多文件 / single=单页），非法值回退 multi
  const webExportTemplates = listTemplateDirs(WEB_EXPORT_ROOT).map((dir) => {
    const m = readTplMeta(path.join(WEB_EXPORT_ROOT, dir));
    return {
      id: `web:${dir}`,
      dir,
      name: m.name ?? dir,
      description: m.description ?? "",
      mode: m.mode === "single" ? "single" : "multi",
    };
  });

  const content =
    `// 由 vite.config.ts 模板索引插件自动生成（模板目录变化时重建；请勿手动编辑）\n` +
    `export interface BuiltinProjectTemplateInfo { id: string; dir: string; name: string; description: string; kind: string; files: string[]; }\n` +
    `export const PROJECT_TEMPLATES: BuiltinProjectTemplateInfo[] = ${JSON.stringify(projectTemplates, null, 2)};\n` +
    `export interface BuiltinWebExportTemplateInfo { id: string; dir: string; name: string; description: string; mode: "multi" | "single"; }\n` +
    `export const WEB_EXPORT_TEMPLATES: BuiltinWebExportTemplateInfo[] = ${JSON.stringify(webExportTemplates, null, 2)};\n`;
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, content);
}

function templateIndexPlugin(): Plugin {
  return {
    name: "three-visual-editor-template-index",
    buildStart() {
      generateTemplateRegistry();
      generateWebPreviewFiles();
      syncLicenses(); // 依赖升级后补齐 public/licenses 副本
      generateLicenseRegistry();
    },
    configureServer(server) {
      generateTemplateRegistry();
      generateWebPreviewFiles();
      syncLicenses();
      generateLicenseRegistry();
      for (const root of [TEMPLATE_ROOT, WEB_EXPORT_ROOT, LICENSE_ROOT]) {
        const abs = path.resolve(root);
        if (fs.existsSync(abs)) server.watcher.add(abs);
      }
      for (const root of WEB_PREVIEW_ROOTS) {
        const abs = path.resolve(root);
        if (fs.existsSync(abs)) server.watcher.add(abs, { recursive: true });
      }
      const onChange = (file: string) => {
        if (file.includes("template.json")) generateTemplateRegistry();
        const norm = file.split(path.sep).join("/");
        if (WEB_PREVIEW_ROOTS.some((root) => norm.startsWith(`${root}/`))) {
          generateWebPreviewFiles();
        }
        // 许可证副本目录变化（新增库/手工补正文）→ 重建清单
        if (norm.startsWith(`${LICENSE_ROOT}/`)) generateLicenseRegistry();
      };
      server.watcher.on("add", onChange);
      server.watcher.on("unlink", onChange);
      server.watcher.on("change", onChange);
    },
  };
}

/** 运行时资产缺失守卫（dev）：/engine/** 与 /web-preview/** 是运行时资产（全为构建
 *  产物）。文件缺失时 Vite 的 SPA 兜底会返回 index.html（状态 200），调用方会把 HTML
 *  当 JS/JSON 处理——典型症状：three 的 DRACOLoader/KTX2Loader 把「解码器文本」拼进
 *  Worker Blob，于是抛无从定位的 `SyntaxError: Unexpected token '<'`（HTML 第 2 行）。
 *  这里在内部中间件之前拦截这两个前缀：文件不存在直接 404，与生产静态服务、
 *  Rust 预览服务器（src-tauri/src/preview.rs 返回 404）行为一致。 */
const RUNTIME_ASSET_PREFIXES = ["/engine/", "/web-preview/", "/licenses/"];

function runtimeAssetGuardPlugin(): Plugin {
  return {
    name: "three-visual-editor-runtime-asset-guard",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const method = req.method ?? "GET";
        if (method !== "GET" && method !== "HEAD") return next();
        const pathOnly = (req.url ?? "").split("?")[0].split("#")[0];
        if (!RUNTIME_ASSET_PREFIXES.some((p) => pathOnly.startsWith(p))) return next();
        let decoded: string;
        try {
          decoded = decodeURIComponent(pathOnly);
        } catch {
          return next();
        }
        const abs = path.join(server.config.publicDir, decoded.replace(/^\/+/, ""));
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return next();
        res.statusCode = 404;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(
          `404 Not Found: ${pathOnly}\n` +
            "（运行时资产缺失：public/engine 为构建产物，请确认构建完成——node scripts/build-runtime.mjs）\n",
        );
      });
    },
  };
}

// 运行时自动编译插件（dev）：public/engine 为纯构建产物目录（不入库；源 =
// src/runtime/** 编译 + src/runtime/extra/** 外部资产 + node_modules/three vendor），
// 开发服务器启动时由 buildRuntime() 一次全量再生，并监听源目录变化防抖重建。
// 构建期由 build 链的第一步 node scripts/build-runtime.mjs 负责（同一入口）。
// 注意：本插件必须排在 templateIndexPlugin 之前——dev 的 configureServer 按插件顺序
// 执行，运行产物清单（generateWebPreviewFiles）扫描 public/engine，需先由本插件完成
// 全量再生，干净检出首次启动的清单才完整。
const RUNTIME_SRC_ROOTS = ["src/runtime", "src/framework"];

function runtimeBuildPlugin(): Plugin {
  return {
    name: "three-visual-editor-runtime-build",
    apply: "serve",
    async configureServer(server) {
      await buildRuntime("dev 初始编译").catch((e) => {
        console.error("[runtime-build] 编译失败:", e?.message ?? e);
      });
      let timer: ReturnType<typeof setTimeout> | null = null;
      const schedule = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          void buildRuntime("源变化").catch((e) => {
            console.error("[runtime-build] 重建失败:", e?.message ?? e);
          });
        }, 500);
      };
      for (const root of RUNTIME_SRC_ROOTS) {
        const abs = path.resolve(root);
        if (fs.existsSync(abs)) server.watcher.add(abs);
      }
      const onChange = (file: string) => {
        const norm = file.split(path.sep).join("/");
        if (RUNTIME_SRC_ROOTS.some((root) => norm.startsWith(`${root}/`))) schedule();
      };
      server.watcher.on("add", onChange);
      server.watcher.on("unlink", onChange);
      server.watcher.on("change", onChange);
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [vue(), runtimeAssetGuardPlugin(), runtimeBuildPlugin(), templateIndexPlugin()],

  // 应用显示版本（编译期常量，见 appDisplayVersion）
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },

  // 多页构建：index.html = 编辑器窗口（label "main"），home.html = 首页窗口（label "home"），
  // graph.html = 脚本图窗口（label "graph"）
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        home: path.resolve(__dirname, "home.html"),
        graph: path.resolve(__dirname, "graph.html"),
      },
    },
  },

  // Monaco 的 editor/ts worker 以 ESM 打包（?worker 导入）
  worker: {
    format: "es",
  },


  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
