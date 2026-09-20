<script setup lang="ts">
/**
 * 发布/分享弹层：把产物发布成局域网站点，并给出二维码。
 *
 * 两种产物形态（调用方二选一）：
 * - 托管站点（传 build）：一组「相对路径 → 文本内容」整站覆盖写（白板放映页等文本产物）；
 * - 目录引用（传 dir）：直接共享一个外部目录，不复制文件，源目录一变访问者刷新即见
 *   （网页预览这类按需读盘、含二进制的产物）。
 *
 * 发布、更新、停用、删除与二维码展示都在这里统一处理——各处「共享」入口行为一致。
 * 已存在同来源共享时整个弹层切换成「已共享」形态：显示直链与二维码，
 * 主按钮变成「更新分享内容」，另给停用/重新启用入口。
 * 刻意不放删除：销毁共享属于管理动作，统一在首页「共享」分区的列表里做（带二次确认），
 * 弹层只负责发布与开关，避免在放映/分享动线上出现不可逆按钮。
 */
import { computed, onUnmounted, ref, watch } from "vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import LanQrCode from "./LanQrCode.vue";
import {
  addLanDirShare,
  findShareBySource,
  humanSize,
  lanShare,
  publishLanSite,
  refreshLanShare,
  setLanShareItemEnabled,
  shareLink,
} from "../../lib/lan-share";
import { toastErr, toastOk } from "../../lib/toast";
import { isTauri } from "../../../lib/tauri-env";
import "../../../styles/components/lan-share-dialog.scss";

const props = withDefaults(
  defineProps<{
    open: boolean;
    /** 产物类型（whiteboard / site / folder） */
    kind: string;
    /** 来源标识：同一来源再次发布即原地更新 */
    source: string;
    /** 默认标题（首次发布时预填） */
    defaultTitle: string;
    /** 托管站点模式：产物构建，返回「相对路径 → 文本内容」；标题/备注可参与产物内容 */
    build?: (opts: { title: string; note: string }) => Record<string, string>;
    /** 目录引用模式：要共享的目录（绝对路径），源目录变化即时可见 */
    dir?: string;
    /** 发布前准备（如先把当前场景打包进 dir）；抛错即中止发布 */
    prepare?: () => Promise<void>;
    /** 入口文件（默认 index.html） */
    entry?: string;
    /** 产物规模提示（如「3 个图层 · 1280×720」） */
    summary?: string;
    /** 没有可发布内容时禁用发布（白板空文档等） */
    disabled?: boolean;
  }>(),
  { entry: "index.html", summary: "", disabled: false },
);

const emit = defineEmits<{ close: [] }>();

const title = ref("");
const note = ref("");
const pending = ref(false);
/** 产物字节数（发布前预演一次构建，让用户知道要发多少内容） */
const size = ref(0);
const sizeError = ref("");

const existing = computed(() => findShareBySource(props.source));
const link = computed(() => (existing.value ? shareLink(lanShare.status, existing.value.id) : ""));
const busy = computed(() => pending.value || lanShare.busy);
/** 目录引用模式（传了 dir 即按引用共享，不走产物构建） */
const isDir = computed(() => !!props.dir);

/** 预演构建：拿到产物并算出体积（同时暴露构建错误，避免发布时才失败） */
function preview(): void {
  sizeError.value = "";
  // 目录引用不复制内容，没有体积可算（源目录变化即时可见）
  if (props.disabled || isDir.value) {
    size.value = 0;
    return;
  }
  if (!props.build) {
    size.value = 0;
    sizeError.value = "未提供分享内容";
    return;
  }
  try {
    const files = props.build({ title: title.value, note: note.value });
    size.value = Object.values(files).reduce((n, text) => n + text.length, 0);
    if (Object.keys(files).length === 0) {
      sizeError.value = "没有可分享的内容";
    }
  } catch (e) {
    size.value = 0;
    sizeError.value = String(e);
  }
}

// 标题/备注每敲一个字都会重建整份产物（白板要重新序列化整篇文档），而体积只是
// 参考信息：防抖到停手后再算，别让输入卡顿
let previewTimer: number | null = null;
function schedulePreview(): void {
  if (previewTimer != null) window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(preview, 300);
}

onUnmounted(() => {
  if (previewTimer != null) window.clearTimeout(previewTimer);
});

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    const found = findShareBySource(props.source);
    title.value = found?.title ?? props.defaultTitle;
    note.value = found?.note ?? "";
    try {
      await refreshLanShare();
    } catch (e) {
      toastErr(`读取共享状态失败：${e}`);
    }
    // 状态拉回来之后可能才发现已有同来源共享，标题按已有的覆盖一次
    const again = findShareBySource(props.source);
    if (again) {
      title.value = again.title;
      note.value = again.note;
    }
    preview();
  },
  { immediate: true },
);

watch([title, note], schedulePreview);

async function publish(): Promise<void> {
  // 发布前准备（如把当前场景打包成分享产物）：失败即中止
  pending.value = true;
  try {
    if (props.prepare) await props.prepare();
  } catch (e) {
    toastErr(`生成分享内容失败：${e}`);
    return;
  } finally {
    pending.value = false;
  }
  // 目录引用模式：登记目录、源目录变化即时可见（预览刷新后无需重新发布）
  if (isDir.value) {
    pending.value = true;
    try {
      await addLanDirShare({
        title: title.value.trim() || props.defaultTitle,
        note: note.value,
        dir: props.dir!,
        source: props.source,
        entry: props.entry,
        shareId: existing.value?.id ?? null,
      });
      toastOk(existing.value ? "分享内容已更新" : "已开始共享，扫码即可打开");
    } catch (e) {
      toastErr(`发布失败：${e}`);
    } finally {
      pending.value = false;
    }
    return;
  }
  if (!props.build) {
    toastErr("未提供分享内容");
    return;
  }
  let files: Record<string, string>;
  try {
    files = props.build({ title: title.value.trim() || props.defaultTitle, note: note.value });
  } catch (e) {
    toastErr(`生成分享内容失败：${e}`);
    return;
  }
  if (Object.keys(files).length === 0) {
    toastErr("没有可分享的内容");
    return;
  }
  pending.value = true;
  try {
    await publishLanSite({
      kind: props.kind,
      title: title.value.trim() || props.defaultTitle,
      note: note.value,
      source: props.source,
      entry: props.entry,
      files,
      shareId: existing.value?.id ?? null,
    });
    toastOk(existing.value ? "分享内容已更新" : "已开始共享，扫码即可打开");
  } catch (e) {
    toastErr(`发布失败：${e}`);
  } finally {
    pending.value = false;
  }
}

async function stopShare(): Promise<void> {
  const share = existing.value;
  if (!share) return;
  pending.value = true;
  try {
    await setLanShareItemEnabled(share.id, false);
    toastOk("已停止共享（内容保留，可再次启用）");
  } catch (e) {
    toastErr(`操作失败：${e}`);
  } finally {
    pending.value = false;
  }
}

async function openInBrowser(): Promise<void> {
  if (!link.value) return;
  try {
    if (isTauri()) await openUrl(link.value);
    else window.open(link.value, "_blank", "noopener");
  } catch (e) {
    toastErr(`打开失败：${e}`);
  }
}
</script>

<template>
  <Transition name="lan-dialog">
    <div v-if="open" class="lan-dialog-backdrop" @click.self="emit('close')">
      <div class="lan-dialog" role="dialog" aria-modal="true">
        <header class="lan-dialog-head">
          <span class="lan-dialog-title">{{ existing ? "共享中" : "分享到局域网" }}</span>
          <button class="lan-dialog-close" title="关闭" @click="emit('close')">✕</button>
        </header>

        <div class="lan-dialog-body">
          <div class="lan-dialog-form">
            <label class="lan-field">
              <span class="lan-field-label">标题</span>
              <input v-model="title" spellcheck="false" placeholder="显示在共享页与二维码卡片上" />
            </label>
            <label class="lan-field">
              <span class="lan-field-label">备注</span>
              <input v-model="note" spellcheck="false" placeholder="选填，只作说明" />
            </label>

            <div class="lan-dialog-summary">
              <span v-if="disabled">当前没有可分享的内容</span>
              <span v-else-if="isDir">按引用共享：不复制文件，服务端直接读取该目录</span>
              <span v-else-if="sizeError">{{ sizeError }}</span>
              <span v-else>
                将发布 {{ humanSize(size) }} 内容
                <template v-if="summary"> · {{ summary }}</template>
              </span>
            </div>

            <p class="lan-dialog-tip">
              {{
                isDir
                  ? "发布后局域网内设备可凭链接或二维码打开；点「更新分享内容」会重新生成该目录的产物并覆盖上一次。服务走明文 HTTP，请只在可信网络中使用。"
                  : "发布后局域网内设备可凭链接或二维码打开；再次点击「更新分享内容」会覆盖上一次的产物。服务走明文 HTTP，请只在可信网络中使用。"
              }}
            </p>

            <div class="lan-dialog-actions">
              <button
                class="lan-btn primary"
                :disabled="busy || disabled || !title.trim()"
                @click="publish"
              >
                {{ pending ? "发布中…" : existing ? "更新分享内容" : "开始共享" }}
              </button>
              <template v-if="existing">
                <button v-if="existing.enabled" class="lan-btn ghost" :disabled="busy" @click="stopShare">
                  停止共享
                </button>
                <button v-else class="lan-btn ghost" :disabled="busy" @click="publish">重新启用</button>
              </template>
            </div>
          </div>

          <div class="lan-dialog-qr">
            <template v-if="existing && existing.enabled && link">
              <LanQrCode :value="link" title="扫码打开" :caption="link" :size="164" :actions="false" />
              <button class="lan-btn ghost" @click="openInBrowser">在本机浏览器打开</button>
            </template>
            <div v-else-if="existing" class="lan-dialog-qr-empty">
              共享已停用，点「重新启用」后恢复访问
            </div>
            <div v-else class="lan-dialog-qr-empty">发布后这里会出现二维码</div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>
