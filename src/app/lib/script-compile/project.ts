// ---------------------------------------------------------------------------
// 项目脚本侧职责（预览 / 构建导出前调用）：
// - loadProjectScripts：扫描项目 src/ 下的全部脚本源文件；
// - ensureEntryScript：入口脚本自愈补建（配置声明了 entryScript 但磁盘缺失时
//   按内置模板补建）；
// - compileProjectScripts：逐个调用 compile.ts 的 compileScript，产物以
//   { "src/x.js": jsText } 汇总（单个失败跳过并记录，不阻断导出）。
// 依赖 compile.ts / paths.ts，以及项目 IO 侧模块（api / logStore / 内置模板）。
// ---------------------------------------------------------------------------

import { api } from "../../../lib/api";
import { logStore } from "../../stores/log";
import { loadAssetTemplate } from "../asset-templates";
import { scriptClassNameFromStem } from "../script-prototypes";
import { compileScript, type CompiledScript } from "./compile";
import { scriptJsPath } from "./paths";

// ---------------------------------------------------------------------------
// 项目脚本收集与全量编译（预览 / 构建导出前调用）
// ---------------------------------------------------------------------------

export interface ProjectScript {
  /** 源路径（src/**.ts） */
  rel: string;
  source: string;
}

/** 是否为用户脚本源文件（src/ 下的 .ts；tve.d.ts 等声明文件排除） */
export function isScriptSource(rel: string): boolean {
  return (
    rel.startsWith("src/") &&
    (rel.endsWith(".ts") || rel.endsWith(".tsx")) &&
    !rel.endsWith(".d.ts")
  );
}

/**
 * 入口脚本自愈补建：项目配置声明了 entryScript 但磁盘上没有该文件
 * （早期模板创建的项目、手工删除等）时，按内置脚本模板补建——否则预览/构建
 * 会因入口模块 404 报「[脚本] 加载失败 src/main.ts」。
 * @returns 是否补建了文件（无入口声明/已存在/补建失败均为 false）
 */
export async function ensureEntryScript(root: string): Promise<boolean> {
  let entry = "";
  try {
    const configText = await api.readText(root, "project.config.json");
    const parsed = configText ? (JSON.parse(configText) as { entryScript?: unknown }) : null;
    entry = typeof parsed?.entryScript === "string" ? parsed.entryScript.trim() : "";
  } catch {
    return false; // 无配置/解析失败按无入口脚本处理
  }
  if (!entry || !isScriptSource(entry)) return false;
  try {
    if ((await api.readText(root, entry)) != null) return false; // 已存在
  } catch {
    /* 不存在 → 补建 */
  }
  // 类名 = 文件名 PascalCase（模板 {{CLASS_NAME}} 注入），与新建脚本同一规则
  const base = entry.slice(entry.lastIndexOf("/") + 1).replace(/\.tsx?$/, "");
  const className = scriptClassNameFromStem(base, "Main");
  const content = await loadAssetTemplate("script", { CLASS_NAME: className });
  if (!content) return false;
  try {
    await api.writeText(root, entry, content);
    logStore.log("info", `入口脚本 ${entry} 缺失，已按内置模板补建`, "script");
    return true;
  } catch (e) {
    logStore.log("warn", `入口脚本 ${entry} 补建失败: ${e}`, "script");
    return false;
  }
}

/** 读取项目全部脚本源文件（相互独立，并行读取） */
export async function loadProjectScripts(root: string): Promise<ProjectScript[]> {
  const entries = await api.scanAssets(root);
  const rels = entries.map((e) => e.path).filter(isScriptSource);
  const sources = await Promise.all(
    rels.map(async (rel) => {
      try {
        return await api.readText(root, rel);
      } catch (e) {
        logStore.log("error", `读取脚本失败 ${rel}: ${e}`, "script");
        return null;
      }
    }),
  );
  const out: ProjectScript[] = [];
  for (let i = 0; i < rels.length; i++) {
    const source = sources[i];
    if (source != null) out.push({ rel: rels[i], source });
  }
  return out;
}

export interface ProjectScriptsCompileResult {
  /** 编译产物（key = src/**.js，随导出 files 传给后端） */
  files: Record<string, string>;
  /** 失败清单（rel → 错误信息） */
  errors: Record<string, string>;
}

/** 编译结果缓存（key = rel + 源码全文；源码未变即直接复用上次的编译产物，
 *  预览面板刷新/连续构建不再重复做全量 TS 转译）。 */
const compileCache = new Map<string, CompiledScript>();

/** 全量编译项目脚本（单个失败跳过并记录，不阻断导出） */
export async function compileProjectScripts(
  scripts: ProjectScript[],
): Promise<ProjectScriptsCompileResult> {
  const files: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const s of scripts) {
    const key = `${s.rel}\u0000${s.source}`;
    let cached = compileCache.get(key);
    if (!cached) {
      cached = await compileScript(s.source, s.rel);
      compileCache.set(key, cached);
    }
    if (cached.error || !cached.js) {
      errors[s.rel] = cached.error ?? "空产物";
      continue;
    }
    files[scriptJsPath(s.rel)] = cached.js;
  }
  return { files, errors };
}
