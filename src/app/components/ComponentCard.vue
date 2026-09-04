<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string;
    type?: string;
    open?: boolean;
  }>(),
  {
    open: false,
  },
);

const emit = defineEmits<{
  toggle: [];
}>();
</script>

<template>
  <div class="section">
    <div class="section-head" @click="emit('toggle')">
      <span class="caret">{{ open ? "▾" : "▸" }}</span>
      <span class="title">{{ title }}</span>
      <span v-if="type" class="mono comp-type">{{ type }}</span>
      <span class="spacer"></span>
      <slot name="head"></slot>
    </div>
    <div v-if="open" class="section-body">
      <slot></slot>
    </div>
  </div>
</template>