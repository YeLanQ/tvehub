// 导出/预览文件组装（唯一实现）：「读项目配置 → 拉渠道运行时 → 注入场景图 →
// 编译用户脚本 → 合并 files」。此前的四份复制实现（remoteCommands.buildPreviewFiles /
// WebPreviewPanel.buildExportFiles / GraphPreview.buildExportFiles / build-export
// web 分支）在此收敛，行为差异经 options 显式化——改一头漏一头的漂移到此为止。
import { api } from "../../../lib/api";
import { logStore } from "../../stores/log";
import { getScriptsStore } from "../../stores/scripts";
import { graphSidecarRel } from "../../../framework/graph";
import {
  fetchChannelRuntimeFiles,
  type RuntimeChannel,
} from "../web-preview-runtime";
import {
  compileProjectScripts,
  ensureEntryScript,
  loadProjectScripts,
} from "../script-compile";
import { getBuildChannel } from "./channels";

/** 编译期日志口径（四份历史实现的差异点之一）：
 *  - remoteCommands：记编译错误（不参与预览），外层 catch 静默；
 *  - WebPreviewPanel：记编译错误 + 外层跳过告警；
 *  - GraphPreview：全静默（logs: null）；
 *  - 构建导出：记编译错误（不参与构建）+ 外层跳过告警。 */
export interface CollectLogs {
  /** logStore 分类标签（"preview" / "build"） */
  tag: string;
  /** 编译错误文案后缀（"预览" / "构建"） */
  errorSuffix: "预览" | "构建";
  /** 脚本编译整体失败时是否记 warn（false = 静默跳过） */
  warnOnSkip: boolean;
}

/** 场景图注入来源：
 *  - sidecar：磁盘侧车（graph/<sceneRel>.graph，编辑器主面板/远程命令）；
 *  - inline：会话文档直出（图窗口的 stampedExportDoc，不走磁盘）。 */
export type CollectGraph =
  | { kind: "sidecar"; sceneRel: string }
  | { kind: "inline"; text: string };

export interface CollectOptions {
  root: string;
  channel: RuntimeChannel;
  /**
   * - preview：config.json 落入 files（前端直读盘供 player 取），图注入时同步
   *   改写 cfg.scriptGraph 标记；
   * - export：config.json 不进 files（Rust 直读磁盘），图注入靠后端检测标记。
   */
  mode: "preview" | "export";
  /** export 模式的主场景（图侧车按它定位）；preview 模式用 graph.sceneRel */
  mainScene?: string;
  /** 场景图来源；缺省不注入（构建导出按 mainScene 侧车注入） */
  graph?: CollectGraph;
  /** 组装前保存编辑器脏脚本（remoteCommands 语义；预览面板/图窗口自行管理落盘） */
  saveDirtyScripts?: boolean;
  /** 编译期日志口径；null = 全静默（图窗口） */
  logs?: CollectLogs | null;
}

/** 读取项目配置原文（缺失返回 null——调用方按未启用可选运行时处理） */
export async function readProjectConfigText(root: string): Promise<string | null> {
  try {
    return await api.readText(root, "project.config.json");
  } catch {
    return null;
  }
}

/** 组装渠道运行时与用户脚本编译产物（四胞胎的唯一实现，见模块头注释） */
export async function collectExportFiles(opts: CollectOptions): Promise<Record<string, string>> {
  const adapter = getBuildChannel(opts.channel);
  const configText = await readProjectConfigText(opts.root);
  const files = await fetchChannelRuntimeFiles(opts.channel, adapter.runtimeOptions(configText));

  if (opts.mode === "preview") {
    // 预览产物带 config.json（player 直取）；导出模式由 Rust 直读磁盘不进 files
    files["config.json"] = configText ?? "{}";
  }

  await injectSceneGraph(opts, files);

  // 用户脚本：全量编译（src/**.ts → src/**.js）随产物注入；单个失败跳过
  if (opts.saveDirtyScripts) {
    try {
      await getScriptsStore().saveAll();
    } catch {
      /* 脚本保存失败按磁盘内容导出 */
    }
  }
  const logs = opts.logs ?? null;
  try {
    await ensureEntryScript(opts.root);
    const scripts = await loadProjectScripts(opts.root);
    if (scripts.length) {
      const { files: jsFiles, errors } = await compileProjectScripts(scripts, adapter.compileTarget);
      Object.assign(files, jsFiles);
      if (logs) {
        for (const [rel, err] of Object.entries(errors)) {
          logStore.log("error", `脚本编译失败 ${rel}: ${err}（该脚本不参与${logs.errorSuffix}）`, logs.tag);
        }
      }
    }
  } catch (e) {
    if (logs?.warnOnSkip) logStore.log("warn", `脚本编译跳过: ${e}`, logs.tag);
  }
  return files;
}

/** 场景图注入：script-graph.json 进 files；preview 模式同时把 config 的
 *  scriptGraph 标记改写为 "./script-graph.json"（player 检测到即装配行为解释器；
 *  export 模式由 Rust 管线检测 files 键后写入产物 config——同一语义，两段实现）。 */
async function injectSceneGraph(opts: CollectOptions, files: Record<string, string>): Promise<void> {
  let graphText: string | null = null;
  try {
    if (opts.graph?.kind === "inline") {
      graphText = opts.graph.text;
    } else if (opts.graph?.kind === "sidecar") {
      const text = await api.readText(opts.root, graphSidecarRel(opts.graph.sceneRel));
      if (text.trim()) graphText = text;
    } else if (opts.mode === "export" && opts.mainScene) {
      // 导出缺省：按主场景侧车注入（历史 build-export 行为）
      const text = await api.readText(opts.root, graphSidecarRel(opts.mainScene));
      if (text.trim()) graphText = text;
    }
  } catch {
    /* 无图文件按无图构建处理 */
  }
  if (graphText == null) return;
  files["script-graph.json"] = graphText;
  if (opts.mode === "preview") {
    let cfg: Record<string, unknown> = {};
    try {
      cfg = JSON.parse(files["config.json"] ?? "{}") as Record<string, unknown>;
    } catch {
      cfg = {};
    }
    cfg.scriptGraph = "./script-graph.json";
    files["config.json"] = JSON.stringify(cfg, null, 2);
  }
}
