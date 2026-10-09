// 渠道注册表（唯一渠道清单）：渠道描述、可选运行时开关映射、编译 target、
// 导出期工件注入与 IPC 载荷收敛。编排层（run.ts）零渠道 if——渠道差异全部
// 在 adapter 内。新增渠道 = 此处一个 adapter + manifest.mjs 一个扫描函数 +
// Rust 工厂一处注册（三层各一处，互不强求）。
import type { BuildExportArgs } from "../../../lib/api";
import {
  configPhysicsBackend,
  configUsesDracoCompression,
  configUsesPhysics,
  configUsesTextureCompression,
  configUsesWebgpu,
  type ChannelRuntimeOptions,
} from "../web-preview-runtime";
import type { BuildChannelId, BuildOptions } from "./options";
import { applyWebExportArtifacts } from "./web-artifacts";

/** 渠道导出期工件注入：渠道独有的 files 加工（web = 导出模板注入入口页；
 *  wechat = 无）。返回 IPC 的 singlePage 实际取值。 */
export type ApplyExportArtifacts = (
  opts: BuildOptions,
  files: Record<string, string>,
) => Promise<{ singlePage: boolean }>;

/** 构建渠道描述与渠道行为（BUILD_CHANNELS 的元素类型） */
export interface BuildChannel {
  id: BuildChannelId;
  label: string;
  desc: string;
  supported: boolean;
  /** 按项目配置判定可选运行时开关（体积大的运行时按需随产物） */
  runtimeOptions(configText: string | null): ChannelRuntimeOptions;
  /** 用户脚本编译 target（缺省 web ESM；wechat = CJS + 包内小写归一） */
  compileTarget?: "wechat";
  /** 渠道导出期工件注入 */
  applyExportArtifacts: ApplyExportArtifacts;
  /** IPC 载荷收敛：applies=false 的选项按 defaults 进载荷（渠道不适用） */
  ipc: {
    applies: { title: boolean; singlePage: boolean; gzip: boolean; cdn: boolean };
    defaults: { title: string; singlePage: boolean; gzip: boolean; cdn: boolean; gzipBase: string; cdnBase: string };
  };
  /** 渠道专属 IPC 字段（微信 appid/方向；web 无） */
  extraIpc(opts: BuildOptions): Partial<BuildExportArgs>;
}

const NO_IPC_DEFAULTS = {
  title: "",
  singlePage: false,
  gzip: false,
  cdn: false,
  gzipBase: "",
  cdnBase: "",
};

/** web 渠道：全量选项用户可控（singlePage 由模板解析在 applyExportArtifacts 内定） */
const WEB_CHANNEL: BuildChannel = {
  id: "web",
  label: "Web",
  desc: "打包为可部署的静态网页（player 运行时 + 场景 + 资产）",
  supported: true,
  runtimeOptions: (configText) => ({
    includePhysics: configUsesPhysics(configText),
    physicsBackend: configPhysicsBackend(configText) ?? undefined,
    // 渲染后端为 WebGPU/自动时必须随产物带上 WebGPU 运行时（three.webgpu 构建
    // 等），漏带会让播放器静默回退 WebGL
    includeWebgpu: configUsesWebgpu(configText),
    includeDracoDecoder: configUsesDracoCompression(configText),
    includeBasisDecoder: configUsesTextureCompression(configText),
  }),
  applyExportArtifacts: applyWebExportArtifacts,
  ipc: {
    applies: { title: true, singlePage: true, gzip: true, cdn: true },
    defaults: NO_IPC_DEFAULTS,
  },
  extraIpc: () => ({}),
};

/** 微信渠道：形态/地址类选项不适用（数据全内联），按 defaults 收敛 */
const WECHAT_CHANNEL: BuildChannel = {
  id: "wechat",
  label: "微信小游戏",
  desc: "打包为微信小游戏工程（预构建运行时 + 数据全内联，导入开发者工具运行）",
  supported: true,
  runtimeOptions: (configText) => ({
    // 物理引擎按后端随包（rapier/jolt/ammo CJS 预转换产物；真机 wasm 由桥接层
    // 垫片经 WXWebAssembly 实例化）
    includePhysics: configUsesPhysics(configText),
    physicsBackend: configPhysicsBackend(configText),
    // Draco 纯 JS 解码器按项目配置随包（与 web 同判据；微信为懒加载的内联解码形态）
    includeDracoDecoder: configUsesDracoCompression(configText),
  }),
  compileTarget: "wechat",
  applyExportArtifacts: async () => ({ singlePage: false }),
  ipc: {
    applies: { title: false, singlePage: false, gzip: false, cdn: false },
    defaults: NO_IPC_DEFAULTS,
  },
  extraIpc: (opts) => ({
    wechatAppid: opts.wechatAppId || undefined,
    wechatOrientation: opts.wechatOrientation ?? "portrait",
    wechatSubpackages: opts.wechatSubpackages === true,
    wechatSubpackageSize:
      typeof opts.wechatSubpackageSize === "number" && Number.isFinite(opts.wechatSubpackageSize)
        ? Math.min(4, Math.max(1, Math.round(opts.wechatSubpackageSize)))
        : 2,
    wechatDiag: opts.wechatDiag === true,
  }),
};

export const BUILD_CHANNELS: BuildChannel[] = [WEB_CHANNEL, WECHAT_CHANNEL];

/** 取渠道 adapter（未知渠道抛错；前端渠道 union 单源于 BuildChannelId） */
export function getBuildChannel(id: BuildChannelId): BuildChannel {
  const hit = BUILD_CHANNELS.find((c) => c.id === id);
  if (!hit) throw new Error(`未知构建渠道: ${id}`);
  return hit;
}

/** 从 BuildOptions + 渠道 adapter 组装 build_export IPC 载荷 */
export function buildIpcArgs(
  opts: BuildOptions,
  files: Record<string, string>,
  singlePage: boolean,
): BuildExportArgs {
  const { applies, defaults } = getBuildChannel(opts.channel).ipc;
  return {
    root: opts.root,
    channel: opts.channel,
    scenes: opts.scenes,
    mainScene: opts.mainScene,
    title: applies.title ? opts.title : defaults.title,
    debug: opts.debug,
    singlePage: applies.singlePage ? singlePage : defaults.singlePage,
    gzip: applies.gzip ? opts.gzip : defaults.gzip,
    release: opts.release,
    cdn: applies.cdn ? opts.cdn : defaults.cdn,
    gzipBase: applies.gzip ? opts.gzipBase : defaults.gzipBase,
    cdnBase: applies.cdn ? opts.cdnBase : defaults.cdnBase,
    files,
    outDir: opts.outDir,
    ...getBuildChannel(opts.channel).extraIpc(opts),
  };
}
