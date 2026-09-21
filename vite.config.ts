import { defineConfig, send, type Plugin, type UserConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
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
import { THEME_SOURCE, generateLanTheme } from "./scripts/gen-lan-theme.mjs";

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
      generateLanTheme(); // 局域网对外页面的主题色（事实源 = ui-kit 主题变量表）
    },
    configureServer(server) {
      generateTemplateRegistry();
      generateWebPreviewFiles();
      syncLicenses();
      generateLicenseRegistry();
      generateLanTheme();
      for (const root of [TEMPLATE_ROOT, WEB_EXPORT_ROOT, LICENSE_ROOT]) {
        const abs = path.resolve(root);
        if (fs.existsSync(abs)) server.watcher.add(abs);
      }
      for (const root of WEB_PREVIEW_ROOTS) {
        const abs = path.resolve(root);
        // chokidar 运行期接受 options 形参（vite 的 FSWatcher 类型只声明了单参重载）
        // @ts-expect-error 见上
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
        // 主题变量表变化 → 重新生成局域网对外页面的颜色令牌
        if (norm === THEME_SOURCE) generateLanTheme();
      };
      server.watcher.on("add", onChange);
      server.watcher.on("unlink", onChange);
      server.watcher.on("change", onChange);
    },
  };
}

/** 运行时资产直出 + 缺失守卫（dev）。
 *
 *  为什么不能只依赖 Vite 的 public 服务：Vite 6 的 dev public 中间件以「服务器启动时
 *  扫出的 publicFiles 集合」为准，只服务集合内的 URL；启动之后出现的文件要靠 chokidar
 *  的 add 事件补录，而监听用 ignoreInitial: true（初始扫描窗口内的写入一律不产生事件），
 *  被 ignored 规则命中的路径（.git、node_modules、test-results 等）更是永远不产生 add。
 *  本仓库 public/ 下的资产恰好大量属于「服务器起来之后才出现」：
 *  public/engine 由 buildRuntime 在 configureServer 阶段全量再生、public/licenses 由
 *  syncLicenses 同步、public/templates 与 public/exports/web 可随时新增、public/docs 随
 *  子模块检出。一旦撞上上述窗口，这些文件既不在集合里也补不进来，于是永远不被服务。
 *
 *  症状：请求落到 htmlFallbackMiddleware，被 SPA 兜底成 index.html 且状态码 200，调用方
 *  把 HTML 当 JS/JSON 处理——典型症状见 src/app/lib/web-preview-runtime.ts 的拦截
 *  （three.core.min.js 被当模块文本内联成 Worker Blob →
 *  `SyntaxError: Unexpected token '<'`）。重启 dev 服务器不保证恢复（重建窗口同样会撞）。
 *
 *  处理：本中间件在内部中间件之前按磁盘事实响应，不再依赖 Vite 的集合——
 *   · public/ 下真实存在 → 以正确 MIME 直出原始字节（与生产静态服务、以及 Vite 命中
 *     集合时的行为一致），不再可能被兜底成 HTML；
 *   · 「应用按 URL 取用」的目录而文件缺失 → 404（不回退 index.html，让调用方拿到明确
 *     失败），与生产静态服务、Rust 预览服务器（src-tauri/src/preview.rs）一致。
 *  其余请求（不存在、且不在上述目录，例如 SPA 路由）保持原语义交给 Vite。 */
const RUNTIME_ASSET_PREFIXES = [
  "/engine/",
  "/web-preview/",
  "/licenses/",
  "/templates/",
  "/exports/",
  "/docs/",
];

/** 直出 MIME：覆盖 public/ 下实际出现的扩展名（未知按二进制，与 sirv 缺省一致） */
const STATIC_MIME: Record<string, string> = {
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".glsl": "text/plain; charset=utf-8",
  ".shader": "text/plain; charset=utf-8",
  ".hlsl": "text/plain; charset=utf-8",
  ".cg": "text/plain; charset=utf-8",
  ".spdx": "text/plain; charset=utf-8",
};

/** Host 是否为本机访问（localhost / *.localhost / 127.x / [::1] / 无 Host）。
 *  本插件排在 Vite 内部链路之前，若不判断就会绕过 hostCheck —— 故只接管本机请求。 */
function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true;
  let name: string;
  try {
    name = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return name === "localhost" || name.endsWith(".localhost") || name === "[::1]" || /^127\./.test(name);
}

function runtimeAssetGuardPlugin(): Plugin {
  return {
    name: "three-visual-editor-runtime-asset-guard",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const method = req.method ?? "GET";
        if (method !== "GET" && method !== "HEAD") return next();
        // 只接管本机访问（webview 与开发者浏览器都是 localhost/127.0.0.1/[::1]）；
        // 其它 Host 交回 Vite 内部链路，其 hostCheck 语义（DNS rebinding 防护）原样保留。
        if (!isLoopbackHost(req.headers.host)) return next();
        const rawUrl = req.url ?? "";
        // ?import 是 Vite 模块管线的导入标记（public 文件被 import 时由其转换）→ 交回 Vite
        if (rawUrl.includes("?import")) return next();
        const pathOnly = rawUrl.split("?")[0].split("#")[0];
        if (!pathOnly.startsWith("/")) return next();
        let decoded: string;
        try {
          decoded = decodeURIComponent(pathOnly);
        } catch {
          return next();
        }
        const root = path.resolve(server.config.publicDir);
        const abs = path.resolve(root, decoded.replace(/^\/+/, ""));
        // 越出 publicDir（含 .. 穿越）→ 不接管
        if (abs !== root && !abs.startsWith(root + path.sep)) return next();
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          const stat = fs.statSync(abs);
          const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
          if (req.headers["if-none-match"] === etag) {
            res.statusCode = 304;
            res.end();
            return;
          }
          send(req, res, fs.readFileSync(abs), STATIC_MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream", {
            etag,
          });
          return;
        }
        if (RUNTIME_ASSET_PREFIXES.some((p) => pathOnly.startsWith(p))) {
          res.statusCode = 404;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end(
            `404 Not Found: ${pathOnly}\n` +
              "（该路径下文件不存在：这些都是构建/运行期资产——engine 可用 " +
              "node scripts/build-runtime.mjs 再生，其余随仓库或子模块提供）\n",
          );
          return;
        }
        next();
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
      await buildRuntime("dev 初始编译").catch((e: unknown) => {
        console.error("[runtime-build] 编译失败:", e instanceof Error ? e.message : e);
      });
      let timer: ReturnType<typeof setTimeout> | null = null;
      const schedule = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          void buildRuntime("源变化").catch((e: unknown) => {
            console.error("[runtime-build] 重建失败:", e instanceof Error ? e.message : e);
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

// ---------------------------------------------------------------------------
// plugin-vue 的 compiler 预置：修 dev「第二次启动必现」的
//   Cannot read properties of null (reading 'invalidateTypeCache')
//
// @vitejs/plugin-vue@5.2.4 的 handleHotUpdate 在 filter 之前就无条件读 options.compiler，
// 而该字段初值 null、要等它自己的 buildStart 才赋值；vite 又只对 type==="update"（change
// 事件）调用这个已废弃的 hook，并把抛出的异常当 HMR 错误推给已连接的客户端（server 日志
// 里看不到、客户端 F5 后消失；上游同类问题见 withastro/astro#12969）。
//
// 本仓库必现的原因：public/engine 是构建产物，dev 每次启动都在 configureServer 阶段全量
// 重编译并**重写已存在**的 .mjs → 一批 change 事件正好落在「插件容器 buildStart 之前」的
// 窗口里 → 每个文件抛一次。首次启动（engine 不存在/刚删）只有 add 事件，vite 不调用该
// hook，所以第一次是干净的 —— 这也是"删掉 engine 再启动就没问题"的原因。
//
// 处理：在 configResolved（早于 watcher 建立）按 plugin-vue 内部同一解析顺序
// （vue/compiler-sfc → @vue/compiler-sfc）把 compiler 装好，null 窗口即不存在；
// 它自己 buildStart 里的 `options.compiler || …` 不会覆盖。plugin-vue 换代（6.x 改用
// hotUpdate hook 形态）时本函数静默不介入。
// ---------------------------------------------------------------------------
function preseedVueCompiler(vuePlugin: Plugin): void {
  const api = (vuePlugin as { api?: { options?: { compiler?: unknown } } }).api;
  const options = api?.options;
  if (!options || options.compiler) return;
  const nodeRequire = createRequire(import.meta.url);
  for (const id of ["vue/compiler-sfc", "@vue/compiler-sfc"]) {
    try {
      options.compiler = nodeRequire(id);
      return;
    } catch {
      /* 试下一个 id */
    }
  }
}

/** 见上方说明：把 vite:vue 实例的 compiler 提前装好（插件顺序无关） */
function vueCompilerPreseedPlugin(): Plugin {
  return {
    name: "three-visual-editor-vue-compiler-preseed",
    configResolved(config) {
      const vuePlugin = config.plugins.find((p) => p.name === "vite:vue");
      if (vuePlugin) preseedVueCompiler(vuePlugin as Plugin);
    },
  };
}

// https://vite.dev/config/
// 返回类型注解是必需而非风格：工厂是 async，返回对象若靠推断会把字面量放宽
// （worker.format 推成 string 而非 "es"），defineConfig 的重载就全部不匹配。
export default defineConfig(async (): Promise<UserConfig> => ({
  plugins: [
    vue(),
    vueCompilerPreseedPlugin(),
    runtimeAssetGuardPlugin(),
    runtimeBuildPlugin(),
    templateIndexPlugin(),
  ],

  // 应用显示版本（编译期常量，见 appDisplayVersion）
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },

  // 多页构建：index.html = 编辑器窗口（label "main"），home.html = 首页窗口（label "home"），
  // graph.html = 脚本图窗口（label "graph"），whiteboard.html = 白板窗口（全局单例 label "whiteboard"），
  // docs.html = 文档窗口（全局单例 label "docs"，壳内嵌 public/docs 静态文档站）
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        home: path.resolve(__dirname, "home.html"),
        graph: path.resolve(__dirname, "graph.html"),
        whiteboard: path.resolve(__dirname, "whiteboard.html"),
        docs: path.resolve(__dirname, "docs.html"),
        assistant: path.resolve(__dirname, "assistant.html"),
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
