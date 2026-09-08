<script setup lang="ts">
/**
 * Physics 卡片（组件模式，任意节点可挂）：
 * - 刚体（RigidBody）：运动学形态 static/kinematic/dynamic + 质量/阻尼/重力缩放/CCD；
 * - 碰撞体（Collider）：box/sphere/capsule/cylinder/convex + 尺寸（自动包围盒或
 *   显式）/偏移/摩擦/弹性/传感器；同节点可挂多个碰撞体（复合形状）；
 * - 无刚体只有碰撞体 = 隐式静态碰撞体；增删改走 InspectorPanel 的 commit（可撤销）；
 * - 运行时状态（世界就绪/模拟中）随 physics:changed 的 rev 刷新。
 */
import { computed } from "vue";
import type { Node } from "../../../framework/prototype/Node";
import { isColliderComponent, isRigidBodyComponent } from "../../../framework/prototype/Node";
import { getEditorStore } from "../../stores/editor";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: Node; rev?: number }>();

const emit = defineEmits<{

  removeComponent: [compId: string];
  toggleComponent: [compId: string, enabled: boolean];
  updateRigidBody: [label: string, value: unknown];
  updateCollider: [compId: string, label: string, value: unknown];
}>();

const editorStore = getEditorStore();
const engine = editorStore.engine;

/** 刚体/碰撞体组件列表（rev 为失效信号） */
const rbComps = computed(() => {
  void props.rev;
  return props.node.components.filter(isRigidBodyComponent);
});
const colComps = computed(() => {
  void props.rev;
  return props.node.components.filter(isColliderComponent);
});

/** 运行时状态（绑定/世界就绪/模拟中；随 physics:changed 的 rev 刷新） */
const runtime = computed(() => {
  void props.rev;
  return engine.physics.stateFor(props.node.id);
});

/** 项目级物理配置（启用状态/引擎；随 rev 刷新） */
const physCfg = computed(() => {
  void props.rev;
  return engine.physics.getConfig();
});

/** 模拟状态文案 */
const simText = computed(() => {
  void props.rev;
  if (!engine.physics.isSimulating) return "未模拟";
  if (engine.physics.isPaused) return "已暂停";
  if (!engine.physics.isWorldReady) return "引擎加载中…";
  return "模拟中";
});

const MODE_OPTIONS: { value: string; label: string; title: string }[] = [
  { value: "static", label: "静态（Static）", title: "不受模拟影响，位置固定" },
  { value: "kinematic", label: "运动学（Kinematic）", title: "由节点变换/动画驱动，推开展开物" },
  { value: "dynamic", label: "动力学（Dynamic）", title: "受力模拟，位移由物理驱动" },
];

const SHAPE_OPTIONS: { value: string; label: string }[] = [
  { value: "box", label: "盒（Box）" },
  { value: "sphere", label: "球（Sphere）" },
  { value: "capsule", label: "胶囊（Capsule）" },
  { value: "cylinder", label: "圆柱（Cylinder）" },
  { value: "convex", label: "凸包（Convex）" },
];
</script>

<template>
  <div class="physics-section" :data-rev="rev">
    <!-- 刚体组件（0/1 个） -->
    <div v-for="c in rbComps" :key="c.id" class="phys-block" :class="{ off: !c.enabled }">
      <div class="phys-block-head">
        <label class="phys-toggle" title="启用/停用" @click.stop>
          <input
            type="checkbox"
            :checked="c.enabled"
            @change="emit('toggleComponent', c.id, ($event.target as HTMLInputElement).checked)"
          />
          <span class="phys-block-title">刚体 Rigid Body</span>
        </label>
        <button class="comp-remove" title="移除刚体" @click="emit('removeComponent', c.id)">×</button>
      </div>
      <template v-if="c.enabled">
        <div class="field">
          <label>形态</label>
          <select
            :value="c.rigidBody.mode"
            @change="emit('updateRigidBody', 'Set RigidBody Mode', ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="m in MODE_OPTIONS" :key="m.value" :value="m.value" :title="m.title">
              {{ m.label }}
            </option>
          </select>
        </div>
        <template v-if="c.rigidBody.mode === 'dynamic'">
          <div class="field">
            <label>质量</label>
            <NumberField
              :model-value="c.rigidBody.mass"
              :step="0.1"
              :min="0.001"
              title="质量（kg）"
              @commit="(v) => emit('updateRigidBody', 'Set RigidBody Mass', v)"
            />
          </div>
          <div class="field">
            <label>线性阻尼</label>
            <NumberField
              :model-value="c.rigidBody.linearDamping"
              :step="0.01"
              :min="0"
              @commit="(v) => emit('updateRigidBody', 'Set RigidBody LinearDamping', v)"
            />
          </div>
          <div class="field">
            <label>角阻尼</label>
            <NumberField
              :model-value="c.rigidBody.angularDamping"
              :step="0.01"
              :min="0"
              @commit="(v) => emit('updateRigidBody', 'Set RigidBody AngularDamping', v)"
            />
          </div>
        </template>
        <div v-if="c.rigidBody.mode !== 'static'" class="field">
          <label>重力缩放</label>
          <NumberField
            :model-value="c.rigidBody.gravityScale"
            :step="0.1"
            :min="0"
            title="0 = 不受重力"
            @commit="(v) => emit('updateRigidBody', 'Set RigidBody GravityScale', v)"
          />
        </div>
        <label class="phys-toggle" @click.stop>
          <input
            type="checkbox"
            :checked="c.rigidBody.ccd"
            @change="emit('updateRigidBody', 'Set RigidBody CCD', ($event.target as HTMLInputElement).checked)"
          />
          <span>连续碰撞检测（CCD，高速防穿透）</span>
        </label>
      </template>
    </div>

    <!-- 碰撞体组件（0..n 个；复合形状） -->
    <div v-for="c in colComps" :key="c.id" class="phys-block" :class="{ off: !c.enabled }">
      <div class="phys-block-head">
        <label class="phys-toggle" title="启用/停用" @click.stop>
          <input
            type="checkbox"
            :checked="c.enabled"
            @change="emit('toggleComponent', c.id, ($event.target as HTMLInputElement).checked)"
          />
          <span class="phys-block-title">碰撞体 Collider</span>
        </label>
        <button class="comp-remove" title="移除碰撞体" @click="emit('removeComponent', c.id)">×</button>
      </div>
      <template v-if="c.enabled">
        <div class="field">
          <label>形状</label>
          <select
            :value="c.collider.shape"
            @change="emit('updateCollider', c.id, 'Set Collider Shape', ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="s in SHAPE_OPTIONS" :key="s.value" :value="s.value">{{ s.label }}</option>
          </select>
        </div>
        <label class="phys-toggle" @click.stop>
          <input
            type="checkbox"
            :checked="c.collider.autoSize"
            @change="emit('updateCollider', c.id, 'Set Collider AutoSize', ($event.target as HTMLInputElement).checked)"
          />
          <span>尺寸自适应（按渲染包围盒）</span>
        </label>
        <template v-if="!c.collider.autoSize">
          <div class="field">
            <label>尺寸</label>
            <div class="phys-vec">
              <NumberField
                :model-value="c.collider.size.x"
                :step="0.1"
                :min="0.1"
                title="X（球取直径；柱体取直径）"
                @commit="(v) => emit('updateCollider', c.id, 'Set Collider Size X', v)"
              />
              <NumberField
                :model-value="c.collider.size.y"
                :step="0.1"
                :min="0.1"
                title="Y（胶囊/圆柱的高）"
                @commit="(v) => emit('updateCollider', c.id, 'Set Collider Size Y', v)"
              />
              <NumberField
                :model-value="c.collider.size.z"
                :step="0.1"
                :min="0.1"
                title="Z"
                @commit="(v) => emit('updateCollider', c.id, 'Set Collider Size Z', v)"
              />
            </div>
          </div>
        </template>
        <div class="field">
          <label>偏移</label>
          <div class="phys-vec">
            <NumberField
              :model-value="c.collider.offset.x"
              :step="0.1"
              title="偏移 X"
              @commit="(v) => emit('updateCollider', c.id, 'Set Collider Offset X', v)"
            />
            <NumberField
              :model-value="c.collider.offset.y"
              :step="0.1"
              title="偏移 Y"
              @commit="(v) => emit('updateCollider', c.id, 'Set Collider Offset Y', v)"
            />
            <NumberField
              :model-value="c.collider.offset.z"
              :step="0.1"
              title="偏移 Z"
              @commit="(v) => emit('updateCollider', c.id, 'Set Collider Offset Z', v)"
            />
          </div>
        </div>
        <div class="field">
          <label>摩擦</label>
          <NumberField
            :model-value="c.collider.friction"
            :step="0.05"
            :min="0"
            @commit="(v) => emit('updateCollider', c.id, 'Set Collider Friction', v)"
          />
        </div>
        <div class="field">
          <label>弹性</label>
          <NumberField
            :model-value="c.collider.restitution"
            :step="0.05"
            :min="0"
            :max="1"
            @commit="(v) => emit('updateCollider', c.id, 'Set Collider Restitution', v)"
          />
        </div>
        <label class="phys-toggle" @click.stop>
          <input
            type="checkbox"
            :checked="c.collider.isSensor"
            @change="emit('updateCollider', c.id, 'Set Collider Sensor', ($event.target as HTMLInputElement).checked)"
          />
          <span>传感器（只触发，不阻挡）</span>
        </label>
      </template>
    </div>


    <!-- 模拟控制（编辑器视口运行时控制，不落盘；配置在项目设置「物理」分类） -->
    <div class="phys-sim">
      <button
        title="开始模拟（快照变换，动力学体开始受力）"
        :disabled="engine.physics.isSimulating"
        @click="engine.physics.play()"
      >▶</button>
      <button
        v-if="!engine.physics.isPaused"
        title="暂停模拟"
        :disabled="!engine.physics.isSimulating || engine.physics.isPaused"
        @click="engine.physics.pause()"
      >⏸</button>
      <button
        v-else
        title="继续模拟"
        @click="engine.physics.resume()"
      >⏵</button>
      <button
        title="停止模拟（销毁世界并还原变换）"
        :disabled="!engine.physics.isSimulating"
        @click="engine.physics.stop()"
      >⏹</button>
      <span class="phys-sim-state mono">{{ simText }}</span>
    </div>

    <!-- 运行时状态 -->
    <div v-if="runtime" class="phys-runtime mono">
      <span>{{ runtime.worldLoading ? "引擎加载中…" : runtime.worldReady ? "世界就绪" : runtime.error ? runtime.error : "世界未创建" }}</span>
      <span v-if="runtime.simulating">{{ runtime.paused ? "（已暂停）" : "（模拟中）" }}</span>
    </div>
    <div class="phys-hint">
      引擎/重力/启用开关在 项目设置 → 物理；{{ physCfg.enabled ? "" : "当前项目未启用物理（预览/发布不模拟），可用上方按钮手动模拟；" }}无刚体的碰撞体 = 静态碰撞体；运动学体由节点变换/动画驱动。
    </div>
  </div>
</template>

<style scoped>
.phys-block {
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  padding: 6px 8px;
  margin-bottom: 8px;
}
.phys-block.off {
  opacity: 0.55;
}
.phys-block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}
.phys-block-title {
  font-weight: 600;
  font-size: 11px;
}
.phys-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text, #ddd);
  cursor: pointer;
  padding: 2px 0;
}
.phys-vec {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
}

.phys-sim {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
}
.phys-sim button {
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
.phys-sim button:hover:not(:disabled) {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
.phys-sim button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.phys-sim-state {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-dim, #999);
}
.phys-runtime {
  display: flex;
  gap: 6px;
  font-size: 11px;
  color: var(--text-dim, #999);
  margin-top: 6px;
}
.phys-hint {
  font-size: 10px;
  line-height: 1.5;
  color: var(--text-dim, #888);
  margin-top: 4px;
}
</style>
