<script setup lang="ts">
/**
 * 属性面板：选中元素的几何/样式/图层归属编辑。
 * 连续输入（颜色拾取/滑杆/数字步进）经 transact 折叠，change 时 settle 入历史。
 */
import { computed, ref } from "vue";
import Slider from "../../ui-kit/components/Slider.vue";
import ComboBox from "../../ui-kit/components/ComboBox.vue";
import { getWhiteboardStore } from "../whiteboardStore";
import { DEFAULT_STROKE, type SvgEl, type SvgFillFit, type SvgTextAlign } from "../svg-doc";

const store = getWhiteboardStore();

/** 三位小数收敛（显示与写入一致） */
const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const r3v = (n: number): number => Number(n.toFixed(3));

const el = computed(() => store.selectedEl());

/** 文本内容：直接编辑语法源（标签在画布上解析为样式，不出现在可见文本里） */
function onTextInput(ev: Event): void {
  const v = (ev.target as HTMLTextAreaElement).value;
  store.transact(() => {
    const t = el.value;
    if (!t) return;
    t.text = v;
  });
}

/**
 * 字形候选（ui-kit ComboBox 的候选列表）：候选之外可自由手填任意字体名；
 * 清空 = 回落到默认字体栈（渲染与导出都有兜底）。
 */
const FONT_OPTIONS = [
  "微软雅黑",
  "宋体",
  "黑体",
  "楷体",
  "仿宋",
  "等线",
  "Segoe UI",
  "Arial",
  "Times New Roman",
  "Georgia",
  "Consolas",
  "monospace",
];

/** 字形提交（ComboBox 在选行/Enter/失焦时提交，一次提交压一条历史） */
function onFontCommit(v: string): void {
  const t = el.value;
  if (!t || t.style.fontFamily === v) return;
  store.commit("修改字形", () => {
    t.style.fontFamily = v;
  });
}

const KIND_LABEL: Record<string, string> = {
  rect: "矩形",
  ellipse: "椭圆",
  line: "直线",
  pencil: "铅笔轨迹",
  path: "钢笔路径",
  text: "文本",
};

/** 上次非空填充色（勾选「无填充」前记住，取消勾选时恢复） */
const lastFill = ref("#4a9eff");

/** 图片填充相关字段整体清掉（「移除图片」按钮；「无」勾选框只管颜色，两者互不干扰） */
function clearImgFields(t: SvgEl): void {
  delete t.style.fillImage;
  delete t.style.fillFit;
  delete t.style.fillImgW;
  delete t.style.fillImgH;
}

function num(ev: Event): number {
  const v = parseFloat((ev.target as HTMLInputElement).value);
  return Number.isFinite(v) ? v : 0;
}

/** 数字字段：input 连续编辑（折叠历史） + change 落历史 */
function numInput(set: (v: number) => void) {
  // 注意：v-bind 展开的事件键必须是 onInput/onChange（isOn 只认 onXxx），
  // 写成 input/change 会被当普通属性，监听器根本绑不上
  return {
    onInput: (ev: Event) => store.transact(() => set(num(ev))),
    onChange: () => store.settle("修改属性"),
  };
}

function fillNone(ev: Event): void {
  const none = (ev.target as HTMLInputElement).checked;
  const target = el.value;
  if (!target) return;
  if (none) {
    lastFill.value = target.style.fill === "none" ? lastFill.value : target.style.fill;
    store.commit("修改填充", () => {
      target.style.fill = "none";
    });
  } else {
    store.commit("修改填充", () => {
      target.style.fill = lastFill.value;
    });
  }
}

// ---------------------------------------------------------------------------
// 图片填充：本地面板选图 → data URL 内嵌文档（导出 .svg / 分享页随之自包含）
// ---------------------------------------------------------------------------

/** data URL 体积上限（文档 JSON 与导出 .svg 都会带上它，太大文件会失控） */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const hasImgFill = computed(() => !!el.value?.style.fillImage);

const imgInput = ref<HTMLInputElement | null>(null);

function pickImage(): void {
  imgInput.value?.click();
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** 原始像素尺寸（tile 铺贴尺寸依据；读不出时留空，渲染按 64px 兜底） */
function naturalSize(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => resolve({ w: 0, h: 0 });
    im.src = src;
  });
}

async function onImgPicked(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // 清掉选择记录：同一张图可重复选
  const t = el.value;
  if (!file || !t) return;
  if (!file.type.startsWith("image/")) {
    store.showNotice("请选择图片文件", "warn");
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    store.showNotice(`图片过大（${(file.size / 1024 / 1024).toFixed(1)}MB），请压缩到 5MB 内`, "warn");
    return;
  }
  try {
    const url = await readAsDataUrl(file);
    const size = await naturalSize(url);
    store.commit("设置图片填充", () => {
      t.style.fillImage = url;
      t.style.fillFit = t.style.fillFit ?? "cover";
      if (size.w > 0 && size.h > 0) {
        t.style.fillImgW = size.w;
        t.style.fillImgH = size.h;
      }
    });
  } catch {
    store.showNotice("读取图片失败", "err");
  }
}

function onImgFit(ev: Event): void {
  const t = el.value;
  if (!t) return;
  const fit = (ev.target as HTMLSelectElement).value as SvgFillFit;
  store.commit("修改图片适配", () => {
    t.style.fillFit = fit;
  });
}

function clearImgFill(): void {
  const t = el.value;
  if (!t?.style.fillImage) return;
  store.commit("移除图片填充", () => {
    clearImgFields(t);
  });
}

/** 描边编辑：直接作用于选中元素（开关由「无」勾选框负责） */
function editStroke(apply: (t: SvgEl) => void): void {
  store.transact(() => {
    const t = el.value;
    if (!t) return;
    apply(t);
  });
}

function onStrokeWidth(v: number): void {
  editStroke((t) => {
    t.style.strokeWidth = Math.max(0, v);
  });
}

function onStrokeDash(v: number): void {
  editStroke((t) => {
    t.style.dash = Math.max(0, v);
  });
}

/** 描边开关：勾选 = 无描边；取消勾选 = 以上次描边色恢复 */
function toggleStroke(ev: Event): void {
  const none = (ev.target as HTMLInputElement).checked;
  const target = el.value;
  if (!target) return;
  if (none) {
    lastStrokeColor.value = target.style.stroke === "none" ? lastStrokeColor.value : target.style.stroke;
    store.commit("修改描边", () => {
      target.style.stroke = "none";
    });
  } else {
    store.commit("修改描边", () => {
      target.style.stroke = lastStrokeColor.value || DEFAULT_STROKE;
      if (target.style.strokeWidth <= 0) target.style.strokeWidth = 2;
    });
  }
}

function onStrokeColor(color: string): void {
  editStroke((t) => {
    t.style.stroke = color;
  });
}

function setLayer(ev: Event): void {
  const target = el.value;
  if (!target) return;
  const layerId = (ev.target as HTMLSelectElement).value;
  store.commit("移动到图层", () => {
    target.layerId = layerId;
  });
  store.selectEl(target.id);
}

/** 不透明度滑杆（ui-kit Slider）：连续拖动折叠历史，change（松开）落历史 */
function onOpacityInput(v: number): void {
  store.transact(() => {
    const target = el.value;
    if (target) target.style.opacity = Math.min(1, Math.max(0, v / 100));
  });
}

const hasFill = computed(() => !!el.value && el.value.style.fill !== "none");
const hasStroke = computed(() => !!el.value && el.value.style.stroke !== "none");
/** 上次非空描边色（勾选「无描边」前记住，取消勾选时恢复） */
const lastStrokeColor = ref(DEFAULT_STROKE);
</script>

<template>
  <div class="sv-panel">
    <div class="sv-panel-head">
      <span class="sv-panel-title">属性</span>
      <span v-if="el" class="sv-kind-label">{{ KIND_LABEL[el.kind] ?? el.kind }}</span>
    </div>

    <div v-if="!el" class="sv-panel-empty">在画布上选中一个元素后编辑属性</div>

    <div v-else class="sv-props">
      <!-- 文本内容 -->
      <template v-if="el.kind === 'text'">
        <label class="sv-field sv-field-wide">
          <span>内容</span>
          <span class="sv-text-wrap">
            <textarea
              rows="3"
              spellcheck="false"
              aria-label="文本内容"
              :value="el.text"
              @input="onTextInput($event)"
              @change="store.settle('修改文本')"
            ></textarea>
            <span class="sv-syntax-hint">
              语法：[b]加粗[/b] [i]斜体[/i] [u]下划线[/u] [color=#ff5577]文字色[/color]
            </span>
          </span>
        </label>
        <label class="sv-field sv-field-wide">
          <span>字形</span>
          <ComboBox
            :model-value="el.style.fontFamily"
            :options="FONT_OPTIONS"
            placeholder="字体名称；留空 = 系统默认"
            @update:model-value="onFontCommit"
          />
        </label>
        <label class="sv-field">
          <span>字号</span>
          <input
            type="number"
            min="4"
            :value="el.style.fontSize"
            v-bind="numInput((v) => (el!.style.fontSize = Math.max(4, v)))"
          />
        </label>
        <label class="sv-field sv-field-wide">
          <span>对齐</span>
          <select
            :value="el.style.textAlign"
            @change="store.commit('修改对齐', () => (el!.style.textAlign = ($event.target as HTMLSelectElement).value as SvgTextAlign))"
          >
            <option value="left">居左</option>
            <option value="center">居中</option>
            <option value="right">居右</option>
          </select>
        </label>
      </template>

      <!-- 位置 / 尺寸 -->
      <template v-if="el.kind === 'rect' || el.kind === 'ellipse' || el.kind === 'text'">
        <label class="sv-field">
          <span>X</span>
          <input type="number" :value="r3v(el.x)" v-bind="numInput((v) => (el!.x = r3(v)))" />
        </label>
        <label class="sv-field">
          <span>Y</span>
          <input type="number" :value="r3v(el.y)" v-bind="numInput((v) => (el!.y = r3(v)))" />
        </label>
      </template>
      <template v-if="el.kind === 'rect' || el.kind === 'ellipse'">
        <label class="sv-field">
          <span>宽</span>
          <input type="number" min="1" :value="r3v(el.w)" v-bind="numInput((v) => (el!.w = Math.max(1, r3(v))))" />
        </label>
        <label class="sv-field">
          <span>高</span>
          <input type="number" min="1" :value="r3v(el.h)" v-bind="numInput((v) => (el!.h = Math.max(1, r3(v))))" />
        </label>
      </template>
      <template v-if="el.kind === 'line'">
        <label class="sv-field">
          <span>起点 X</span>
          <input type="number" :value="r3v(el.x1)" v-bind="numInput((v) => (el!.x1 = r3(v)))" />
        </label>
        <label class="sv-field">
          <span>起点 Y</span>
          <input type="number" :value="r3v(el.y1)" v-bind="numInput((v) => (el!.y1 = r3(v)))" />
        </label>
        <label class="sv-field">
          <span>终点 X</span>
          <input type="number" :value="r3v(el.x2)" v-bind="numInput((v) => (el!.x2 = r3(v)))" />
        </label>
        <label class="sv-field">
          <span>终点 Y</span>
          <input type="number" :value="r3v(el.y2)" v-bind="numInput((v) => (el!.y2 = r3(v)))" />
        </label>
      </template>

      <!-- 填充：颜色（「无」只关掉颜色）+ 图片（按钮选图，有图时缩略图提示） -->
      <template v-if="el.kind !== 'line' && el.kind !== 'pencil'">
        <label class="sv-field sv-field-wide">
          <span>填充</span>
          <span class="sv-inline">
            <label class="sv-check" title="无颜色填充">
              <input type="checkbox" :checked="!hasFill" @change="fillNone" /> 无
            </label>
            <input
              v-if="hasFill"
              type="color"
              :value="el.style.fill"
              title="填充色（图片填充时为衬底色）"
              @input="store.transact(() => (el!.style.fill = ($event.target as HTMLInputElement).value))"
              @change="store.settle('修改填充')"
            />
            <button
              type="button"
              class="sv-img-btn"
              :class="{ active: hasImgFill }"
              title="图片填充：选一张图片填进形状"
              @click="pickImage"
            >
              <span
                v-if="hasImgFill"
                class="sv-img-thumb"
                :style="{ backgroundImage: `url(${el.style.fillImage})` }"
              ></span>
              <svg
                v-else
                viewBox="0 0 24 24" width="14" height="14" fill="none"
                stroke="currentColor" stroke-width="1.8"
                stroke-linecap="round" stroke-linejoin="round"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="M21 15l-5-5L5 21" />
              </svg>
            </button>
          </span>
        </label>
        <!-- 图片填充的适配方式与移除（隐藏的文件选择框放在字段外，避免 label 联动） -->
        <label v-if="hasImgFill" class="sv-field sv-field-wide" title="图片铺进形状的方式">
          <span>图片</span>
          <span class="sv-inline">
            <select :value="el.style.fillFit ?? 'cover'" @change="onImgFit">
              <option value="cover">填满（裁齐）</option>
              <option value="contain">适应（留白）</option>
              <option value="stretch">拉伸（变形）</option>
              <option value="tile">平铺</option>
            </select>
            <button type="button" class="sv-btn" title="移除图片填充" @click="clearImgFill">移除</button>
          </span>
        </label>
        <input ref="imgInput" type="file" accept="image/*" class="sv-img-input" @change="onImgPicked" />
      </template>

      <!-- 描边（勾选「无」= 无描边；宽度/虚线仅在描边启用时显示并直接生效）
           文本也可描边：文字用描边勾勒字形轮廓，线宽/虚线同样生效 -->
      <label class="sv-field sv-field-wide">
        <span>描边</span>
        <span class="sv-inline">
          <label class="sv-check" title="无描边">
            <input type="checkbox" :checked="!hasStroke" @change="toggleStroke" /> 无
          </label>
          <input
            v-if="hasStroke"
            type="color"
            :value="el.style.stroke"
            title="描边颜色"
            @input="onStrokeColor(($event.target as HTMLInputElement).value)"
            @change="store.settle('修改描边')"
          />
          <input
            v-if="hasStroke"
            class="sv-num-s"
            type="number"
            min="0"
            step="0.5"
            :value="r3v(el.style.strokeWidth)"
            title="描边宽度"
            v-bind="numInput(onStrokeWidth)"
          />
          <input
            v-if="hasStroke"
            class="sv-num-s"
            type="number"
            min="0"
            step="1"
            :value="r3v(el.style.dash)"
            title="虚线段长（0 = 实线）"
            v-bind="numInput(onStrokeDash)"
          />
        </span>
      </label>

      <!-- 不透明度（ui-kit Slider） -->
      <label class="sv-field sv-field-wide">
        <span>不透明度</span>
        <span class="sv-inline">
          <Slider
            class="sv-opacity-slider"
            :model-value="Math.round((el?.style.opacity ?? 1) * 100)"
            :min="0"
            :max="100"
            :step="1"
            title="元素不透明度（%）"
            @update:model-value="onOpacityInput"
            @change="store.settle('修改不透明度')"
          />
          <span class="sv-range-val">{{ Math.round(el.style.opacity * 100) }}%</span>
        </span>
      </label>

      <!-- 图层归属 -->
      <label class="sv-field sv-field-wide">
        <span>图层</span>
        <select :value="el.layerId" @change="setLayer">
          <option v-for="l in store.state.doc.layers" :key="l.id" :value="l.id">{{ l.name }}</option>
        </select>
      </label>

      <!-- 顺序 / 删除 -->
      <div class="sv-prop-actions">
        <button class="sv-btn" title="上移一层（图层内）" @click="store.bringForward(el.id)">上移一层</button>
        <button class="sv-btn" title="下移一层（图层内）" @click="store.sendBackward(el.id)">下移一层</button>
        <button class="sv-btn sv-danger" title="删除元素（Delete）" @click="store.deleteSelected()">删除</button>
      </div>
    </div>
  </div>
</template>
