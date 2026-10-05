// 兼容门面：构建导出实现已分层迁至 ./build/*（渠道注册表 channels / 选项单源
// options / 文件收集 collect / 持久化 prefs / web 模板 web-artifacts / 编排 run）。
// 历史消费者（BuildPanel / Toolbar / remoteCommands / 预览面板）的 import 路径
// 不变；新代码请直接从 ./build 导入。
export type {
  BuildChannelId,
  BuildOptions,
  PackedScene,
} from "./build";
export type { BuildPrefs } from "./build";
export {
  BUILD_CHANNELS,
  BUILD_CONFIG_REL,
  loadBuildPrefs,
  saveBuildPrefs,
  getBuildChannel,
  BUILTIN_EXPORT_TEMPLATES,
  defaultExportTemplateId,
  fetchExportTemplateHtml,
  loadExportTemplates,
  resolveExportTemplate,
  openBuildDir,
  runBuild,
} from "./build";
export type { BuildChannel, ExportTemplateInfo } from "./build";
export type { BuildResult } from "../../lib/api";
