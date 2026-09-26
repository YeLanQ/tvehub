<script setup lang="ts">
/**
 * 数据化网格卡（MeshNode.source=data）：
 * - 导入外部数据文件（.json 显式网格 / .xyz .csv 规则格点）→ 载荷内嵌节点；
 * - 已导入态展示来源/顶点数/三角形数/包围盒；可清除回基元；
 * - 载荷签名门控重建几何（SceneSynchronizer），材质沿用 Mesh 卡的 .mat 引用。
 */
import { ref, computed } from "vue";
import { logStore } from "../../stores/log";
import type { MeshNode } from "../../../framework/prototype/derived/Primitives";
import { importMeshDataFile, meshDataBounds } from "../../../framework/mesh";

const props = defineProps<{ node: MeshNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

const importing = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

/** 节点非响应式：以 rev 为失效信号重算包围盒（一次导入只算一次） */
const bounds = computed(() => {
  void props.rev;
  const d = props.node.dataMesh;
  return d ? meshDataBounds(d) : null;
});
const triCount = computed(() => {
  void props.rev;
  return ((props.node.dataMesh?.indexCount ?? 0) / 3) | 0;
});

function onPick(): void {
  fileInput.value?.click();
}

async function onFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || importing.value) return;
  importing.value = true;
  try {
    const dot = file.name.lastIndexOf(".");
    const ext = dot >= 0 ? file.name.slice(dot) : "";
    const payload = importMeshDataFile(file.name, ext, await file.text());
    emit("update", "Import Mesh Data", payload);
    logStore.log(
      "success",
      `已导入数据网格: ${file.name}（${payload.vertexCount} 顶点 / ${(payload.indexCount / 3) | 0} 三角形）`,
    );
  } catch (err) {
    logStore.log("error", `导入数据网格失败: ${err}`);
  } finally {
    importing.value = false;
  }
}

function onClear(): void {
  emit("update", "Clear Mesh Data", null);
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : "0";
}
</script>

<template>
  <div class="dm-section" :data-rev="rev">
    <template v-if="props.node.dataMesh">
      <div class="field">
        <label title="源数据文件">Source</label>
        <span class="dm-val" :title="props.node.dataMesh.sourceName">
          {{ props.node.dataMesh.sourceName || "（未命名）" }}
        </span>
      </div>
      <div class="field">
        <label>Format</label>
        <span class="dm-val">{{ props.node.dataMesh.format.toUpperCase() }}</span>
      </div>
      <div class="field">
        <label title="顶点数 / 三角形数">Mesh</label>
        <span class="dm-val">{{ props.node.dataMesh.vertexCount }} 顶点 / {{ triCount }} 三角形</span>
      </div>
      <div class="field">
        <label title="原始数据包围盒（导入后可用变换缩放适配场景）">Bounds</label>
        <span v-if="bounds" class="dm-val">
          {{ fmt(bounds.min[0]) }}…{{ fmt(bounds.max[0]) }} ×
          {{ fmt(bounds.min[1]) }}…{{ fmt(bounds.max[1]) }} ×
          {{ fmt(bounds.min[2]) }}…{{ fmt(bounds.max[2]) }}
        </span>
        <span v-else class="dm-val">（数据损坏）</span>
      </div>
      <div class="dm-actions">
        <button :disabled="importing" title="重新导入数据文件（.json / .xyz / .csv）" @click="onPick">重新导入</button>
        <button :disabled="importing" title="清除数据载荷，回退基元几何" @click="onClear">清除数据</button>
      </div>
      <div class="hint">几何由数据生成；材质/变换与普通网格一致。</div>
    </template>
    <template v-else>
      <div class="dm-actions">
        <button :disabled="importing" title="从数据文件生成网格：.json（positions/indices/normals/uvs 数组）或 .xyz/.csv（规则格点，x 最快变化）" @click="onPick">
          导入数据网格
        </button>
      </div>
      <div class="hint">未导入数据（当前渲染基元占位）。支持 .json 显式网格与 .xyz/.csv 规则格点。</div>
    </template>
    <input ref="fileInput" type="file" accept=".json,.xyz,.csv,.txt" style="display: none" @change="onFile" />
  </div>
</template>

<style scoped>
.dm-section .field {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}
.dm-section label {
  flex: none;
  width: 52px;
  font-size: 11px;
  color: var(--text-dim, #999);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-val {
  min-width: 0;
  font-size: 11px;
  color: var(--text, #ddd);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0 4px;
}
.dm-actions button {
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
.dm-actions button:hover:not(:disabled) {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
.dm-actions button:disabled {
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
