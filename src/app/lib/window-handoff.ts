// 统一窗口交接：首页/远程命令打开编辑器或图窗口均经此入口。
// 双渠道保证可靠交付：
//  1) Rust 待交付状态（PendingProjects[label]）—— 冷启动时窗口 listen 未就绪，
//     事件广播会丢失，由窗口启动后主动 takePendingProject 拉取；
//  2) window:project-open 事件 —— 热启动（窗口已就绪）时直接到达。
// 接收方对重复交付幂等（编辑器短窗去重 / 图窗口整体切换），两渠道竞态无副作用。

import { emit } from "@tauri-apps/api/event";
import { api } from "../../lib/api";
import { isTauri } from "../../lib/tauri-env";

/** 窗口项目交接载荷（事件与待交付状态共用） */
export interface WindowProjectPayload {
  root: string;
  name: string;
  /** 场景?rel（编辑器窗口需要；图窗口 null = 自己解析主场景） */
  rel: string | null;
}

/** 统一窗口交接：写入后端待交付状态 + 显示窗口 + 广播事件。
 *  label = "main"（编辑器）/ "graph"（场景图）。 */
export async function handoffToWindow(
  label: string,
  root: string,
  name: string,
  rel: string | null = null,
): Promise<void> {
  if (!isTauri()) return;
  await api.showWindowWithProject(label, root, name, rel);
  await emit("window:project-open", { label, root, name, rel });
}