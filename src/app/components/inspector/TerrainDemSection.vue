<script setup lang="ts">
/**
 * 数字地形数据源卡（TerrainNode.dem）：
 * - 导入外部地形数据文件（.asc/.hgt/.pgm/.xyz/.csv，覆盖 DEM/DTM/DSM/DLG 常见导出）；
 *   解析为归一化高度网格内嵌节点（自包含，预览/导出不需要源文件）；
 * - 已导入态展示来源/网格/高程范围；可清除回退程序化生成；
 * - 垂直夸张沿用 Heightfield 的 Height Scale（归一化高度 × 该值）。
 */
import { ref } from "vue";
import { logStore } from "../../stores/log";
import type { TerrainNode } from "../../../framework/prototype/derived/Primitives";
import { DEM_TYPE_LABELS, importDemFile } from "../../../framework/terrain";

const props = defineProps<{ node: TerrainNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

const importing = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

function onPick(): void {
  fileInput.value?.click();
}

/** 读文件 → 解析 → 一次撤销写入节点 dem 字段（失败提示不写） */
async function onFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || importing.value) return;
  importing.value = true;
  try {
    const dot = file.name.lastIndexOf(".");
    const ext = dot >= 0 ? file.name.slice(dot) : "";
    const isText = ext === ".asc" || ext === ".txt" || ext === ".xyz" || ext === ".csv";
    // 先按扩展名读出内容，再走 importDemFile 单一入口（懒回调只取其一）
    const text = isText ? await file.text() : "";
    const buf = isText ? new ArrayBuffer(0) : await file.arrayBuffer();
    const dem = importDemFile(
      file.name,
      ext,
      () => text,
      () => buf,
    );
    emit("update", "Import DEM Data", dem);
    logStore.log(
      "success",
      `已导入地形数据: ${file.name}（${DEM_TYPE_LABELS[dem.format]}，${dem.sourceCols}×${dem.sourceRows}）`,
    );
  } catch (err) {
    logStore.log("error", `导入地形数据失败: ${err}`);
  } finally {
    importing.value = false;
  }
}

function onClear(): void {
  emit("update", "Clear DEM Data", null);
}
</script>

<template>
  <div class="dem-section" :data-rev="rev">
    <template v-if="props.node.dem">
      <div class="field">
        <label title="源数据格式（DEM/DTM/DSM/DLG 等高程数据的常见导出格式）">Source</label>
        <span class="dem-val" :title="props.node.dem.sourceName">
          {{ props.node.dem.sourceName || "（未命名）" }}
        </span>
      </div>
      <div class="field">
        <label>Format</label>
        <span class="dem-val">{{ DEM_TYPE_LABELS[props.node.dem.format] }}</span>
      </div>
      <div class="field">
        <label title="源文件网格列×行">Grid</label>
        <span class="dem-val">{{ props.node.dem.sourceCols }} × {{ props.node.dem.sourceRows }}</span>
      </div>
      <div class="field">
        <label title="源数据高程范围（原始单位；已归一化存储，Height Scale 为垂直夸张）">Elevation</label>
        <span class="dem-val">{{ props.node.dem.sourceMin.toFixed(1) }} … {{ props.node.dem.sourceMax.toFixed(1) }}</span>
      </div>
      <div class="ts-actions">
        <button :disabled="importing" title="重新导入外部地形数据文件（.asc/.hgt/.pgm/.xyz/.csv）" @click="onPick">
          重新导入
        </button>
        <button :disabled="importing" title="清除数据源，回退程序化地形" @click="onClear">清除数据源</button>
      </div>
      <div class="hint">高度 = 数据归一化 × Height Scale（Heightfield 区）。</div>
    </template>
    <template v-else>
      <div class="ts-actions">
        <button :disabled="importing" title="从外部地形数据文件生成地形：.asc（Esri ASCII Grid）/ .hgt（SRTM）/ .pgm（16位灰度高程）/ .xyz .csv（高程点/点云）" @click="onPick">
          导入地形数据
        </button>
      </div>
      <div class="hint">支持 DEM / DTM / DSM / DLG 高程数据的常见导出格式；导入后替代程序化分形作为地形基准（雕刻层仍可叠加）。</div>
    </template>
    <input
      ref="fileInput"
      type="file"
      accept=".asc,.hgt,.pgm,.xyz,.csv,.txt"
      style="display: none"
      @change="onFile"
    />
  </div>
</template>

<style scoped>
.dem-section .field {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}
.dem-section label {
  flex: none;
  width: 64px;
  font-size: 11px;
  color: var(--text-dim, #999);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dem-val {
  min-width: 0;
  font-size: 11px;
  color: var(--text, #ddd);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ts-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0 4px;
}
.ts-actions button {
  flex: none;
  font-size: 11px;
  line-height: 1.2;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid var(--text-dim, #666);
  background: transparent;
  color: var(--text, #ddd);
  cursor: pointer;
}
.ts-actions button:hover:not(:disabled) {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
.ts-actions button:disabled {
  opacity: 0.45;
  cursor: default;
}
.hint {
  padding: 2px 0 4px;
  font-size: 10px;
  line-height: 1.5;
  color: var(--text-dim, #888);
}
</style>
