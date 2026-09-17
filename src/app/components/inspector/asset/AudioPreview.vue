<script setup lang="ts">
// ---------------------------------------------------------------------------
// 音频资产预览块（展示型，从 AssetInspector 抽出）：自定义播放器 + 绑定说明。
// 样式参考 Uixder AudioNode 迷你播放器（圆形播放按钮 + 进度条 + 时间）。
// 无状态无交互上抛；是否音频资产由父组件按 isAudioAssetRel 判定后再渲染本组件。
// ---------------------------------------------------------------------------
import { ref, computed, watch } from "vue";
import { assetUrl } from "../../../../lib/asset-url";

const props = defineProps<{
  /** 资产相对路径（asset:// 取数） */
  rel: string;
}>();

const audioEl = ref<HTMLAudioElement | null>(null);
const playing = ref(false);
const cur = ref(0);
const dur = ref(0);

const src = computed(() => assetUrl(props.rel));
const progress = computed(() => (dur.value > 0 ? (cur.value / dur.value) * 100 : 0));

function fmt(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
}

function toggle(): void {
  const a = audioEl.value;
  if (!a) return;
  if (playing.value) a.pause();
  else a.play().catch(() => undefined);
}

function seek(e: MouseEvent): void {
  const a = audioEl.value;
  const bar = e.currentTarget as HTMLElement;
  if (!a || !dur.value) return;
  const r = bar.getBoundingClientRect();
  a.currentTime = ((e.clientX - r.left) / r.width) * dur.value;
}

function onTime(): void { cur.value = audioEl.value?.currentTime ?? 0; }
function onMeta(): void { dur.value = audioEl.value?.duration ?? 0; }
function onEnded(): void { playing.value = false; cur.value = 0; }

watch(src, () => { playing.value = false; cur.value = 0; dur.value = 0; });
</script>

<template>
  <div class="audio-player">
    <button class="audio-play" :title="playing ? '暂停' : '播放'" @click="toggle">
      <svg v-if="!playing" viewBox="0 0 12 12" width="12" height="12">
        <path d="M2 1.5L10 6L2 10.5Z" fill="currentColor" />
      </svg>
      <svg v-else viewBox="0 0 12 12" width="12" height="12">
        <rect x="2" y="1.5" width="3" height="9" fill="currentColor" />
        <rect x="7" y="1.5" width="3" height="9" fill="currentColor" />
      </svg>
    </button>
    <span class="audio-time">{{ fmt(cur) }} / {{ fmt(dur) }}</span>
    <div class="audio-bar" @click="seek">
      <div class="audio-bar-fill" :style="{ width: progress + '%' }"></div>
    </div>
  </div>
  <audio
    ref="audioEl"
    preload="metadata"
    :src="src"
    @timeupdate="onTime"
    @loadedmetadata="onMeta"
    @ended="onEnded"
    @play="playing = true"
    @pause="playing = false"
  />
  <div class="hint">音频资产：添加「Audio Source」音源节点后在此绑定播放；2D 全局 / 3D 位置衰减。</div>
</template>

<style scoped>
.audio-player {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  padding: 8px;
  margin-bottom: 2px;
}

.audio-play {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--bg-panel-2);
  color: var(--text);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
  transition: border-color 0.12s;
}

.audio-play:hover {
  border-color: var(--accent);
}

.audio-time {
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.audio-bar {
  flex: 1;
  height: 4px;
  background: var(--bg-active);
  border-radius: 2px;
  cursor: pointer;
  min-width: 40px;
}

.audio-bar:hover {
  background: var(--btn-hover);
}

.audio-bar-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
}
</style>
