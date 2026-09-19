// ---------------------------------------------------------------------------
// 白板元数据（全局，不随项目）：标签 / 归档 / 创建与更新时间。
// 存全局 ui-state KV（后端落盘 + 跨窗口广播），首页分区与白板窗口共用本模块；
// 变更经 onWhiteboardMetaChange 广播，两端据此刷新时间轴。
// ---------------------------------------------------------------------------

import { onUiStateChange, uiStateGet, uiStateSet } from "../lib/ui-state";

export interface WhiteboardMetaEntry {
  /** 首次创建时间（ms） */
  createdAt: number;
  /** 最近保存时间（ms） */
  updatedAt: number;
  tags: string[];
  archived: boolean;
}

export type WhiteboardMetaIndex = Record<string, WhiteboardMetaEntry>;

const KEY = "tve:whiteboard:meta";

export function emptyWhiteboardMeta(now = Date.now()): WhiteboardMetaEntry {
  return { createdAt: now, updatedAt: now, tags: [], archived: false };
}

/** 读取整份元数据索引（键不存在/后端不可用返回空对象） */
export async function loadWhiteboardMeta(): Promise<WhiteboardMetaIndex> {
  return (await uiStateGet<WhiteboardMetaIndex>(KEY)) ?? {};
}

async function saveWhiteboardMeta(index: WhiteboardMetaIndex): Promise<void> {
  await uiStateSet(KEY, index);
}

/** 确保某白板的元数据存在（缺失时以当前时间登记 createdAt/updatedAt） */
export async function ensureWhiteboardMeta(name: string): Promise<WhiteboardMetaEntry> {
  const index = await loadWhiteboardMeta();
  if (index[name]) return index[name];
  const entry = emptyWhiteboardMeta();
  index[name] = entry;
  await saveWhiteboardMeta(index);
  return entry;
}

/** 合并写入某白板的元数据（读取-修改-写回；createdAt 缺省补当前时间） */
export async function patchWhiteboardMeta(
  name: string,
  patch: Partial<Omit<WhiteboardMetaEntry, "createdAt" | "updatedAt">> & {
    createdAt?: number;
    updatedAt?: number;
  },
): Promise<WhiteboardMetaEntry> {
  const index = await loadWhiteboardMeta();
  const prev = index[name] ?? emptyWhiteboardMeta();
  const entry: WhiteboardMetaEntry = {
    createdAt: patch.createdAt ?? prev.createdAt,
    updatedAt: patch.updatedAt ?? prev.updatedAt,
    tags: patch.tags ?? prev.tags,
    archived: patch.archived ?? prev.archived,
  };
  index[name] = entry;
  await saveWhiteboardMeta(index);
  return entry;
}

/** 保存完成后的时间戳维护：确保登记存在并刷新 updatedAt */
export async function bumpWhiteboardMeta(name: string): Promise<void> {
  await patchWhiteboardMeta(name, { updatedAt: Date.now() });
}

/** 删除某白板的元数据条目（文件删除后调用） */
export async function removeWhiteboardMeta(name: string): Promise<void> {
  const index = await loadWhiteboardMeta();
  if (!index[name]) return;
  delete index[name];
  await saveWhiteboardMeta(index);
}

/** 订阅元数据变更（含本窗口写入的回执，消费方按整体刷新处理） */
export async function onWhiteboardMetaChange(
  fn: (index: WhiteboardMetaIndex) => void,
): Promise<() => void> {
  return onUiStateChange<WhiteboardMetaIndex>(KEY, (v) => fn(v ?? {}));
}
