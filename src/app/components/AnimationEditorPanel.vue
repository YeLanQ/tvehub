<script setup lang="ts">
// ---------------------------------------------------------------------------
// 动画编辑窗口（底部停靠面板：轨道 + 时间轴 + 曲线的轻量实现）。
// 本文件是组合壳：脚本逻辑按领域拆在 app/composables/anim-editor/ 下
// （useAnimView/useAnimClip/useAnimPreview/useAnimPlayback/useAnimTracks/
// useAnimTimeline/useAnimSelection/useAnimCurve），此处只解构暴露给模板；
// 样式在 styles/components/anim-editor.scss（scoped）。功能说明见各模块头部。
// ---------------------------------------------------------------------------
import { onBeforeUnmount } from "vue";
import { useAnimEditor } from "../composables/anim-editor/useAnimEditor";
import { animEditMode, exitAnimEditMode } from "../lib/anim-edit-mode";
import NumberField from "./NumberField.vue";

const {
  clip: { clipRel, doc, dirty, saving, onPickClip, clipOptions },
  preview: { targetNode },
  playback: { time, playing, recording, togglePlaying, toggleRecording, stopPreview },
  tracks: {
    onDurationChange,
    onLoopsChange,
    onAddPropertyMenu,
    keyChannel,
    removeChannel,
    keyAll,
    fullPathOf,
    pathLabel,
    keyCount,
    keysOf,
    tracks,
    trackRows,
    toggleGroup,
    isGroupCollapsed,
  },
  timeline: {
    laneEl,
    namesEl,
    lanePanning,
    timelineWidth,
    tToX,
    zoom,
    onZoomInput,
    onLaneWheel,
    onWrapPointerDown,
    onLanesScroll,
    onNamesScroll,
    beginScrub,
    beginKeyDrag,
    onRulerPointerMove,
    onLanePointerMove,
    onLanePointerUp,
    rulerTicks,
    tickLabel,
    curveGridTicks,
    snapEnabled,
  },
  selection: { selected, deleteSelected, selectedInterp, onInterpChange, onKeyMenu },
  curve: {
    curveProp,
    curveSvgEl,
    curveView,
    curveZoom,
    curveGeom,
    curvePanning,
    resetCurveView,
    onCurveZoomInput,
    onCurveDown,
    onCurveMove,
    onCurveUp,
    onCurveWheel,
    onCurveContextMenu,
    isAutoTangent,
  },
  view: { viewMode, onViewModeChange, viewHint },
} = useAnimEditor();

// 聚焦编辑模式：面板卸载（整机/编辑器关闭）时兜底解除，避免选中范围过滤残留
onBeforeUnmount(() => exitAnimEditMode());
</script>

<template>
  <div class="panel anim-editor mono">
    <!-- 顶部工具条：剪辑选择 + 属性 + 播放/录制控制 -->
    <div class="anim-toolbar">
      <select class="anim-pick" :value="clipRel" title="选择要编辑的动画剪辑" @change="onPickClip($event)">
        <option value="">（选择动画剪辑 .anim）</option>
        <option v-for="a in clipOptions" :key="a.path" :value="a.path">{{ a.path }}</option>
      </select>

      <template v-if="doc">
        <label class="anim-field">时长
          <NumberField
            :model-value="doc.duration"
            :step="0.1"
            :min="0.1"
            title="剪辑时长（秒）"
            @commit="onDurationChange"
          />
        </label>
        <label class="anim-check" title="循环播放">
          <input type="checkbox" :checked="doc.loops" @change="onLoopsChange($event)" /><span>循环</span>
        </label>

        <span class="anim-sep"></span>
        <button class="anim-btn rec" :class="{ on: recording }" :title="recording ? '停止录制' : '录制：开启后修改节点变换自动 K 帧（已添加通道）'" @click="toggleRecording">●</button>
        <button class="anim-btn" :title="playing ? '暂停预览' : '播放预览（应用到选中节点）'" @click="togglePlaying">{{ playing ? "⏸" : "▶" }}</button>
        <button class="anim-btn" title="停止并还原节点姿势" @click="stopPreview">⏹</button>
        <button
          class="anim-btn"
          :class="{ on: snapEnabled }"
          title="时间吸附：scrub 与关键帧拖拽对齐到刻度细分网格（按住 Alt 临时关闭）"
          @click="snapEnabled = !snapEnabled"
        >吸附</button>
        <span class="anim-time mono">{{ time.toFixed(2) }}s / {{ doc.duration.toFixed(2) }}s</span>
        <span class="anim-sep"></span>
        <button class="anim-btn" title="为所有已添加通道 K 帧（当前时间、选中节点当前值）" @click="keyAll">K 全部</button>
        <span class="anim-target" :title="targetNode?.name">
          目标：{{ targetNode ? targetNode.name : "（未选中节点）" }}
        </span>
        <button
          v-if="animEditMode.active"
          class="anim-btn exit-edit"
          title="退出聚焦编辑：恢复其它节点可选与面板切换"
          @click="exitAnimEditMode"
        >退出编辑</button>
        <span class="anim-dirty" :class="{ dirty }">{{ saving ? "保存中…" : dirty ? "未保存" : "已保存" }}</span>
        <select
          class="anim-view-pick"
          :value="viewMode"
          title="视图模式：帧动画关键帧轨道 / 单通道曲线编辑（二选一显示）"
          @change="onViewModeChange($event)"
        >
          <option value="dope">帧动画</option>
          <option value="curve">曲线编辑</option>
        </select>
        <template v-if="viewMode === 'curve'">
          <span class="anim-sep"></span>
          <label class="zoom-ctl" title="曲线数值轴缩放（1 = 自动适配全曲线；调小 = 放大查看）。鼠标方案与帧动画统一：滚轮缩放时间轴、Ctrl 滚轮平移、中键拖拽平移（纵向拖动可平移数值轴）">
            <input type="range" min="0.2" max="4" step="0.1" :value="curveZoom" @input="onCurveZoomInput" />
            <span class="mono">值×{{ curveZoom.toFixed(1) }}</span>
          </label>
          <button class="anim-btn" :disabled="!curveView" title="复位数值轴（恢复自动适配全曲线；时间轴用底部滑条/滚轮）" @click="resetCurveView">适配</button>
        </template>
      </template>
    </div>

    <!-- 未选择剪辑 -->
    <div v-if="!doc" class="anim-empty">
      在上方选择 .anim 剪辑；没有可在资产面板右键「新建动画」，或给节点添加「动画剪辑」组件后从组件卡打开。
    </div>

    <template v-else>
      <div class="anim-body">
        <!-- 左列：层级轨道树滚动区（与右列双向同步滚动）+ 底部固定添加属性按钮 -->
        <div class="anim-names">
          <div class="names-scroll" ref="namesEl" @scroll="onNamesScroll()">
            <div class="anim-row-head head-label">通道</div>
            <template v-for="row in trackRows" :key="row.kind + row.key">
              <!-- 组行：点击折叠/展开 -->
              <div
                v-if="row.kind === 'group'"
                class="anim-row-head group-row"
                :style="{ paddingLeft: 4 + row.depth * 12 + 'px' }"
                @click="toggleGroup(row.key)"
              >
                <span class="h-caret-mini">{{ isGroupCollapsed(row.key) ? "▸" : "▾" }}</span>
                <span class="ch-label">{{ row.name }}</span>
              </div>
              <!-- 叶子行：通道（K / 移除 / 点选曲线视图） -->
              <div
                v-else
                class="anim-row-head name-row"
                :class="{ on: curveProp === row.prop }"
                :style="{ paddingLeft: 4 + row.depth * 12 + 'px' }"
                :title="fullPathOf(row.prop) + ' · ' + keyCount(row.prop) + ' 关键帧'"
                @click="curveProp = row.prop"
              >
                <span class="ch-label">{{ row.name }}</span>
                <button
                  class="k-btn"
                  title="在当前时间 K（取选中节点当前值）"
                  @click.stop="keyChannel(row.prop)"
                >K</button>
                <button
                  class="k-btn del"
                  title="移除该通道（连同其全部关键帧）"
                  @click.stop="removeChannel(row.prop)"
                >✕</button>
              </div>
            </template>
          </div>
          <button class="add-prop-btn" title="为剪辑添加可动画属性（按选中节点能力提供）" @click.stop="onAddPropertyMenu($event)">＋ 添加属性</button>
        </div>

        <!-- 右侧视图区：帧动画轨道 / 曲线编辑（下拉切换，二选一显示；共享时间窗缩放） -->
        <div class="anim-lanes" :class="{ panning: lanePanning }" ref="laneEl" @wheel="onLaneWheel($event)" @scroll="onLanesScroll()">
          <template v-if="viewMode === 'dope'">
            <div class="lane-wrap" :style="{ width: timelineWidth + 'px' }" @pointerdown="onWrapPointerDown($event)">
            <div
              class="lane ruler"
              @pointerdown="beginScrub($event)"
              @pointermove="onRulerPointerMove($event)"
              @pointerup="onLanePointerUp()"
              @pointercancel="onLanePointerUp()"
            >
              <span
                v-for="tk in rulerTicks"
                :key="tk"
                class="tick mono"
                :style="{ left: tToX(tk, doc.duration) + 'px' }"
              >{{ tickLabel(tk) }}</span>
              <span class="playhead" :style="{ left: tToX(time, doc.duration) + 'px' }"></span>
            </div>
            <template v-for="row in trackRows" :key="row.kind + row.key">
              <!-- 组行轨道：展开 = 占位；折叠 = 子孙关键帧合并概要 -->
              <div v-if="row.kind === 'group'" class="lane group-spacer" :title="isGroupCollapsed(row.key) ? `${row.times.length} 个关键帧（子通道合并）` : undefined">
                <template v-if="isGroupCollapsed(row.key)">
                  <span
                    v-for="t in row.times"
                    :key="t"
                    class="key-dot dim"
                    :style="{ left: tToX(t, doc.duration) + 'px' }"
                  ></span>
                  <span class="playhead thin" :style="{ left: tToX(time, doc.duration) + 'px' }"></span>
                </template>
              </div>
              <!-- 叶子行：通道关键帧（按下即选中，拖拽改时间） -->
              <div
                v-else
                class="lane key-lane"
                :class="{ on: curveProp === row.prop }"
                @pointermove="onLanePointerMove($event)"
                @pointerup="onLanePointerUp()"
                @pointercancel="onLanePointerUp()"
              >
                <button
                  v-for="(k, i) in keysOf(row.prop)"
                  :key="i"
                  class="key-dot"
                  :class="{ sel: selected?.prop === row.prop && Math.abs(selected.t - k.t) <= 1e-4 }"
                  :style="{ left: tToX(k.t, doc.duration) + 'px' }"
                  :title="`${k.t.toFixed(2)}s = ${k.v.toFixed(2)}（${k.i === 'linear' ? '线性' : k.i === 'step' ? '阶跃' : '平滑'}）；拖拽改时间，右键菜单`"
                  @pointerdown.stop="beginKeyDrag($event, row.prop, i)"
                  @contextmenu.stop.prevent="onKeyMenu($event, row.prop, k.t)"
                ></button>
                <span class="playhead thin" :style="{ left: tToX(time, doc.duration) + 'px' }"></span>
              </div>
            </template>
            <div v-if="tracks.length === 0" class="hint lane-empty">
              尚未添加属性：「＋ 添加属性」
            </div>
            </div>
          </template>
          <template v-else>
            <div v-if="tracks.length === 0" class="hint lane-empty">
              尚未添加属性：「＋ 添加属性」
            </div>
            <div v-else-if="!curveProp" class="hint lane-empty">点击左侧通道名显示其曲线</div>
            <template v-else>
              <div class="curve-title mono">{{ pathLabel(curveProp) }}</div>
              <svg
                ref="curveSvgEl"
                class="anim-curve"
                :class="{ panning: curvePanning }"
                :viewBox="`0 0 ${curveGeom.w} ${curveGeom.h}`"
                @pointerdown="onCurveDown"
                @pointermove="onCurveMove"
                @pointerup="onCurveUp"
                @pointercancel="onCurveUp"
                @contextmenu="onCurveContextMenu($event)"
                @wheel.prevent="onCurveWheel($event)"
              >
                <line
                  v-for="(tk, gi) in curveGridTicks"
                  :key="gi"
                  class="c-grid"
                  :class="{ minor: !rulerTicks.includes(tk) }"
                  :x1="curveGeom.xOf(tk)"
                  :y1="curveGeom.pad"
                  :x2="curveGeom.xOf(tk)"
                  :y2="curveGeom.h - curveGeom.pad"
                />
                <text
                  v-for="(tk, gi) in rulerTicks"
                  :key="'g' + gi"
                  class="c-gridlab mono"
                  :x="curveGeom.xOf(tk) + 3"
                  :y="curveGeom.pad - 4"
                >{{ tickLabel(tk) }}</text>
                <line class="c-playhead" :x1="curveGeom.xOf(time)" :y1="0" :x2="curveGeom.xOf(time)" :y2="curveGeom.h" />
                <line class="c-axis" :x1="curveGeom.pad" :y1="curveGeom.h - curveGeom.pad" :x2="curveGeom.w - curveGeom.pad" :y2="curveGeom.h - curveGeom.pad" />
                <line class="c-axis" :x1="curveGeom.pad" :y1="curveGeom.pad" :x2="curveGeom.pad" :y2="curveGeom.h - curveGeom.pad" />
                <polyline class="c-line" :points="curveGeom.polyline" />
                <!-- 切线手柄（杆 + 端点）：自动态虚影提示，手动态实心可拖 -->
                <template v-for="(hd, hi) in curveGeom.handles" :key="'h' + hi">
                  <line
                    class="c-handle"
                    :class="{ auto: !hd.manual, ghost: hd.ghost }"
                    :x1="curveGeom.xOf(curveGeom.keys[hd.index].t)"
                    :y1="curveGeom.yOf(curveGeom.keys[hd.index].v)"
                    :x2="hd.x"
                    :y2="hd.y"
                  />
                  <circle
                    class="c-handle-end"
                    :class="{ auto: !hd.manual, ghost: hd.ghost }"
                    :cx="hd.x"
                    :cy="hd.y"
                    r="4"
                  />
                </template>
                <rect
                  v-for="k in curveGeom.keys"
                  :key="k.t"
                  class="c-key"
                  :class="{
                    sel: selected?.prop === curveProp && Math.abs(selected.t - k.t) <= 1e-4,
                    manual: !isAutoTangent(k),
                    sym: k.tm === true,
                  }"
                  :x="curveGeom.xOf(k.t) - 4"
                  :y="curveGeom.yOf(k.v) - 4"
                  width="8"
                  height="8"
                />
              </svg>
            </template>
          </template>
        </div>
      </div>

      <!-- 关键帧操作条（两种视图共用：插值下拉 + 删除） -->
      <div class="anim-bottom">
        <div class="anim-keyops">
          <select
            class="interp-pick"
            :value="selectedInterp"
            :disabled="!selected"
            title="选中关键帧的插值方式（自动 = 平滑 + Catmull-Rom 自动切线）"
            @change="onInterpChange($event)"
          >
            <option value="" disabled>（未选中关键帧）</option>
            <option value="auto" :disabled="selectedInterp !== 'auto' && selectedInterp !== 'smooth'">
              平滑 · 自动切线
            </option>
            <option value="linear">线性</option>
            <option value="step">阶跃</option>
            <option value="smooth">平滑</option>
          </select>
          <button class="anim-btn danger" :disabled="!selected" title="删除选中的关键帧" @click="deleteSelected">删除 K</button>
          <span class="anim-hint">{{ viewHint }}</span>
          <label class="zoom-ctl" title="时间轴缩放（1× 铺满；帧动画与曲线视图共用同一时间窗，滚轮同样可缩放）">
            <input type="range" min="1" max="8" step="0.5" :value="zoom" @input="onZoomInput" />
            <span class="mono">×{{ zoom.toFixed(1) }}</span>
          </label>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped src="../../styles/components/anim-editor.scss"></style>