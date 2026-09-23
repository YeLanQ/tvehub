// 可加载资料索引：官方文档与工坊原型的精简目录常驻系统提示词，全文经
// load_doc / load_repo 按需注入。没有这份索引，弱模型想读文档只能空参
// 试探（load_doc {}）靠报错回喂目录自纠——每任务白烧 1-2 轮；有索引则
// 首调即中。工坊目录运行时拉取（repos 动态层），外部更新自动反映。

import { api } from "../lib/api";

export interface LoadableCatalogs {
  docs: { id: string; title: string; summary: string }[];
  repos: { id: string; title: string; summary: string }[];
}

export const EMPTY_CATALOGS: LoadableCatalogs = { docs: [], repos: [] };

/** 索引行摘要截断（目录只做路由，全文按需拉） */
const SUMMARY_LIMIT = 42;
/** 目录缓存有效期：避免每次发送都打两发 IPC；repos 动态层读路径自带
 * 懒刷新，TTL 过期后下一次发送即反映外部更新 */
const CACHE_TTL_MS = 10_000;

let cache: Promise<LoadableCatalogs> | null = null;
let cacheAt = 0;

/** 拉取两份目录（IPC 轻量；失败回落空目录——索引缺失只退化为无目录，
 * 不阻塞发送）。带 TTL 缓存；send 前先 await 它，挂载时预warm。 */
export function fetchLoadableCatalogs(): Promise<LoadableCatalogs> {
  if (!cache || Date.now() - cacheAt > CACHE_TTL_MS) {
    cache = Promise.all([api.docsList().catch(() => []), api.reposDocList().catch(() => [])]).then(
      ([docs, repos]) => {
        cacheAt = Date.now();
        return { docs, repos };
      },
    );
  }
  return cache;
}

function briefLine(id: string, title: string, summary: string): string {
  const desc = summary.replace(/\s+/g, " ").trim();
  return `- ${id}：${title}${desc && desc !== title ? ` — ${desc.slice(0, SUMMARY_LIMIT)}` : ""}`;
}

/** 系统提示词里的可加载资料段（两份目录任一为空则省略对应小节） */
export function loadableIndexPrompt(c: LoadableCatalogs): string {
  const parts: string[] = [
    "## 可加载资料索引",
    "读全文前先在这里拿 id，带 id 调用——空参调用会被拒绝浪费一轮。只读与当前步骤相关的条目。",
  ];
  if (c.docs.length) {
    parts.push(
      "### 官方文档（load_doc，id 即文档路径）",
      ...c.docs.map((d) => briefLine(d.id, d.title, d.summary)),
    );
  }
  if (c.repos.length) {
    parts.push(
      "### 工坊原型（load_repo；创意工坊资源库，随工坊更新自动同步）",
      "写脚本/效果时优先参考这里的现成原型——先 load_repo 读全文再动手，不要凭名字猜内容。",
      ...c.repos.map((d) => briefLine(d.id, d.title, d.summary)),
    );
  }
  return parts.join("\n");
}
