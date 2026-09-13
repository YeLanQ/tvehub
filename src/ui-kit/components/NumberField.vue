<script setup lang="ts">
import { ref, watch } from "vue";
import "../styles/components/number-field.scss";

const props = defineProps<{
  modelValue: number;
  title?: string;
  step?: number;
  disabled?: boolean;
  min?: number;
  max?: number;
}>();

const emit = defineEmits<{
  (e: "commit", value: number): void;
}>();

function clamp(v: number): number {
  if (typeof props.min === "number" && v < props.min) return props.min;
  if (typeof props.max === "number" && v > props.max) return props.max;
  return v;
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return String(parseFloat(v.toPrecision(8)));
}

const text = ref(fmt(props.modelValue));
const focused = ref(false);
const dragging = ref(false);
const moved = ref(false);
let startX = 0;
let startValue = 0;

watch(
  () => props.modelValue,
  (v) => {
    if (!focused.value) text.value = fmt(v);
  },
);

function onInput(e: Event) {
  text.value = (e.target as HTMLInputElement).value;
  const v = parseFloat(text.value);
  if (Number.isFinite(v)) emit("commit", clamp(v));
}

function finish() {
  const v = parseFloat(text.value);
  if (!Number.isFinite(v)) {
    text.value = fmt(props.modelValue);
  } else {
    const c = clamp(v);
    emit("commit", c);
    text.value = fmt(c);
  }
  focused.value = false;
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    finish();
    (e.target as HTMLInputElement).blur();
  } else if (e.key === "Escape") {
    text.value = fmt(props.modelValue);
    (e.target as HTMLInputElement).blur();
  }
}

function onPointerDown(e: PointerEvent) {
  if (props.disabled || e.button !== 0) return;
  e.preventDefault();
  dragging.value = true;
  moved.value = false;
  startX = e.clientX;
  startValue = props.modelValue;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return;
  const dx = e.clientX - startX;
  if (Math.abs(dx) > 2) moved.value = true;
  const step = (props.step ?? 0.01) * (e.shiftKey ? 0.1 : 1);
  emit("commit", clamp(startValue + dx * step));
}

function endDrag(e: PointerEvent) {
  if (!dragging.value) return;
  dragging.value = false;
  try {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  if (!moved.value) {
    const el = e.currentTarget as HTMLInputElement;
    el.focus();
    el.select();
  }
}
</script>

<template>
  <input
    class="nf-input"
    :class="{ 'nf-disabled': disabled }"
    :title="disabled ? (title ?? '') : (title ? `${title} · 拖动调节(Shift 精细)/点击编辑` : '拖动调节(Shift 精细)/点击编辑')"
    :disabled="disabled"
    inputmode="decimal"
    autocomplete="off"
    spellcheck="false"
    :value="text"
    @input="onInput"
    @focus="focused = true"
    @blur="finish"
    @keydown="onKeydown"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="endDrag"
    @pointercancel="endDrag"
  />
</template>