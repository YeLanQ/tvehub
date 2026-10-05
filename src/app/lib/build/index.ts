// 构建导出域入口：渠道注册表 / 选项单源 / 文件收集 / 持久化 / 模板 / 编排。
// 历史 import 路径 src/app/lib/build-export 保留为兼容门面。
export type {
  BuildChannelId,
  BuildOptions,
  PackedScene,
} from "./options";
export type { BuildPrefs } from "./prefs";
export { BUILD_CONFIG_REL, loadBuildPrefs, saveBuildPrefs } from "./prefs";
export {
  BUILD_CHANNELS,
  getBuildChannel,
  buildIpcArgs,
  type BuildChannel,
} from "./channels";
export {
  BUILTIN_EXPORT_TEMPLATES,
  defaultExportTemplateId,
  fetchExportTemplateHtml,
  loadExportTemplates,
  resolveExportTemplate,
  type ExportTemplateInfo,
} from "./web-artifacts";
export { collectExportFiles, readProjectConfigText, type CollectOptions } from "./collect";
export { openBuildDir, runBuild } from "./run";
