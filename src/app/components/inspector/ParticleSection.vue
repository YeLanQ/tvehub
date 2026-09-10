<script setup lang="ts">
/**
 * 粒子系统节点卡（常规粒子系统参数子集）：
 * - Main：周期/循环/预热/起始延迟/寿命/初速度/尺寸/颜色/重力/模拟空间/粒子上限；
 * - Emission：发射速率；
 * - Shape：形状（圆锥/球/半球/盒）+ 半径 + 圆锥半角；
 * - Color / Size over Lifetime：开关 + 终点颜色；
 * - Renderer：混合模式 + 贴图（内置软圆点 / 内置图片 / 项目图片资产）；
 * - 运行时控制（播放/暂停/停止/重启）直连引擎，不落盘。
 * 事件统一 emit("update", label, value)，label 即撤销历史文案。
 */
import { computed } from "vue";
import { getEditorStore } from "../../stores/editor";
import { getAssetsStore } from "../../stores/assets";
import { isInternalAsset } from "../../../lib/internal-assets";
import type { ParticleSystemNode } from "../../../framework/prototype/derived/Primitives";
import { PARTICLE_LIMITS, isParticleTextureRel } from "../../../framework/particles";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: ParticleSystemNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

const engine = getEditorStore().engine;
const assetsStore = getAssetsStore();
const L = PARTICLE_LIMITS;

/** 节点是普通类实例（非响应式）：以 rev 为失效信号读取设置 */
const s = computed(() => {
  void props.rev;
  return props.node.particles;
});

/** 贴图候选（内置图片 + 项目图片；导入 png/jpg 等后自动出现），与材质贴图通道同一集合 */
const textureOptions = computed(() => {
  const internal: { rel: string; name: string }[] = [];
  const project: { rel: string; name: string }[] = [];
  for (const a of assetsStore.assets) {
    if (a.kind === "dir" || !isParticleTextureRel(a.path)) continue;
    if (isInternalAsset(a.path)) internal.push({ rel: a.path, name: a.name });
    else if (a.path.startsWith("assets/")) project.push({ rel: a.path, name: a.name });
  }
  return { internal, project };
});

/** 当前贴图引用是否在候选里（资产被删/移走时仍回显路径，不静默丢失） */
const textureListed = computed(() => {
  const cur = s.value.texture;
  if (!cur) return true;
  return (
    textureOptions.value.internal.some((o) => o.rel === cur) ||
    textureOptions.value.project.some((o) => o.rel === cur)
  );
});

/** 运行时状态（存活数/播放态；随 particles:changed 与图变化的 rev 刷新） */
const runtime = computed(() => {
  void props.rev;
  return engine.particles.stateFor(props.node.id);
});

const stateText = computed(() => {
  const rt = runtime.value;
  if (!rt) return "等待入图…";
  const alive = `${rt.alive} 粒子`;
  if (rt.paused) return `已暂停 · ${alive}`;
  if (rt.finished) return `已播完 · ${alive}`;
  return `播放中 · ${alive}`;
});

function numToHex(v: number): string {
  return "#" + (v & 0xffffff).toString(16).padStart(6, "0");
}
function hexToNum(hex: string): number {
  return parseInt(hex.replace("#", ""), 16) & 0xffffff;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function onSelect(label: string, e: Event): void {
  emit("update", label, (e.target as HTMLSelectElement).value);
}
function onCheck(label: string, e: Event): void {
  emit("update", label, (e.target as HTMLInputElement).checked);
}
function onColor(label: string, e: Event): void {
  emit("update", label, hexToNum((e.target as HTMLInputElement).value));
}

// —— 运行时控制（不落盘）——
function rtPlay(): void {
  engine.particles.play(props.node.id);
}
function rtPause(): void {
  engine.particles.pause(props.node.id);
}
function rtStop(): void {
  engine.particles.stop(props.node.id);
}
function rtRestart(): void {
  engine.particles.restart(props.node.id);
}
</script>

<template>
  <div class="particle-section" :data-rev="rev">
    <!-- 运行时控制 + 状态（不落盘） -->
    <div class="ps-runtime">
      <div class="ps-btns">
        <button title="播放（暂停态续播；停止/播完态从头开始）" @click="rtPlay">▶</button>
        <button title="暂停（保留当前粒子）" @click="rtPause">⏸</button>
        <button title="停止发射（存活粒子自然消亡）" @click="rtStop">⏹</button>
        <button title="重启（清空粒子并从头开始；预热系统快进一个周期）" @click="rtRestart">↻</button>
      </div>
      <span class="ps-state mono">{{ stateText }}</span>
    </div>

    <!-- ===== Main ===== -->
    <div class="ps-group">Main</div>
    <div class="field">
      <label title="Duration：发射周期（秒）。非循环系统发射持续该时长后停止；循环系统作预热快进量">Duration</label>
      <NumberField
        :model-value="s.duration"
        :step="0.5"
        :min="L.duration.min"
        :max="L.duration.max"
        title="发射周期（秒）"
        @commit="(v) => emit('update', 'Set Duration', clamp(v, L.duration.min, L.duration.max))"
      />
    </div>
    <label class="ps-toggle" @click.stop>
      <input type="checkbox" :checked="s.looping" @change="onCheck('Toggle Looping', $event)" />
      <span title="Looping：周期结束后继续发射">Looping</span>
    </label>
    <label class="ps-toggle" @click.stop>
      <input
        type="checkbox"
        :checked="s.prewarm"
        :disabled="!s.looping"
        @change="onCheck('Toggle Prewarm', $event)"
      />
      <span title="Prewarm：入图/重启时快进一个周期，粒子瞬间就位（仅循环系统）">Prewarm</span>
    </label>
    <div class="field">
      <label title="Start Delay：播放后延迟多少秒开始发射">Start Delay</label>
      <NumberField
        :model-value="s.startDelay"
        :step="0.1"
        :min="L.startDelay.min"
        :max="L.startDelay.max"
        title="起始延迟（秒）"
        @commit="(v) => emit('update', 'Set Start Delay', clamp(v, L.startDelay.min, L.startDelay.max))"
      />
    </div>
    <div class="field">
      <label title="Start Lifetime：每个粒子的寿命（秒）">Start Lifetime</label>
      <NumberField
        :model-value="s.startLifetime"
        :step="0.1"
        :min="L.startLifetime.min"
        :max="L.startLifetime.max"
        title="粒子寿命（秒）"
        @commit="(v) => emit('update', 'Set Start Lifetime', clamp(v, L.startLifetime.min, L.startLifetime.max))"
      />
    </div>
    <div class="field">
      <label title="Start Speed：粒子初速度（世界单位/秒）">Start Speed</label>
      <NumberField
        :model-value="s.startSpeed"
        :step="0.1"
        :min="L.startSpeed.min"
        :max="L.startSpeed.max"
        title="初速度（世界单位/秒）"
        @commit="(v) => emit('update', 'Set Start Speed', clamp(v, L.startSpeed.min, L.startSpeed.max))"
      />
    </div>
    <div class="field">
      <label title="Start Size：粒子初始直径（世界单位）">Start Size</label>
      <NumberField
        :model-value="s.startSize"
        :step="0.05"
        :min="L.startSize.min"
        :max="L.startSize.max"
        title="初始尺寸（世界单位）"
        @commit="(v) => emit('update', 'Set Start Size', clamp(v, L.startSize.min, L.startSize.max))"
      />
    </div>
    <div class="field">
      <label title="Start Color：粒子初始颜色">Start Color</label>
      <input
        type="color"
        :value="numToHex(s.startColor)"
        @change="onColor('Set Start Color', $event)"
      />
    </div>
    <div class="field">
      <label title="Gravity Modifier：重力系数（1 = 标准重力 9.81；0 = 无重力；负值上浮）">Gravity</label>
      <NumberField
        :model-value="s.gravityModifier"
        :step="0.1"
        :min="L.gravityModifier.min"
        :max="L.gravityModifier.max"
        title="重力系数"
        @commit="(v) => emit('update', 'Set Gravity Modifier', clamp(v, L.gravityModifier.min, L.gravityModifier.max))"
      />
    </div>
    <div class="field">
      <label title="Simulation Space：Local = 粒子跟随节点移动；World = 粒子留在世界空间（拖尾/烟迹）">
        Simulation Space
      </label>
      <select :value="s.simulationSpace" @change="onSelect('Set Simulation Space', $event)">
        <option value="local">Local（跟随节点）</option>
        <option value="world">World（留在世界）</option>
      </select>
    </div>
    <div class="field">
      <label title="Max Particles：同时存活的粒子上限（缓冲容量；改动会重建发射器）">Max Particles</label>
      <NumberField
        :model-value="s.maxParticles"
        :step="10"
        :min="L.maxParticles.min"
        :max="L.maxParticles.max"
        title="粒子上限（1~20000）"
        @commit="(v) => emit('update', 'Set Max Particles', Math.round(clamp(v, L.maxParticles.min, L.maxParticles.max)))"
      />
    </div>

    <!-- ===== Emission ===== -->
    <div class="ps-group">Emission</div>
    <div class="field">
      <label title="Rate over Time：每秒发射的粒子数">Rate over Time</label>
      <NumberField
        :model-value="s.emissionRate"
        :step="1"
        :min="L.emissionRate.min"
        :max="L.emissionRate.max"
        title="发射速率（粒子/秒）"
        @commit="(v) => emit('update', 'Set Emission Rate', clamp(v, L.emissionRate.min, L.emissionRate.max))"
      />
    </div>

    <!-- ===== Shape ===== -->
    <div class="ps-group">Shape</div>
    <div class="field">
      <label title="Shape：发射形状。Cone / Box 沿节点本地 -Z 发射（与灯光/相机前向一致）">Shape</label>
      <select :value="s.shape" @change="onSelect('Set Shape', $event)">
        <option value="cone">Cone（圆锥）</option>
        <option value="sphere">Sphere（球面）</option>
        <option value="hemisphere">Hemisphere（上半球）</option>
        <option value="box">Box（盒体）</option>
      </select>
    </div>
    <div class="field">
      <label title="Radius：圆锥底圆半径 / 球半径 / 盒半边长">Radius</label>
      <NumberField
        :model-value="s.shapeRadius"
        :step="0.1"
        :min="L.shapeRadius.min"
        :max="L.shapeRadius.max"
        title="形状半径（世界单位）"
        @commit="(v) => emit('update', 'Set Shape Radius', clamp(v, L.shapeRadius.min, L.shapeRadius.max))"
      />
    </div>
    <div v-if="s.shape === 'cone'" class="field">
      <label title="Angle：圆锥半角（度）；0 = 平行直射，越大越发散">Angle</label>
      <NumberField
        :model-value="s.shapeAngle"
        :step="1"
        :min="L.shapeAngle.min"
        :max="L.shapeAngle.max"
        title="圆锥半角（度，0~89）"
        @commit="(v) => emit('update', 'Set Shape Angle', clamp(v, L.shapeAngle.min, L.shapeAngle.max))"
      />
    </div>

    <!-- ===== Color over Lifetime ===== -->
    <div class="ps-group">Color over Lifetime</div>
    <label class="ps-toggle" @click.stop>
      <input
        type="checkbox"
        :checked="s.colorOverLifetime"
        @change="onCheck('Toggle Color Over Lifetime', $event)"
      />
      <span title="开启：颜色从 Start Color 渐变到 End Color，并在末段淡出">Enabled</span>
    </label>
    <div class="field">
      <label title="End Color：寿命终点颜色">End Color</label>
      <input
        type="color"
        :value="numToHex(s.endColor)"
        :disabled="!s.colorOverLifetime"
        @change="onColor('Set End Color', $event)"
      />
    </div>

    <!-- ===== Size over Lifetime ===== -->
    <div class="ps-group">Size over Lifetime</div>
    <label class="ps-toggle" @click.stop>
      <input
        type="checkbox"
        :checked="s.sizeOverLifetime"
        @change="onCheck('Toggle Size Over Lifetime', $event)"
      />
      <span title="开启：尺寸随寿命从 Start Size 线性缩到 0">Enabled</span>
    </label>

    <!-- ===== Renderer ===== -->
    <div class="ps-group">Renderer</div>
    <div class="field">
      <label title="Blending：Additive 叠加（火焰/魔法，越叠越亮）；Normal 常规透明混合（烟雾/雨雪）">Blending</label>
      <select :value="s.blending" @change="onSelect('Set Blending', $event)">
        <option value="additive">Additive（叠加）</option>
        <option value="normal">Normal（透明混合）</option>
      </select>
    </div>
    <div class="field">
      <label title="Texture：粒子精灵贴图。贴图 RGB 与粒子颜色相乘、alpha 与透明度相乘（白底透明 PNG 即着色精灵）；空 = 内置程序化软圆点">
        Texture
      </label>
      <select :value="s.texture" @change="onSelect('Set Texture', $event)">
        <option value="">（内置软圆点）</option>
        <option v-if="!textureListed" :value="s.texture" :title="s.texture">{{ s.texture }}（未找到）</option>
        <optgroup v-if="textureOptions.internal.length" label="内置图片">
          <option v-for="o in textureOptions.internal" :key="o.rel" :value="o.rel" :title="o.rel">
            {{ o.name }}
          </option>
        </optgroup>
        <optgroup label="项目图片">
          <option v-if="textureOptions.project.length === 0" value="" disabled>
            （项目内暂无图片，可在资产面板「导入」png/jpg 等文件）
          </option>
          <option v-for="o in textureOptions.project" :key="o.rel" :value="o.rel" :title="o.rel">
            {{ o.name }}
          </option>
        </optgroup>
      </select>
    </div>
    <div class="hint">
      粒子为 billboard 精灵（默认程序化软圆点，可换图片贴图），随节点变换与层级；预览/构建按同一参数回放。
    </div>
  </div>
</template>

<style scoped>
.ps-group {
  margin: 8px 0 2px;
  padding-top: 4px;
  font-size: 10px;
  letter-spacing: 0.4px;
  color: var(--text-dim, #999);
  border-top: 1px solid var(--border, #333);
}
.ps-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-right: 10px;
  font-size: 11px;
  color: var(--text, #ddd);
  cursor: pointer;
  padding: 2px 0;
}
.ps-runtime {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0 4px;
}
.ps-btns {
  display: inline-flex;
  gap: 4px;
  flex: none;
}
.ps-btns button {
  font-size: 11px;
  line-height: 1.2;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid var(--text-dim, #666);
  background: transparent;
  color: var(--text, #ddd);
  cursor: pointer;
}
.ps-btns button:hover {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
.ps-state {
  flex: 1 1 auto;
  min-width: 60px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-dim, #999);
}
</style>
