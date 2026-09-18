<script setup lang="ts">
// 资产面板顶部工具栏：导航（后退/前进/上级/面包屑）+ 搜索/筛选/排序 + 视图切换 + 导入/刷新。
// 只做展示与事件透传，状态与行为由 AssetsPanel 持有（v-model / 事件双向）。
import {
  ASSET_TYPE_FILTERS as TYPE_FILTERS,
} from "../lib/asset-browser";

interface Crumb {
  name: string;
  path: string;
}

defineProps<{
  backEnabled: boolean;
  forwardEnabled: boolean;
  upEnabled: boolean;
  crumbs: Crumb[];
  query: string;
  typeFilter: string;
  sortBy: string;
  viewMode: "grid" | "list";
  /** 当前目录是否允许导入（未开项目 / src / 内置只读时禁用导入按钮） */
  canImport: boolean;
  /** 类型筛选下拉（缺省显示；图窗口资产面板只呈现场景，不需要类型筛选） */
  showTypeFilter?: boolean;
}>();

const emit = defineEmits<{
  (e: "back"): void;
  (e: "forward"): void;
  (e: "up"): void;
  (e: "navigate", path: string): void;
  (e: "update:query", value: string): void;
  (e: "update:typeFilter", value: string): void;
  (e: "update:sortBy", value: string): void;
  (e: "update:viewMode", value: "grid" | "list"): void;
  (e: "import"): void;
  (e: "importFolder"): void;
  (e: "refresh"): void;
}>();
</script>

<template>
  <div class="am-toolbar">
    <button class="am-btn" :disabled="!backEnabled" title="后退" @click="emit('back')">◀</button>
    <button class="am-btn" :disabled="!forwardEnabled" title="前进" @click="emit('forward')">▶</button>
    <button class="am-btn" :disabled="!upEnabled" title="上级目录" @click="emit('up')">▲</button>
    <div class="am-crumbs" title="当前目录">
      <button v-if="crumbs.length === 0" class="crumb" @click="emit('navigate', '')">根</button>
      <template v-for="(c, i) in crumbs" :key="c.path">
        <span v-if="i > 0" class="crumb-sep">▸</span>
        <button class="crumb" :class="{ cur: i === crumbs.length - 1 }" @click="emit('navigate', c.path)">
          {{ c.name }}
        </button>
      </template>
    </div>
    <span class="spacer"></span>
    <input
      class="am-search"
      type="text"
      placeholder="搜索资产…"
      title="按名称搜索（递归当前目录）"
      :value="query"
      @input="emit('update:query', ($event.target as HTMLInputElement).value)"
    />
    <select
      v-if="showTypeFilter !== false"
      class="am-select"
      title="按类型筛选"
      :value="typeFilter"
      @change="emit('update:typeFilter', ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="f in TYPE_FILTERS" :key="f.id" :value="f.id">{{ f.label }}</option>
    </select>
    <select
      class="am-select"
      title="排序"
      :value="sortBy"
      @change="emit('update:sortBy', ($event.target as HTMLSelectElement).value)"
    >
      <option value="name">按名称</option>
      <option value="type">按类型</option>
      <option value="size">按大小</option>
    </select>
    <div class="am-view-toggle" title="视图模式">
      <button
        class="am-btn"
        :class="{ on: viewMode === 'grid' }"
        title="网格视图"
        @click="emit('update:viewMode', 'grid')"
      >▦</button>
      <button
        class="am-btn"
        :class="{ on: viewMode === 'list' }"
        title="列表视图"
        @click="emit('update:viewMode', 'list')"
      >☰</button>
    </div>
    <button
      class="am-btn"
      :disabled="!canImport"
      title="导入文件到当前目录"
      @click="emit('import')"
    >
      导入
    </button>
    <button
      class="am-btn"
      :disabled="!canImport"
      title="导入文件夹到当前目录"
      @click="emit('importFolder')"
    >
      导入目录
    </button>
    <button class="am-btn" title="刷新资产" @click="emit('refresh')">⟳</button>
  </div>
</template>
