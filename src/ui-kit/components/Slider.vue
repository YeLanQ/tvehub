<script setup lang="ts">
import { computed } from "vue";
import "../styles/components/slider.scss";

const props = withDefaults(
  defineProps<{
    modelValue: number;
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
  }>(),
  {
    min: 0,
    max: 1,
    step: 0.01,
    disabled: false,
  },
);

const emit = defineEmits<{
  (e: "update:modelValue", value: number): void;
}>();

const fillPct = computed(() => {
  const range = props.max - props.min;
  if (range <= 0) return "0%";
  const pct = ((props.modelValue - props.min) / range) * 100;
  return `${Math.max(0, Math.min(100, pct)).toFixed(2)}%`;
});

function onInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value);
  if (Number.isFinite(v)) emit("update:modelValue", v);
}
</script>

<template>
  <input
    class="slider"
    type="range"
    :min="min"
    :max="max"
    :step="step"
    :disabled="disabled"
    :style="{ '--fill': fillPct }"
    :value="modelValue"
    @input="onInput"
  />
</template>