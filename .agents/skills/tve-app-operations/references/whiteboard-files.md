# 单元：白板 —— 文件管理 / 放映 / 共享发布

## 操作面：文件管理

| 动作 | 入口 | 行为 |
|---|---|---|
| 新建 | 首页「新建白板」或窗口内新建 | `newDocument()` 重置空白文档（保留画板尺寸），默认名「未命名.svg」 |
| 打开 | 首页列表 / `showWhiteboardWindow(name)` | `whiteboardRead` → parseSvg；解析失败保持原文档并提示 |
| 保存 | **仅手动** Ctrl+S / 保存按钮（脏标记圆点） | 保存名校验 → .svg 自动补全 → **防同名覆盖** → 写盘 + 元数据刷新 |
| 重命名 | 标题栏名称输入框改后保存 | "改名后保存即重命名"：写新文件 + 删旧文件 + 元数据迁移 |
| 删除 | **仅首页分区** | 确认框 → `whiteboardDelete` + 元数据移除 |

**保存名校验**（invalidSaveNameReason，whiteboardStore.ts:43）：仅字母数字/汉字/
空格/`._-`，拒绝路径分隔与 `..`（Rust 端 sanitize 同规则）。

**防同名覆盖**：`whiteboardListFiles` 列目录做**大小写不敏感**比较，同名拒绝保存
（"已存在同名白板"）；仅大小写不同的改名沿用磁盘原名避免写新删旧（:452）。

**元数据**（tags/archived/createdAt/updatedAt）：存全局 ui-state KV 键
`tve:whiteboard:meta`，跨窗口广播同步；首页列表支持搜索/标签筛选/归档开关。

**存储位置**：全局白板目录（不随项目）——便携版 = exe 同级 `data/whiteboard/`，
dev = `%APPDATA%/TvE.Hub/whiteboard/`。

## 操作面：放映（画布内模式，非独立窗口）

- **一页 = 一个可见图层**（slideDeck）；入口：画布左下 WhiteboardSlideBar
  ▶/■、上一页/下一页（页码循环）。
- 切换动画：左右平移 / 上下平移 / 渐入渐出 / 层叠（520ms）；模式 自动/手动
  （自动间隔 1–60s）；`slideStart` 从当前活动图层起播。
- 快捷键：`← → PageUp PageDown` 翻页、`Esc` 退出；放映中图层面板选层 = 跳页。

## 操作面：共享发布（LanShare 集成）

- 标题栏「共享」→ LanShareDialog(kind=whiteboard) → `buildBoardSite` 打成自包含
  站点发布到局域网托管：`index.html`（SVG 内联放映页，无外部请求）+ `board.svg`
  （可再导入编辑）+ `board.json`（放映元信息）。
- 同一文件再分享 = **原地更新**（source = `whiteboard:<文件名>`）；打开页停在
  作者当前页（boardStartPage）；「下载源文件」入口由共享配置 allowDownload 决定。
- 首页「共享」分区可查看/启停/删除发布条目、看访问统计。

## 测试例

- 保存校验/防同名是**纯逻辑 + 单例状态**：`invalidSaveNameReason` 可直接按
  pattern-logic.md 补 spec（正常/含路径分隔/`..`/空值四类）；防同名需
  whiteboardListFiles——无 spec，推荐抽"大小写不敏感比较"纯函数先测。
- 放映页构建 `buildBoardSite`（site.ts）为纯组装，往返：board.svg 再导入可编辑
  ——与 svg-doc 往返测试同口径。
- IPC 契约：`tve-api-usage` facade-windows.md；浏览器直开空值安全范例
  DocsWindowApp.spec.ts。
