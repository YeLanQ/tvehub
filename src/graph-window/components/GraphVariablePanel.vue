<script setup lang="ts">
/**
 * 图变量面板：管理图级变量（具名数据槽，var.get/var.set 节点引用）。
 * 添加 / 重命名 / 删除 / 改类型 / 改初始值。
 * 变量随图会话自动持久化（sidecar .tve 旁路）。
 */
import { ref } from "vue";
import { getGraphWindowStore } from "../graphStore";
import { G_DATA_TYPE_LABEL, type GVarDataType } from "../../framework/graph";

const store = getGraphWindowStore();

const editingName = ref<string | null>(null);
const editingValue = ref<string>("");

function startRename(id: string, name: string): void {
  editingName.value = id;
  editingValue.value = name;
}

function commitRename(id: string): void {
  if (editingName.value === id) {
    store.renameVariable(id, editingValue.value);
  }
  editingName.value = null;
}


const typeOptions: GVarDataType[] = ["number", "boolean", "string"];
</script>

<template>
  <div class="gvar-panel">
    <div class="gvar-head">
      <span class="gvar-title">变量</span>
      <button class="gvar-add" title="添加变量" @click="store.addVariable()">+</button>
    </div>
    <div v-if="!store.graphVariables.length" class="gvar-empty">
      暂无变量。点击 + 添加图变量，供 var.get/var.set 节点引用。
    </div>
    <div v-for="v in store.graphVariables" :key="v.id" class="gvar-row">
      <template v-if="editingName === v.id">
        <input
          class="gvar-name-input"
          :value="editingValue"
          @change="commitRename(v.id)"
          @blur="commitRename(v.id)"
          @keydown.enter="($event.target as HTMLInputElement).blur()"
        />
      </template>
      <template v-else>
        <span class="gvar-name" :title="v.name" @dblclick="startRename(v.id, v.name)">{{ v.name }}</span>
      </template>
      <select
        class="gvar-type"
        :value="v.dataType"
        @change="store.setVariableType(v.id, ($event.target as HTMLSelectElement).value as GVarDataType)"
      >
        <option v-for="t in typeOptions" :key="t" :value="t">{{ G_DATA_TYPE_LABEL[t] }}</option>
      </select>
      <input
        v-if="v.dataType === 'number'"
        class="gvar-value"
        type="number"
        step="0.1"
        :value="v.value as number"
        @change="store.setVariableValue(v.id, Number(($event.target as HTMLInputElement).value) || 0)"
      />
      <select
        v-else-if="v.dataType === 'boolean'"
        class="gvar-value"
        :value="String(v.value)"
        @change="store.setVariableValue(v.id, ($event.target as HTMLSelectElement).value === 'true')"
      >
        <option value="false">假</option>
        <option value="true">真</option>
      </select>
      <input
        v-else
        class="gvar-value"
        type="text"
        :value="v.value as string"
        @change="store.setVariableValue(v.id, ($event.target as HTMLInputElement).value)"
      />
      <button class="gvar-del" title="删除变量" @click="store.deleteVariable(v.id)">×</button>
    </div>
  </div>
</template>