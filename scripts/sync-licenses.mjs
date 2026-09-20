// ---------------------------------------------------------------------------
// 第三方依赖许可证副本同步 + 动态清单生成：
//   副本 = public/licenses/<id>/（LICENSE 等原文逐字节拷贝 + meta.json 元数据，入库）
//   清单 = src/generated/license-registry.ts（**扫描 public/licenses/ 生成**，
//          首页「偏好设置 → 关于」渲染；新增一个目录即自动出现在清单里）
//
// 覆盖范围：运行时/随产物分发的依赖（package.json dependencies + 引擎内置的
// vendor 资产 + 随 engine 分发但属传递依赖者，如 fflate）。纯构建期工具
// （vite/sass/vue-tsc/@types 等 devDependencies）不随产物分发，不在清单内。
//
// 上游未随附许可证正文的包（如 draco3dgltf、ammo.js、KTX-Software）如实登记
// 元数据与来源链接，并在 note 中说明——不臆造许可证正文。
//
// 用法：node scripts/sync-licenses.mjs（build 链第二步；dev 由 vite 插件调用）
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_ROOT = path.join(ROOT, "public", "licenses");
export const LICENSE_ROOT = "public/licenses";
export const REGISTRY_PATH = "src/generated/license-registry.ts";

/** 登记项：pkg = node_modules 包名；manual = 无 npm 包（引擎内置 vendor 资产）。
 *  name/homepage/note 为展示覆盖项；noLocalText 标明上游未随附许可证正文。 */
const ENTRIES = [
  // —— package.json dependencies（随应用/产物分发）——
  { pkg: "vue" },
  { pkg: "three" },
  { pkg: "monaco-editor", extraFiles: ["ThirdPartyNotices.txt"] },
  { pkg: "@vue-flow/core" },
  { pkg: "@vue-flow/background" },
  { pkg: "@vue-flow/controls" },
  { pkg: "@vue-flow/minimap" },
  { pkg: "@vue-flow/node-resizer" },
  { pkg: "@tauri-apps/api" },
  { pkg: "@tauri-apps/plugin-opener", note: "上游仅随附 SPDX 文档（LICENSE.spdx），未附许可证正文" },
  { pkg: "@dimforge/rapier3d-compat", note: "物理引擎构建随产物分发（public/engine/runtime/physics-engines/rapier.mjs）" },
  { pkg: "jolt-physics", note: "物理引擎构建随产物分发（public/engine/runtime/physics-engines/jolt.mjs）" },
  { pkg: "@gltf-transform/core" },
  { pkg: "@gltf-transform/extensions" },
  { pkg: "@gltf-transform/functions" },
  { pkg: "typescript" },
  { pkg: "draco3dgltf", noLocalText: true, note: "压缩 glTF 资产处理用；上游包未随附许可证正文，见上游仓库" },
  // —— 传递依赖但随 engine 分发 ——
  { pkg: "fflate", note: "随产物分发（public/engine/runtime/loaders/fflate.module.js）" },
  { pkg: "meshoptimizer", note: "随产物分发（public/engine/runtime/loaders/meshopt_decoder.module.js）" },
  // —— 引擎内置 vendor 资产（无 npm 包，来源见 src/runtime/extra/README.md）——
  {
    manual: true,
    id: "ammo",
    name: "ammo.js (Bullet Physics)",
    version: "—",
    license: "Zlib",
    homepage: "https://github.com/kripken/ammo.js",
    note: "物理引擎 ammo 后端随产物分发（public/engine/runtime/physics-engines/ammo/）；上游未随附许可证正文",
  },
  {
    manual: true,
    id: "ktx-software",
    name: "KTX-Software (basis_transcoder)",
    version: "—",
    license: "Apache-2.0",
    homepage: "https://github.com/KhronosGroup/KTX-Software",
    note: "KTX2 转码器随产物分发（public/engine/runtime/loaders/basis/），经 three examples/jsm/libs 拷贝；上游副本未随附许可证正文",
  },
  {
    manual: true,
    id: "draco",
    name: "Draco (draco_decoder)",
    version: "—",
    license: "Apache-2.0",
    homepage: "https://github.com/google/draco",
    note: "Draco 解码器随产物分发（public/engine/runtime/loaders/draco/），经 three examples/jsm/libs 拷贝；上游副本未随附许可证正文",
  },
];

/** 包 → 许可证/声明文件名（大小写不敏感，排除源文件） */
const LICENSE_FILE_RE = /^(licen[cs]e|copying|notice|thirdpartynotices)([_\-.]|$)/i;

/** 解析包目录：优先顶层符号链接（直接依赖），否则在 .pnpm 中找传递依赖。
 *  pnpm 的顶层入口是符号链接，fs.existsSync 会跟随，故可正常读取。 */
function resolvePkgDir(name) {
  const direct = path.join(ROOT, "node_modules", name);
  if (fs.existsSync(path.join(direct, "package.json"))) return direct;
  const base = name.startsWith("@") ? name.split("/")[1] : name;
  const pnpmDir = path.join(ROOT, "node_modules", ".pnpm");
  if (!fs.existsSync(pnpmDir)) return null;
  const candidates = fs
    .readdirSync(pnpmDir)
    .filter((d) => d.startsWith(`${base}@`))
    .sort()
    .reverse(); // 版本降序：多个版本时取最高（与实际使用一致）
  for (const d of candidates) {
    const p = path.join(pnpmDir, d, "node_modules", name);
    if (fs.existsSync(path.join(p, "package.json"))) return p;
  }
  return null;
}

function readLicenseField(pkg) {
  const lic = pkg.license;
  if (typeof lic === "string") return lic;
  if (lic && typeof lic === "object" && typeof lic.type === "string") return lic.type;
  if (Array.isArray(pkg.licenses) && pkg.licenses[0]?.type) return pkg.licenses[0].type;
  return "UNKNOWN";
}

/** 变更检测写入（内容一致不落盘；沿用 build-runtime 的做法） */
function writeIfChanged(file, content) {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  if (fs.existsSync(file) && fs.readFileSync(file).equals(buf)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return true;
}

/** 同步副本：把上游许可证文件拷进 public/licenses/<id>/，并写入 meta.json */
export function syncLicenses() {
  const written = [];
  const missing = [];
  for (const e of ENTRIES) {
    if (e.manual) {
      const id = e.id;
      const dir = path.join(OUT_ROOT, id);
      const meta = {
        id,
        name: e.name,
        version: e.version ?? "—",
        license: e.license ?? "UNKNOWN",
        homepage: e.homepage,
        note: e.note,
        source: "引擎内置 vendor 资产（见 src/runtime/extra/README.md）",
        generatedBy: "scripts/sync-licenses.mjs",
      };
      fs.mkdirSync(dir, { recursive: true });
      if (writeIfChanged(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n")) {
        written.push(`${id}/meta.json`);
      }
      missing.push(id);
      continue;
    }

    const pkgDir = resolvePkgDir(e.pkg);
    if (!pkgDir) {
      console.warn(`[sync-licenses] 未找到包 ${e.pkg}（已跳过）`);
      continue;
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const id = e.id ?? e.pkg.replace(/^@/, "").replace(/\//g, "-");
    const dir = path.join(OUT_ROOT, id);
    fs.mkdirSync(dir, { recursive: true });

    const names = fs
      .readdirSync(pkgDir, { withFileTypes: true })
      .filter((f) => f.isFile() && LICENSE_FILE_RE.test(f.name))
      .map((f) => f.name)
      .sort();
    for (const n of e.extraFiles ?? []) {
      if (fs.existsSync(path.join(pkgDir, n)) && !names.includes(n)) names.push(n);
    }
    for (const n of names) {
      if (writeIfChanged(path.join(dir, n), fs.readFileSync(path.join(pkgDir, n)))) {
        written.push(`${id}/${n}`);
      }
    }
    const meta = {
      id,
      name: e.name ?? pkg.name,
      version: pkg.version,
      license: e.license ?? readLicenseField(pkg),
      homepage:
        e.homepage ??
        (typeof pkg.homepage === "string" ? pkg.homepage : undefined) ??
        (typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url) ??
        undefined,
      note:
        e.note ??
        (names.length || !e.noLocalText ? undefined : "上游包未随附许可证正文，见上游仓库"),
      source: `${pkg.name}@${pkg.version}`,
      generatedBy: "scripts/sync-licenses.mjs",
    };
    if (writeIfChanged(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n")) {
      written.push(`${id}/meta.json`);
    }
    if (!names.length) missing.push(id);
  }
  if (written.length) console.log(`[sync-licenses] 已更新 ${written.length} 个文件 → ${LICENSE_ROOT}`);
  if (missing.length) {
    console.log(`[sync-licenses] ${missing.length} 项无许可证正文（仅登记元数据）：${missing.join("、")}`);
  }
  return written.length;
}

/** 扫描 public/licenses/ 生成清单 TS（目录即事实源：新增目录自动进入清单） */
export function generateLicenseRegistry() {
  const entries = [];
  if (fs.existsSync(OUT_ROOT)) {
    for (const d of fs.readdirSync(OUT_ROOT, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(OUT_ROOT, d.name);
      const metaPath = path.join(dir, "meta.json");
      if (!fs.existsSync(metaPath)) {
        console.warn(`[sync-licenses] ${d.name} 缺少 meta.json（已跳过）`);
        continue;
      }
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const files = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((f) => f.isFile() && f.name !== "meta.json")
        .map((f) => ({ name: f.name, path: `licenses/${d.name}/${f.name}` }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const { generatedBy: _generatedBy, ...pub } = meta; // 内部字段不进清单
      entries.push({ ...pub, files });
    }
  }
  entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const content =
    "// 由 scripts/sync-licenses.mjs 自动生成（vite 启动/构建与 pnpm build 时重建；\n" +
    "// 数据源为 public/licenses/**；请勿手动编辑）\n" +
    "export interface DependencyLicenseFile {\n" +
    "  /** 副本文件名（原始文件名） */\n" +
    "  name: string;\n" +
    "  /** 运行时可 fetch 的路径（public 下，站内绝对路径） */\n" +
    "  path: string;\n" +
    "}\n" +
    "export interface DependencyLicense {\n" +
    "  id: string;\n" +
    "  name: string;\n" +
    "  version: string;\n" +
    "  license: string;\n" +
    "  homepage?: string;\n" +
    "  note?: string;\n" +
    "  /** 出处（包名@版本 / vendor 说明） */\n" +
    "  source?: string;\n" +
    "  /** 随附的许可证/声明副本；为空表示上游未随附正文（见 note） */\n" +
    "  files: DependencyLicenseFile[];\n" +
    "}\n" +
    "export const DEPENDENCY_LICENSES: DependencyLicense[] = " +
    JSON.stringify(entries, null, 2) +
    ";\n";

  const target = path.join(ROOT, REGISTRY_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  console.log(`[sync-licenses] 清单已生成 ${entries.length} 项 → ${REGISTRY_PATH}`);
  return entries.length;
}

// 直接执行（node scripts/sync-licenses.mjs）时：同步副本 + 生成清单
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  syncLicenses();
  generateLicenseRegistry();
}
