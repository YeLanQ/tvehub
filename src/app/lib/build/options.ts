// 构建选项单一事实源：面板状态（BuildPanel refs）、持久化（prefs.ts →
// build.config.json）、编排入参（run.ts runBuild）共用同一份字段定义；IPC 载荷
// （api.BuildExportArgs）由 run.ts 从这里 + 渠道 adapter 组装。
// 渠道不适用的选项不删字段（保持 UI/持久化结构稳定），由渠道 adapter
// （channels.ts 的 ipc.applies/defaults）决定进入 IPC 载荷的形态。

/** 构建渠道 id（与 Rust BuildJob.channel / manifest.mjs 清单 id 同一口径） */
export type BuildChannelId = "web" | "wechat";

/** 产物内单场景条目（与 Rust BuildResult.scenes 对应） */
export interface PackedScene {
  name: string;
  rel: string;
  file: string;
}

/** 构建选项（runBuild 入参；面板与持久化共用的字段口径） */
export interface BuildOptions {
  root: string;
  channel: BuildChannelId;
  /** 选中的构建场景（项目相对路径） */
  scenes: string[];
  /** 主场景（必须在 scenes 内） */
  mainScene: string;
  /** 页面标题（web 渠道） */
  title: string;
  /** 调试模式：保留运行日志转发 */
  debug: boolean;
  /** 导出模板 id 列表（web 渠道；首个生成 index.html，其余生成 index-<模板>.html；
   *  多文件与单页模板不能混选） */
  templates: string[];
  /** 资产 gzip 归档（多文件写 assets.gzip；单页 base64 内联） */
  gzip: boolean;
  /** 发布模式：资源 uid 重命名 + 引用重写 + JSON 压缩 */
  release: boolean;
  /** CDN 模式：three.js 运行时不内嵌，从 Three CDN 地址在线加载 */
  cdn: boolean;
  /** gzip 资源地址（assets.gzip 归档远程基址；空 = 本地读取） */
  gzipBase: string;
  /** Three CDN 地址（three.js 远程基址，CDN 模式下生效；空 = 内嵌 three.js） */
  cdnBase: string;
  /** 产物落盘目录（项目相对路径；缺省 build/<渠道>/，如局域网共享用 .tmp/share） */
  outDir?: string;
  /** 微信小游戏 AppID（可选；空 = 继承上次产物 > touristappid 游客模式） */
  wechatAppId?: string;
  /** 微信小游戏屏幕方向（wechat 渠道；缺省 portrait） */
  wechatOrientation?: "portrait" | "landscape";
  /** 微信小游戏分包：文件化二进制资产移出主包，启动前预加载（主包 4MB 限制的解法） */
  wechatSubpackages?: boolean;
  /** 单个分包体积上限（MB，1~4，缺省 2；超限单资产独占分包） */
  wechatSubpackageSize?: number;
  /** 微信真机诊断弹窗（真机定时弹窗读数排障用；勾选写入设备 storage 开关，
   *  不勾选启动即清除——正常游玩请保持关闭） */
  wechatDiag?: boolean;
}
