<script setup lang="ts">
/**
 * 地形节点卡（程序化地形设置）：
 * - Terrain Asset：绑定项目 .terrain 资产（绑定时快照资产设置到节点）/ 解绑 /
 *   保存当前设置回资产（资产侧由后端 terrain_write 落盘并补 .meta）；
 * - Heightfield：seed（可随机）/ 尺寸 / 网格密度 / 起伏 / 频率 / 分形层数 /
 *   频率步进 / 振幅步进 / 导数阻尼 / 域扭曲 / 谷地压平 / 海平面 / 热侵蚀；
 * - Surface：草地/岩石/积雪三色（按海拔/坡度烘焙成顶点色）。
 * 事件统一 emit("update", label, value)，label 即撤销历史文案；
 * 改任何高度场参数都会按签名重建几何（segments 越大越慢）。
 */
import { computed, ref } from "vue";
import { getProjectStore } from "../../stores/project";
import { getAssetsStore } from "../../stores/assets";
import { logStore } from "../../stores/log";
import { api } from "../../../lib/api";
import { isInternalAsset } from "../../../lib/internal-assets";
import type { TerrainNode } from "../../../framework/prototype/derived/Primitives";
import {
  TERRAIN_LIMITS,
  isTerrainAssetRel,
} from "../../../framework/terrain";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: TerrainNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

const projectStore = getProjectStore();
const assetsStore = getAssetsStore();
const L = TERRAIN_LIMITS;

/** 节点是普通类实例（非响应式）：以 rev 为失效信号读取设置 */
const s = computed(() => {
  void props.rev;
  return props.node.terrain;
});

/** 项目内 .terrain 资产（内置只读资源不可作为绑定目标） */
const terrainAssets = computed(() =>
  assetsStore.assets.filter(
    (a) => a.kind === "terrain" && !isInternalAsset(a.path) && a.path.startsWith("assets/"),
  ),
);

/** 当前绑定是否不在候选里（资产被删/移走时仍回显路径，不静默丢失） */
const assetListed = computed(() => {
  const cur = props.node.asset;
  if (!cur) return true;
  return terrainAssets.value.some((a) => a.path === cur);
});

const binding = ref(false);
/** 选择资产 → 读取其设置 → 绑定（快照设置到节点，一次撤销） */
async function onBindAsset(rel: string): Promise<void> {
  if (!rel) {
    emit("update", "Bind Terrain Asset", { rel: "", settings: null });
    return;
  }
  const root = projectStore.currentPath;
  if (!root || binding.value) return;
  binding.value = true;
  try {
    const text = await api.readText(root, rel);
    const doc = JSON.parse(text) as { settings?: unknown };
    emit("update", "Bind Terrain Asset", { rel, settings: doc.settings ?? null });
  } catch {
    logStore.log("error", `读取地形资产失败: ${rel}`);
  } finally {
    binding.value = false;
  }
}

/** 把当前设置写回绑定的 .terrain 资产（后端序列化 + 补 .meta） */
const saving = ref(false);
async function onSaveToAsset(): Promise<void> {
  const root = projectStore.currentPath;
  const rel = props.node.asset;
  if (!root || !rel || saving.value) return;
  saving.value = true;
  try {
    await api.terrainWrite(root, rel, stemOf(rel), { ...props.node.terrain });
    logStore.log("success", `已保存地形设置到: ${rel}`);
  } catch (e) {
    logStore.log("error", `保存地形资产失败: ${e}`);
  } finally {
    saving.value = false;
  }
}

function stemOf(rel: string): string {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  return base.endsWith(".terrain") ? base.slice(0, -".terrain".length) : base;
}

function numToHex(v: number): string {
  return "#" + (v & 0xffffff).toString(16).padStart(6, "0");
}
function hexToNum(hex: string): number {
  return parseInt(hex.replace("#", ""), 16) & 0xffffff;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function onColor(label: string, e: Event): void {
  emit("update", label, hexToNum((e.target as HTMLInputElement).value));
}
</script>

<template>
  <div class="terrain-section" :data-rev="rev">
    <!-- ===== Terrain Asset ===== -->
    <div class="ts-group">Terrain Asset</div>
    <div class="field">
      <label title="绑定 .terrain 地形资产；绑定时把资产设置快照到节点（此后互不影响，可再保存回去）">
        Asset
      </label>
      <select
        :value="props.node.asset"
        :disabled="binding"
        @change="onBindAsset(($event.target as HTMLSelectElement).value)"
      >
        <option value="">（未绑定）</option>
        <option v-if="!assetListed" :value="props.node.asset" :title="props.node.asset">
          {{ stemOf(props.node.asset) }}（未找到）
        </option>
        <option v-for="a in terrainAssets" :key="a.path" :value="a.path" :title="a.path">
          {{ a.name }}
        </option>
      </select>
    </div>
    <div class="ts-actions">
      <button
        :disabled="!props.node.asset || !isTerrainAssetRel(props.node.asset) || saving"
        title="把当前节点设置写回绑定的 .terrain 资产"
        @click="onSaveToAsset"
      >
        保存到资产
      </button>
      <span v-if="!props.node.asset" class="hint">未绑定资产（可在资产面板右键「新建地形」）</span>
    </div>

    <!-- ===== Heightfield ===== -->
    <div class="ts-group">Heightfield</div>
    <div class="field">
      <label title="Seed：随机种子。同种子恒定生成同一片地形">Seed</label>
      <div class="ts-seed">
        <NumberField
          :model-value="s.seed"
          :step="1"
          :min="L.seed.min"
          :max="L.seed.max"
          title="随机种子"
          @commit="(v) => emit('update', 'Set Seed', clamp(Math.round(v), L.seed.min, L.seed.max))"
        />
        <button
          title="随机换一个种子"
          @click="emit('update', 'Set Seed', clamp(Math.floor(Math.random() * 999999) + 1, L.seed.min, L.seed.max))"
        >
          ⚄
        </button>
      </div>
    </div>
    <div class="field">
      <label title="Size：地表边长（世界单位，正方形）">Size</label>
      <NumberField
        :model-value="s.size"
        :step="10"
        :min="L.size.min"
        :max="L.size.max"
        title="地表边长（世界单位）"
        @commit="(v) => emit('update', 'Set Size', clamp(v, L.size.min, L.size.max))"
      />
    </div>
    <div class="field">
      <label title="Segments：每边网格数（顶点数 = (N+1)²）。越大越细腻，重建越慢">Segments</label>
      <NumberField
        :model-value="s.segments"
        :step="16"
        :min="L.segments.min"
        :max="L.segments.max"
        title="每边网格数"
        @commit="(v) => emit('update', 'Set Segments', clamp(Math.round(v), L.segments.min, L.segments.max))"
      />
    </div>
    <div class="field">
      <label title="Height Scale：谷底到峰顶的高度（世界单位）">Height Scale</label>
      <NumberField
        :model-value="s.heightScale"
        :step="1"
        :min="L.heightScale.min"
        :max="L.heightScale.max"
        title="起伏幅度（世界单位）"
        @commit="(v) => emit('update', 'Set Height Scale', clamp(v, L.heightScale.min, L.heightScale.max))"
      />
    </div>
    <div class="field">
      <label title="Frequency：基础噪声频率（一座山的占地尺度，越小山越大）">Frequency</label>
      <NumberField
        :model-value="s.frequency"
        :step="0.001"
        :min="L.frequency.min"
        :max="L.frequency.max"
        title="基础噪声频率"
        @commit="(v) => emit('update', 'Set Frequency', clamp(v, L.frequency.min, L.frequency.max))"
      />
    </div>
    <div class="field">
      <label title="Octaves：分形叠加层数（细节层级数）">Octaves</label>
      <NumberField
        :model-value="s.octaves"
        :step="1"
        :min="L.octaves.min"
        :max="L.octaves.max"
        title="分形层数"
        @commit="(v) => emit('update', 'Set Octaves', clamp(Math.round(v), L.octaves.min, L.octaves.max))"
      />
    </div>
    <div class="field">
      <label title="Lacunarity：每层频率步进（略偏离 2 避免网格锁相）">Lacunarity</label>
      <NumberField
        :model-value="s.lacunarity"
        :step="0.05"
        :min="L.lacunarity.min"
        :max="L.lacunarity.max"
        title="每层频率步进"
        @commit="(v) => emit('update', 'Set Lacunarity', clamp(v, L.lacunarity.min, L.lacunarity.max))"
      />
    </div>
    <div class="field">
      <label title="Gain：每层振幅步进（持久度，越大细节越多）">Gain</label>
      <NumberField
        :model-value="s.gain"
        :step="0.05"
        :min="L.gain.min"
        :max="L.gain.max"
        title="每层振幅步进"
        @commit="(v) => emit('update', 'Set Gain', clamp(v, L.gain.min, L.gain.max))"
      />
    </div>
    <div class="field">
      <label title="Erosion：导数阻尼强度。越大谷地越平、山脊越锐（fake erosion）">Erosion</label>
      <NumberField
        :model-value="s.erosion"
        :step="0.05"
        :min="L.erosion.min"
        :max="L.erosion.max"
        title="导数阻尼强度"
        @commit="(v) => emit('update', 'Set Erosion', clamp(v, L.erosion.min, L.erosion.max))"
      />
    </div>
    <div class="field">
      <label title="Warp：域扭曲强度。山脊/谷地蜿蜒程度">Warp</label>
      <NumberField
        :model-value="s.warp"
        :step="0.05"
        :min="L.warp.min"
        :max="L.warp.max"
        title="域扭曲强度"
        @commit="(v) => emit('update', 'Set Warp', clamp(v, L.warp.min, L.warp.max))"
      />
    </div>
    <div class="field">
      <label title="Valley Bias：谷地压平幂次（>1 压低低谷成平地）">Valley Bias</label>
      <NumberField
        :model-value="s.valleyBias"
        :step="0.05"
        :min="L.valleyBias.min"
        :max="L.valleyBias.max"
        title="谷地压平幂次"
        @commit="(v) => emit('update', 'Set Valley Bias', clamp(v, L.valleyBias.min, L.valleyBias.max))"
      />
    </div>
    <div class="field">
      <label title="Sea Level：高度计算前减去的比例（谷底下沉到 y<0，便于摆水面）">Sea Level</label>
      <NumberField
        :model-value="s.seaLevel"
        :step="0.05"
        :min="L.seaLevel.min"
        :max="L.seaLevel.max"
        title="海平面比例"
        @commit="(v) => emit('update', 'Set Sea Level', clamp(v, L.seaLevel.min, L.seaLevel.max))"
      />
    </div>
    <div class="field">
      <label title="Talus：热侵蚀休止角（rise/run；越小塌得越平）">Talus</label>
      <NumberField
        :model-value="s.talus"
        :step="0.1"
        :min="L.talus.min"
        :max="L.talus.max"
        title="休止角"
        @commit="(v) => emit('update', 'Set Talus', clamp(v, L.talus.min, L.talus.max))"
      />
    </div>
    <div class="field">
      <label title="Talus Passes：热侵蚀迭代次数（0 = 关闭；消除分形针尖）">Talus Passes</label>
      <NumberField
        :model-value="s.talusPasses"
        :step="1"
        :min="L.talusPasses.min"
        :max="L.talusPasses.max"
        title="热侵蚀迭代次数"
        @commit="(v) => emit('update', 'Set Talus Passes', clamp(Math.round(v), L.talusPasses.min, L.talusPasses.max))"
      />
    </div>

    <!-- ===== Surface ===== -->
    <div class="ts-group">Surface</div>
    <div class="field">
      <label title="Grass Color：低平草地基色">Grass</label>
      <input type="color" :value="numToHex(s.grassColor)" @change="onColor('Set Grass Color', $event)" />
    </div>
    <div class="field">
      <label title="Rock Color：陡坡/高海拔岩石基色">Rock</label>
      <input type="color" :value="numToHex(s.rockColor)" @change="onColor('Set Rock Color', $event)" />
    </div>
    <div class="field">
      <label title="Snow Color：高平处积雪基色">Snow</label>
      <input type="color" :value="numToHex(s.snowColor)" @change="onColor('Set Snow Color', $event)" />
    </div>
    <div class="hint">
      表面按海拔/坡度在 CPU 烘焙为顶点色（草/林/岩/碎石/雪带）；改任何高度场参数都会重建几何（Segments 越大越慢）。
      设置可存为 .terrain 资产复用（资产面板右键「新建地形」）。
    </div>
  </div>
</template>

<style scoped>
.ts-group {
  margin: 8px 0 2px;
  padding-top: 4px;
  font-size: 10px;
  letter-spacing: 0.4px;
  color: var(--text-dim, #999);
  border-top: 1px solid var(--border, #333);
}
.ts-seed {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.ts-seed button {
  flex: none;
  font-size: 11px;
  line-height: 1.2;
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid var(--border, #444);
  background: transparent;
  color: var(--text, #ddd);
  cursor: pointer;
}
.ts-seed button:hover {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
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
</style>
