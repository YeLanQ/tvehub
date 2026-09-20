<script setup lang="ts">
/**
 * 二维码卡片：把一个地址画成手机可扫的二维码，并给出可复制的文本。
 *
 * - 编码在渲染层用自带实现（app/lib/lan-share/qr），无第三方依赖；
 * - SVG 由自研编码器生成（内容只包含矩阵与固定配色，不含外部输入），故用 v-html 注入；
 * - 二维码本体的墨色/纸色是扫码契约、不随主题；卡片外壳配色走 ui-kit 主题（见 lan-qr.scss）；
 * - 内容过长（超版本 40 容量，约 2.9KB）时降级为纯文本提示，不抛到组件外。
 */
import { computed, ref } from "vue";
import { encodeQr, qrSvg } from "../../lib/lan-share";
import { toastOk, toastErr } from "../../lib/toast";
import "../../../styles/components/lan-qr.scss";

const props = withDefaults(
  defineProps<{
    /** 要编码的地址 */
    value: string;
    /** 卡片标题（默认「扫码打开」） */
    title?: string;
    /** 展示的地址文本（默认与 value 相同） */
    caption?: string;
    /** 二维码目标边长（px，默认 168）：实际渲染尺寸向下取整到整数模块边长 */
    size?: number;
    /** 是否显示复制/下载操作 */
    actions?: boolean;
  }>(),
  { title: "扫码打开", caption: "", size: 168, actions: true },
);

const copied = ref(false);

/**
 * 二维码与它的显示边长。
 *
 * 关键：显示尺寸必须等于「模块边长 × 整数」，否则浏览器会把 5px 的模块重采样到
 * 4.5px 之类的非整数尺寸，模块边缘出现半像素缝，实测会影响识别率。因此这里先按
 * 目标边长取整算出模块边长，再反推显示尺寸（尺寸只作近似目标，不保证等于传值）。
 */
const rendered = computed<{ svg: string; px: number } | null>(() => {
  if (!props.value) return null;
  try {
    const matrix = encodeQr(props.value, { ecc: "M" });
    const quiet = 4;
    const scale = Math.max(2, Math.floor(props.size / (matrix.size + quiet * 2)));
    // 墨色/纸色不在这里指定：它们由 qr/render.ts 的 QR_INK / QR_PAPER 统一决定
    // （扫码识别契约，不随主题），卡片外壳的配色才是主题的事（见 lan-qr.scss）
    return {
      svg: qrSvg(matrix, { scale, quiet }),
      px: (matrix.size + quiet * 2) * scale,
    };
  } catch {
    return null;
  }
});

const svg = computed(() => rendered.value?.svg ?? null);

const text = computed(() => props.caption || props.value);

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
    toastOk("链接已复制");
  } catch {
    toastErr("复制失败：剪贴板不可用");
  }
}

/** 下载二维码 SVG（贴到文档/打印用；不带业务状态） */
function download(): void {
  const markup = svg.value;
  if (!markup) return;
  const blob = new Blob([markup], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "二维码.svg";
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="lan-qr">
    <div class="lan-qr-head">{{ title }}</div>
    <div
      v-if="rendered"
      class="lan-qr-code"
      :style="{ width: `${rendered.px}px`, height: `${rendered.px}px` }"
      v-html="rendered.svg"
    ></div>
    <div v-else class="lan-qr-too-long">地址过长，无法生成二维码，请直接复制链接</div>
    <code class="lan-qr-text" :title="text">{{ text }}</code>
    <div v-if="actions" class="lan-qr-actions">
      <button class="lan-btn" :disabled="!value" @click="copy">{{ copied ? "已复制" : "复制链接" }}</button>
      <button class="lan-btn ghost" :disabled="!svg" @click="download">下载二维码</button>
    </div>
  </div>
</template>
