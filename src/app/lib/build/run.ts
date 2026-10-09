// 构建编排（公共流程，渠道差异在 channels.ts adapter 内收敛）：
// 保存当前场景/脏脚本 → collectExportFiles（渠道运行时 + 脚本编译 + 图注入）→
// 渠道工件注入（web 模板）→ buildIpcArgs（载荷收敛）→ api.buildExport → 统一结果日志。
import { openPath } from "@tauri-apps/plugin-opener";
import { api, type BuildResult } from "../../../lib/api";
import { logStore } from "../../stores/log";
import { getScriptsStore } from "../../stores/scripts";
import { saveCurrentSceneToMain } from "../save-scene";
import { buildIpcArgs, getBuildChannel } from "./channels";
import { collectExportFiles } from "./collect";
import type { BuildOptions } from "./options";

/** 执行构建：产物内容与编辑器一致（构建前把当前场景与脏脚本落盘，后端按磁盘
 *  内容读取/编译）→ 渠道运行时 + 用户脚本 + 场景图 + 渠道工件 → Rust 打包落盘 */
export async function runBuild(opts: BuildOptions): Promise<BuildResult> {
  // 产物内容与编辑器一致：构建前把当前编辑场景落盘（后端按磁盘内容读取）
  try {
    await saveCurrentSceneToMain();
  } catch (e) {
    logStore.log("warn", `构建前保存场景失败（按磁盘内容构建）: ${e}`, "build");
  }
  // 脚本同理：编辑中的脏脚本先落盘（编译按磁盘内容读取）
  await getScriptsStore().saveAll();

  const channel = getBuildChannel(opts.channel);
  const files = await collectExportFiles({
    root: opts.root,
    channel: opts.channel,
    mode: "export",
    mainScene: opts.mainScene,
    scenes: opts.scenes,
    logs: { tag: "build", errorSuffix: "构建", warnOnSkip: true },
    wechatWorker: opts.wechatWorker === true,
  });
  // 渠道导出期工件（web = 导出模板入口页；返回 IPC 的 singlePage 实际取值）
  const { singlePage } = await channel.applyExportArtifacts(opts, files);

  const result = await api.buildExport(buildIpcArgs(opts, files, singlePage));
  logBuildResult(result);
  return result;
}

/** 统一结果日志（原 web/wechat 两分支逐字重复的收尾） */
function logBuildResult(result: BuildResult): void {
  logStore.log("success", `构建完成: ${result.output_dir}`, "build");
  if (result.missing.length) {
    logStore.log(
      "warn",
      `构建缺失 ${result.missing.length} 项资产（已跳过）: ${result.missing.join(", ")}`,
      "build",
    );
  }
}

/** 在系统文件管理器中打开构建输出目录 */
export async function openBuildDir(outputDir: string): Promise<void> {
  try {
    await openPath(outputDir);
  } catch (e) {
    logStore.log("error", `打开构建目录失败: ${e}`, "build");
  }
}
