<script setup lang="ts">
/**
 * 原型卡片（拖入的场景实体）——「节点即原型」的组件化卡：
 * 按场景实体索引的组件构成渲染分区卡——
 * - 变换卡（必有）：位置/旋转/缩放/可见性摘要；
 * - 灯光卡（light 组件）：与编辑器灯光组件卡同构（类型/颜色/强度/距离/角度…）；
 * - 脚本卡（每个 script 组件一张）：脚本名 + @property 属性行
 *   （schema 由 scripts store 经 AST 懒解析，不执行用户代码；值取场景快照）；
 * - 逻辑卡（fsmRunner/btRunner）：状态机/行为树资产 + 自启动。
 * 每行 title 标注预览运行时的引擎接入路径（op.set 可寻址）：
 * position.x / light.intensity / script:<路径>:<属性>。
 * 实体被删除时显示缺失警告。
 */
import { computed, reactive, watch } from "vue";
import { Handle, Position } from "@vue-flow/core";
import { getGraphWindowStore } from "../graphStore";
import type { GNode } from "../../framework/graph";
import type { EntityScript } from "../lib/scene-index";
import type { ScriptPropDef } from "../../app/lib/script-compile";

const props = defineProps<{ id: string; data: { g: GNode }; selected?: boolean }>();

const store = getGraphWindowStore();
const g = computed(() => props.data.g);
const entity = computed(() => store.sceneEntities.find((e) => e.id === g.value.entityId) ?? null);

const posText = computed(() =>
  entity.value
    ? `${entity.value.position.x.toFixed(1)}, ${entity.value.position.y.toFixed(1)}, ${entity.value.position.z.toFixed(1)}`
    : "",
);
const rotText = computed(() =>
  entity.value
    ? `${entity.value.rotation.x.toFixed(0)}°, ${entity.value.rotation.y.toFixed(0)}°, ${entity.value.rotation.z.toFixed(0)}°`
    : "",
);

// ----- 灯光卡 -----
const LIGHT_KIND_LABEL: Record<string, string> = {
  point: "点光",
  directional: "平行光",
  spot: "聚光灯",
  ambient: "环境光",
};
const lightColorHex = computed(() => {
  const l = entity.value?.light;
  return l ? "#" + (l.color & 0xffffff).toString(16).padStart(6, "0") : "#ffffff";
});

// ----- 脚本卡：@property schema 懒解析（AST，不执行用户代码） -----
const scripts = computed<EntityScript[]>(() => entity.value?.scripts ?? []);
const schemaCache = reactive(new Map<string, ScriptPropDef[] | null>());
watch(
  () => scripts.value.map((s) => s.script).join("\u0000"),
  () => {
    for (const s of scripts.value) {
      if (schemaCache.has(s.script)) continue;
      schemaCache.set(s.script, null);
      void store.propSchemaFor(s.script).then((defs) => {
        schemaCache.set(s.script, defs);
      });
    }
  },
  { immediate: true },
);
function schemaOf(script: string): ScriptPropDef[] {
  return schemaCache.get(script) ?? [];
}
function propValueOf(s: EntityScript, key: string): string {
  const v = s.props[key];
  if (v === undefined) return "—";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(Math.round(v * 100) / 100);
  if (v && typeof v === "object") return "{…}";
  const strv = String(v);
  return strv.length > 18 ? strv.slice(0, 17) + "…" : strv;
}
/** 脚本路径显示名（src/ 前缀与 .ts 后缀省略） */
function scriptLabel(rel: string): string {
  return rel.replace(/^src\//, "").replace(/\.ts$/, "") || rel;
}
/** 节点类型显示名（meshNode → 网格） */
function typeName(type: string): string {
  const names: Record<string, string> = {
    meshNode: "网格",
    particleSystemNode: "粒子系统",
    terrainNode: "地形",
    cameraNode: "相机",
    audioNode: "音频",
    skyboxNode: "天空盒",
    fogNode: "雾",
    navAgentNode: "导航代理",
    navAreaNode: "导航区域",
    uiCanvasNode: "UI 画布",
    uiLayoutNode: "UI 布局",
    uiTextNode: "UI 文本",
    uiImageNode: "UI 图片",
    uiButtonNode: "UI 按钮",
    lightNode: "灯光",
    pointLightNode: "点光",
    directionalLightNode: "平行光",
    spotLightNode: "聚光灯",
    ambientLightNode: "环境光",
    fsmRunnerNode: "状态机运行器",
    btRunnerNode: "行为树运行器",
  };
  return names[type] ?? "属性";
}
</script>

<template>
  <div class="gcard gproto" :class="{ selected }" :style="{ '--gcard-color': '#569cd6' }">
    <div class="gcard-head">
      <span class="gcard-dot"></span>
      <span class="gcard-title" :title="g.entityId">{{ entity?.name || "原型" }}</span>
      <span class="gcard-badge">{{ entity?.type || "?" }}</span>
    </div>

    <template v-if="entity">
      <!-- 变换卡（必有） -->
      <div class="gcard-rows">
        <div class="grow" title="op.set 可寻址：position.x / position.y / position.z">
          <span class="gk">位置</span><span class="gv mono">{{ posText }}</span>
        </div>
        <div class="grow" title="op.set 可寻址：rotation.x / rotation.y / rotation.z">
          <span class="gk">旋转</span><span class="gv mono">{{ rotText }}</span>
        </div>
        <div class="grow" title="op.set 可寻址：visible">
          <span class="gk">状态</span>
          <span class="gv">{{ entity.visible ? "可见" : "隐藏" }}{{ entity.tag ? ` · ${entity.tag}` : "" }}</span>
        </div>
      </div>

      <!-- 类型卡（按节点类型的关键设置摘要：网格/粒子/地形/相机/音频/天空盒/雾/UI…） -->
      <div v-if="entity.summary.length" class="gcard-section">
        <div class="gsec-head">
          <span class="gsec-dot" style="background: #6a9955"></span>
          <span class="gsec-title">{{ typeName(entity.type) }}</span>
        </div>
        <div class="gcard-rows">
          <div v-for="r in entity.summary" :key="r.label" class="grow">
            <span class="gk">{{ r.label }}</span>
            <span class="gv mono" :title="r.value">{{ r.value }}</span>
          </div>
        </div>
      </div>

      <!-- 灯光卡（light 组件；与编辑器灯光组件卡对镜） -->
      <div v-if="entity.light" class="gcard-section">
        <div class="gsec-head">
          <span class="gsec-dot" :style="{ background: lightColorHex }"></span>
          <span class="gsec-title">灯光 · {{ LIGHT_KIND_LABEL[entity.light.kind] ?? entity.light.kind }}</span>
        </div>
        <div class="gcard-rows">
          <div class="grow" title="灯光组件卡：光色">
            <span class="gk">颜色</span>
            <span class="gv mono">
              <span class="gcolor-dot" :style="{ background: lightColorHex }"></span>{{ lightColorHex }}
            </span>
          </div>
          <div class="grow" title="op.set 可寻址：light.intensity">
            <span class="gk">强度</span><span class="gv mono">{{ entity.light.intensity }}</span>
          </div>
          <div
            v-if="entity.light.kind === 'point' || entity.light.kind === 'spot'"
            class="grow"
            title="op.set 可寻址：light.distance"
          >
            <span class="gk">距离</span><span class="gv mono">{{ entity.light.distance }}</span>
          </div>
          <div v-if="entity.light.kind === 'spot'" class="grow" title="op.set 可寻址：light.angle">
            <span class="gk">角度</span><span class="gv mono">{{ entity.light.angle }}°</span>
          </div>
          <div class="grow">
            <span class="gk">阴影</span><span class="gv">{{ entity.light.castShadow ? "投射" : "关闭" }}</span>
          </div>
        </div>
      </div>

      <!-- 脚本卡（每个 script 组件一张；@property 属性行由 AST 解析生成） -->
      <div v-for="s in scripts" :key="s.script" class="gcard-section">
        <div class="gsec-head">
          <span class="gsec-dot" style="background: #dcdcaa"></span>
          <span class="gsec-title" :title="s.script">脚本 · {{ scriptLabel(s.script) }}</span>
        </div>
        <div class="gcard-rows">
          <div
            v-for="def in schemaOf(s.script)"
            :key="def.key"
            class="grow"
            :title="`脚本属性 @property ${def.key}（当前场景值）`"
          >
            <span class="gk">{{ def.label || def.key }}</span>
            <span class="gv mono">{{ propValueOf(s, def.key) }}</span>
          </div>
          <div v-if="schemaOf(s.script) !== null && schemaOf(s.script).length === 0" class="grow">
            <span class="gk">无 @property 声明</span>
          </div>
        </div>
      </div>

      <!-- 逻辑卡（状态机/行为树运行器） -->
      <div v-if="entity.logic" class="gcard-section">
        <div class="gsec-head">
          <span class="gsec-dot" style="background: #569cd6"></span>
          <span class="gsec-title">{{ entity.logic.kind === "bt" ? "行为树" : "状态机" }} · 运行器</span>
        </div>
        <div class="gcard-rows">
          <div class="grow">
            <span class="gk">资产</span>
            <span class="gv mono" :title="entity.logic.asset">{{ scriptLabel(entity.logic.asset) || "未绑定" }}</span>
          </div>
          <div class="grow">
            <span class="gk">自启动</span><span class="gv">{{ entity.logic.autoStart ? "是" : "否" }}</span>
          </div>
        </div>
      </div>

      <div
        v-if="!entity.light && scripts.length === 0 && !entity.logic && entity.summary.length === 0"
        class="grow muted"
        title="无组件：给实体添加灯光/脚本组件后，此处会生成对应的组件卡"
      >
        基础原型（无组件卡）
      </div>
    </template>
    <div v-else class="gcard-missing">实体不在当前场景（可能已被删除）</div>

    <div class="gcard-body">
      <div class="gcard-col"></div>
      <div class="gcard-col">
        <div class="gprow right">
          <span class="gpin-label">实体集</span>
          <Handle type="source" :position="Position.Right" id="out" class="gpin entities" :style="{ background: '#6a9955' }" />
        </div>
      </div>
    </div>
  </div>
</template>
