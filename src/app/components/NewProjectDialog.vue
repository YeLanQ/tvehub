<script setup lang="ts">
import { ref } from "vue";
import { getProjectStore, type RecentProject } from "../stores/project";
import "../../styles/components/new-project-dialog.scss";

const emit = defineEmits<{
  close: [];
  created: [project: RecentProject];
}>();

const projectStore = getProjectStore();

const name = ref("NewProject");
const path = ref("");
const creating = ref(false);
const error = ref("");

async function browseFolder() {
  const folder = await projectStore.pickFolder();
  if (folder) {
    path.value = folder;
  }
}

async function handleCreate() {
  if (!name.value.trim() || !path.value) {
    error.value = "请填写项目名称并选择位置";
    return;
  }
  
  creating.value = true;
  error.value = "";
  
  const project = await projectStore.createProject(path.value, name.value.trim());
  
  creating.value = false;
  
  if (project) {
    emit("created", project);
  } else {
    error.value = "创建项目失败，请重试";
  }
}

function handleClose() {
  emit("close");
}
</script>

<template>
  <div class="dialog-overlay" @click="handleClose">
    <div class="dialog" @click.stop>
      <div class="dialog-header">
        <h3>新建项目</h3>
        <button class="close-btn" @click="handleClose">×</button>
      </div>
      
      <div class="dialog-body">
        <div class="form-group">
          <label for="project-name">项目名称</label>
          <input
            id="project-name"
            v-model="name"
            type="text"
            placeholder="输入项目名称"
            autofocus
            @keydown.enter="handleCreate"
          />
        </div>
        
        <div class="form-group">
          <label for="project-path">项目位置</label>
          <div class="path-input-row">
            <input
              id="project-path"
              v-model="path"
              type="text"
              placeholder="选择项目保存位置"
              readonly
            />
            <button class="browse-btn" @click="browseFolder">浏览</button>
          </div>
        </div>
      </div>
      
      <div v-if="error" class="error">{{ error }}</div>
      
      <div class="dialog-footer">
        <button class="cancel-btn" @click="handleClose">取消</button>
        <button
          class="create-btn"
          :disabled="!name.trim() || !path || creating"
          @click="handleCreate"
        >
          {{ creating ? "创建中..." : "创建" }}
        </button>
      </div>
    </div>
  </div>
</template>
