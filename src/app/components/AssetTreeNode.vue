<script lang="ts">
import type { Ref } from "vue";
/** 资产树节点：目录面板左栏文件夹树的数据结构 */
export interface AssetNode {
  name: string;
  path: string;
  kind: string;
  size: number;
  children: AssetNode[];
}
/** 资产面板内部拖拽共享句柄：AssetsPanel provide，目录树节点 inject 作为投放目标 */
export interface AssetDragHandle {
  getPaths: () => string[] | null;
  moveToDir: (paths: string[], destDir: string) => void;
  hoverPath?: Ref<string | null>;
}
export const ASSET_DRAG_KEY: unique symbol = Symbol("asset-drag");
</script>

<script setup lang="ts">
import { computed, inject, ref } from "vue";
import { getAssetsStore } from "../stores/assets";
import {
  openContextMenu,
  menuSeparator,
  type CtxMenuItem,
} from "../../lib/editor/context-menu";
import { getProjectStore } from "../stores/project";
import { prompt } from "../lib/prompt";
import { confirm } from "../lib/confirm";

const dragHandle = inject<AssetDragHandle | null>(ASSET_DRAG_KEY, null);

const dropOver = computed(() => {
  if (props.node.kind !== "dir") return false;
  return dragHandle?.hoverPath?.value === props.node.path;
});

const props = defineProps<{
  node: AssetNode;
  depth: number;
  activePath?: string;
  foldersOnly?: boolean;
}>();
const emit = defineEmits<{ (e: "select-dir", path: string): void }>();

const open = ref(props.node.kind === "dir" && props.node.children.length > 0);

const assetsStore = getAssetsStore();
const projectStore = getProjectStore();

function projectRoot(): string | null {
  return projectStore.currentPath;
}

function click() {
  if (props.node.kind === "dir") {
    open.value = !open.value;
    emit("select-dir", props.node.path);
  } else {
    assetsStore.select(props.node.path);
  }
}

function dblclick() {
  if (props.node.kind === "dir") {
    emit("select-dir", props.node.path);
    return;
  }
}

function onContext(e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  const items: CtxMenuItem[] = [];
  if (props.node.kind === "dir") {
    items.push({
      label: open.value ? "折叠" : "展开",
      onClick: () => (open.value = !open.value),
    });
  }
  items.push(
    { label: "复制", onClick: () => void doCopy() },
    { label: "重命名", onClick: () => void doRename() },
    { label: "删除", danger: true, onClick: () => void doDelete() },
  );
  const slash = props.node.path.lastIndexOf("/");
  const parentDir =
    props.node.kind === "dir" ? props.node.path : slash > 0 ? props.node.path.slice(0, slash) : undefined;
  if (parentDir !== undefined && (parentDir === "assets" || parentDir.startsWith("assets/"))) {
    items.push(menuSeparator());
    items.push({
      label: "新建目录",
      onClick: () => void doNewFolder(parentDir),
    });
  }
  items.push(menuSeparator());
  items.push({ label: "复制路径", onClick: copyPath });
  openContextMenu(e, items);
}

async function doNewFolder(parentDir: string) {
  const root = projectRoot();
  if (!root) return;
  const name = await prompt({
    title: "新建目录",
    label: parentDir,
    initial: "NewFolder",
    confirmText: "创建",
  });
  if (!name) return;
  const rel = `${parentDir}/${name}`;
  await assetsStore.createFolder(root, rel);
}

async function doCopy() {
  const root = projectRoot();
  if (!root) return;
  await assetsStore.duplicate(root, props.node.path);
}

async function doRename() {
  const root = projectRoot();
  if (!root) return;
  const newName = await prompt({
    title: "重命名",
    label: props.node.name,
    initial: props.node.name,
    confirmText: "重命名",
  });
  if (!newName || newName === props.node.name) return;
  await assetsStore.rename(root, props.node.path, newName);
}

async function doDelete() {
  const root = projectRoot();
  if (!root) return;
  const isDir = props.node.kind === "dir";
  const ok = await confirm({
    title: "删除资产",
    message: isDir
      ? `确定删除目录“${props.node.path}”及其全部内容吗？此操作不可恢复。`
      : `确定删除资产“${props.node.path}”吗？此操作不可恢复。`,
    confirmText: "删除",
    danger: true,
  });
  if (ok) await assetsStore.remove(root, props.node.path);
}

async function copyPath() {
  try {
    await navigator.clipboard.writeText(props.node.path);
  } catch {
    /* ignore clipboard unavailable */
  }
}
</script>

<template>
  <div>
    <div
      v-if="!foldersOnly || node.kind === 'dir'"
      class="asset-row"
      :class="{
        dir: node.kind === 'dir',
        selected: node.kind !== 'dir' && assetsStore.selectedAsset === node.path,
        active: node.path === activePath,
        'drop-over': dropOver,
      }"
      :style="{ paddingLeft: 8 + depth * 16 + 'px' }"
      :data-drop-dir="node.kind === 'dir' ? node.path : undefined"
      @click="click"
      @dblclick="dblclick"
      @contextmenu.prevent.stop="onContext"
    >
      <span class="arrow">{{ node.kind === "dir" ? (open ? "▾" : "▸") : "" }}</span>
      <span class="name">{{ node.name }}</span>
    </div>
    <template v-if="node.kind === 'dir' && open">
      <AssetTreeNode
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        :folders-only="foldersOnly"
        :active-path="activePath"
        @select-dir="(p: string) => emit('select-dir', p)"
      />
    </template>
  </div>
</template>

<style scoped>
.asset-row {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  cursor: pointer;
  white-space: nowrap;
  border-left: 2px solid transparent;
}
.asset-row:hover {
  background: var(--bg-hover);
}
.asset-row.selected {
  background: var(--bg-active);
  border-left-color: var(--accent);
}
.asset-row.active {
  color: var(--accent);
  border-left-color: var(--accent);
}
.asset-row.drop-over {
  background: var(--bg-active);
  outline: 1px dashed var(--accent);
  outline-offset: -1px;
}
.arrow {
  width: 12px;
  color: var(--text-dim);
  font-size: 11px;
  flex-shrink: 0;
}
.name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
