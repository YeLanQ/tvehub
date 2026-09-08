<script setup lang="ts">
/**
 * 音源设置编辑区（通用）：同时服务音源节点（AudioNode 卡）与音源组件
 * （audioSource 组件卡，组件模式）——settings 为 AudioSourceSettings 形状，
 * runtimeId 为运行时寻址键（节点 id 或组件 id，AudioSystem 按 id 绑定）。
 * - 音源：音频资产下拉（内置 internal/… + 项目 assets/…，经导入/复制进项目）；
 * - 播放参数（自动播放/循环/音量/倍速）为节点数据（随场景保存）；
 * - 空间化：2D 全局 / 3D 位置音源（参考距离/最大距离/衰减）；
 * - 播放/暂停/停止为运行时控制（不落盘）。
 */
import { computed } from "vue";
import { getEditorStore } from "../../stores/editor";
import { getAssetsStore } from "../../stores/assets";
import type { AudioSourceSettings } from "../../../framework/audio";
import { isAudioAssetRel } from "../../../framework/audio";
import NumberField from "../NumberField.vue";

const props = defineProps<{ settings: AudioSourceSettings; runtimeId: string; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

const editorStore = getEditorStore();
const engine = editorStore.engine;
const assetsStore = getAssetsStore();

/** 音频资产候选（内置 + 项目；导入 mp3/wav 等后自动出现） */
const audioOptions = computed(() => {
  const internal: { rel: string; name: string }[] = [];
  const project: { rel: string; name: string }[] = [];
  for (const a of assetsStore.assets) {
    if (a.kind === "dir" || !isAudioAssetRel(a.path)) continue;
    if (a.path.startsWith("internal/")) internal.push({ rel: a.path, name: a.name });
    else project.push({ rel: a.path, name: a.name });
  }
  return { internal, project };
});

/** 运行时状态（绑定/就绪/播放中；随 audio:changed 的 rev 刷新） */
const runtime = computed(() => {
  void props.rev;
  return engine.audio.stateFor(props.runtimeId);
});

const stateText = computed(() => {
  const rt = runtime.value;
  if (!props.settings.source) return "未绑定音频";
  if (rt?.error) return rt.error;
  if (!rt) return "等待入图…";
  if (!rt.ready) return "音频加载中…";
  if (rt.playing) return "播放中";
  if (rt.paused) return "已暂停";
  return "就绪";
});

function onSourceChange(e: Event): void {
  emit("update", "Set Audio Source", (e.target as HTMLSelectElement).value);
}
function onSpatialChange(e: Event): void {
  emit("update", "Set Audio Spatial", (e.target as HTMLSelectElement).value === "3d" ? "3d" : "2d");
}
function onAutoplayChange(e: Event): void {
  emit("update", "Set Audio Autoplay", (e.target as HTMLInputElement).checked);
}
function onLoopChange(e: Event): void {
  emit("update", "Set Audio Loop", (e.target as HTMLInputElement).checked);
}
function onVolumeChange(v: number): void {
  emit("update", "Set Audio Volume", Math.max(0, Math.min(1, v)));
}
function onSpeedChange(v: number): void {
  emit("update", "Set Audio Speed", Math.max(0.1, Math.min(4, v)));
}
function onRefDistanceChange(v: number): void {
  emit("update", "Set Audio RefDistance", Math.max(0.01, v));
}
function onMaxDistanceChange(v: number): void {
  emit("update", "Set Audio MaxDistance", Math.max(0.01, v));
}
function onRolloffChange(v: number): void {
  emit("update", "Set Audio Rolloff", Math.max(0, v));
}

// —— 运行时控制（不落盘）——
function rtPlay(): void {
  engine.audio.play(props.runtimeId);
}
function rtPause(): void {
  engine.audio.pause(props.runtimeId);
}
function rtStop(): void {
  engine.audio.stop(props.runtimeId);
}
</script>

<template>
  <div class="audio-section" :data-rev="rev">
    <div class="field">
      <label>音频源</label>
      <select :value="settings.source" @change="onSourceChange($event)">
        <option value="">（未绑定）</option>
        <optgroup v-if="audioOptions.internal.length" label="内置音频">
          <option v-for="o in audioOptions.internal" :key="o.rel" :value="o.rel" :title="o.rel">
            {{ o.name }}
          </option>
        </optgroup>
        <optgroup label="项目音频">
          <option v-if="audioOptions.project.length === 0" value="" disabled>
            （项目内暂无音频，可在资产面板「导入」mp3/wav 等文件）
          </option>
          <option v-for="o in audioOptions.project" :key="o.rel" :value="o.rel" :title="o.rel">
            {{ o.name }}
          </option>
        </optgroup>
      </select>
    </div>

    <label class="audio-toggle" @click.stop>
      <input
        type="checkbox"
        :checked="settings.autoplay"
        :disabled="!settings.source"
        @change="onAutoplayChange($event)"
      />
      <span>自动播放</span>
    </label>
    <label class="audio-toggle" @click.stop>
      <input
        type="checkbox"
        :checked="settings.loop"
        :disabled="!settings.source"
        @change="onLoopChange($event)"
      />
      <span>循环</span>
    </label>

    <template v-if="settings.source">
      <div class="field">
        <label>音量</label>
        <NumberField
          :model-value="settings.volume"
          :step="0.05"
          :min="0"
          :max="1"
          @commit="onVolumeChange"
        />
      </div>
      <div class="field">
        <label>倍速</label>
        <NumberField
          :model-value="settings.speed"
          :step="0.05"
          :min="0.1"
          :max="4"
          title="播放倍速（0.1~4）"
          @commit="onSpeedChange"
        />
      </div>
      <div class="field">
        <label>空间化</label>
        <select :value="settings.spatial" @change="onSpatialChange($event)">
          <option value="2d">2D（全局）</option>
          <option value="3d">3D（位置音源）</option>
        </select>
      </div>

      <template v-if="settings.spatial === '3d'">
        <div class="field">
          <label>参考距离</label>
          <NumberField
            :model-value="settings.refDistance"
            :step="0.5"
            :min="0.01"
            title="该距离内保持全音量（世界单位）"
            @commit="onRefDistanceChange"
          />
        </div>
        <div class="field">
          <label>最大距离</label>
          <NumberField
            :model-value="settings.maxDistance"
            :step="1"
            :min="0.01"
            title="衰减范围（世界单位）"
            @commit="onMaxDistanceChange"
          />
        </div>
        <div class="field">
          <label>衰减系数</label>
          <NumberField
            :model-value="settings.rolloff"
            :step="0.1"
            :min="0"
            title="距离衰减速率（越大衰减越快）"
            @commit="onRolloffChange"
          />
        </div>
      </template>

      <!-- 运行时控制 + 状态显示（不落盘） -->
      <div class="audio-runtime">
        <div class="audio-btns">
          <button title="播放" @click="rtPlay">▶</button>
          <button title="暂停" @click="rtPause">⏸</button>
          <button title="停止" @click="rtStop">⏹</button>
        </div>
        <span class="audio-state mono">{{ stateText }}</span>
      </div>
      <div v-if="runtime?.error" class="hint error">{{ runtime.error }}（检查资产路径与格式）</div>
      <div class="hint">2D 全局播放；3D 按监听器（预览相机）距离衰减。首次播放需点击画布解锁声音。</div>
    </template>
  </div>
</template>

<style scoped>
.audio-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text, #ddd);
  cursor: pointer;
  padding: 2px 0;
}
.audio-runtime {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0 2px;
  border-top: 1px solid var(--border, #333);
  margin-top: 4px;
}
.audio-btns {
  display: inline-flex;
  gap: 4px;
  flex: none;
}
.audio-btns button {
  font-size: 11px;
  line-height: 1.2;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid var(--text-dim, #666);
  background: transparent;
  color: var(--text, #ddd);
  cursor: pointer;
}
.audio-btns button:hover {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
.audio-state {
  flex: 1 1 auto;
  min-width: 60px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-dim, #999);
}
.hint.error {
  color: #e06c5a;
}
</style>
