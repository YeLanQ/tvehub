// ---------------------------------------------------------------------------
// 局域网共享的响应式状态与动作（全局单例）：
// 首页「共享」分区与白板窗口的分享弹层读同一份状态，一侧改动另一侧即时可见
// （两个窗口是独立 webview，无法共享内存，故各自持有单例；跨窗口同步靠每次动作后
// 重新拉取状态，而不是事件——共享状态变化本来就只由用户操作触发）。
//
// 约定：所有写操作都返回后端的完整状态快照并整体覆盖本地状态，避免前后端两份
// 状态各自演化；错误以异常抛出，由调用方决定怎么提示（组件里 toast）。
// ---------------------------------------------------------------------------
import { reactive } from "vue";
import { api } from "../../../lib/api";
import type {
  LanAddDirRequest,
  LanPublishSiteRequest,
  LanShareConfigPatch,
  LanShareEntry,
  LanShareStatus,
} from "../../../lib/api";

interface LanShareState {
  /** 后端状态快照（null = 尚未载入） */
  status: LanShareStatus | null;
  /** 是否正在与后端交互（按钮禁用与加载态） */
  busy: boolean;
  /** 最近一次失败信息（组件展示；成功时清空） */
  error: string | null;
}

const state = reactive<LanShareState>({
  status: null,
  busy: false,
  error: null,
});

/** 全局单例状态（只读靠约定：改动一律走下面的动作函数，不要直接改字段） */
export const lanShare = state;

function apply(next: LanShareStatus): LanShareStatus {
  state.status = next;
  state.error = null;
  return next;
}

/** 统一的执行壳：置忙 → 调用 → 覆盖状态；异常记 error 后继续抛出 */
async function run(fn: () => Promise<LanShareStatus>): Promise<LanShareStatus> {
  state.busy = true;
  try {
    return apply(await fn());
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    state.busy = false;
  }
}

/** 拉取状态（幂等；首次进入分区或分享弹层时调用） */
export async function refreshLanShare(): Promise<LanShareStatus> {
  return run(() => api.lanShareStatus());
}

/** 改配置（补丁式） */
export async function patchLanShareConfig(patch: LanShareConfigPatch): Promise<LanShareStatus> {
  return run(() => api.lanShareSetConfig(patch));
}

/** 开服 / 停服（开关走这个） */
export async function setLanShareEnabled(enabled: boolean): Promise<LanShareStatus> {
  return run(() => (enabled ? api.lanShareStart() : api.lanShareStop()));
}

/** 发布托管站点（白板放映页 / 网页产物） */
export async function publishLanSite(req: LanPublishSiteRequest): Promise<LanShareStatus> {
  return run(() => api.lanSharePublishSite(req));
}

/** 按引用共享外部目录 */
export async function addLanDirShare(req: LanAddDirRequest): Promise<LanShareStatus> {
  return run(() => api.lanShareAddDir(req));
}

/** 启停单条共享 */
export async function setLanShareItemEnabled(id: string, enabled: boolean): Promise<LanShareStatus> {
  return run(() => api.lanShareSetEnabled(id, enabled));
}

/** 删除共享 */
export async function removeLanShare(id: string): Promise<LanShareStatus> {
  return run(() => api.lanShareRemove(id));
}

// --- 读侧选择器（组件模板里直接调用，避免各组件各写一份 find） ------------------

/** 共享列表（按更新时间倒序；后端已保证顺序，这里只做空态兜底） */
export function lanShares(): LanShareEntry[] {
  return state.status?.shares ?? [];
}

/** 按来源标识找共享（白板「是否已共享」判断用） */
export function findShareBySource(source: string): LanShareEntry | null {
  return lanShares().find((s) => s.source === source) ?? null;
}

/** 按 id 找共享 */
export function findShare(id: string): LanShareEntry | null {
  return lanShares().find((s) => s.id === id) ?? null;
}
