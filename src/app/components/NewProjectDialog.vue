<script setup lang="ts">
import { computed, ref } from "vue";
import { getProjectStore, type RecentProject } from "../stores/project";
import {
  BUILTIN_PROJECT_TEMPLATES,
  createProjectCats,
  type ProjectTemplate,
} from "../lib/project-templates";
import "../../styles/components/new-project-dialog.scss";

const emit = defineEmits<{
  close: [];
  created: [project: RecentProject];
}>();

const projectStore = getProjectStore();

/** 工程模板（内置数据驱动） */
const templates = ref<ProjectTemplate[]>(BUILTIN_PROJECT_TEMPLATES);

/** 默认类别/模板取首个内置模板，不硬编码 id */
const first = BUILTIN_PROJECT_TEMPLATES[0];
const createCat = ref(first?.kind ?? "");
const newTemplateId = ref(first?.id ?? "");

const name = ref("NewProject");
const path = ref("");
const creating = ref(false);
const error = ref("");

/** 模板类别列表（由模板动态推导） */
const catList = computed(() => createProjectCats(templates.value));

/** 当前类别下的模板卡片 */
const createCatTemplates = computed(() =>
  templates.value.filter((t) => catList.value.find((c) => c.id === createCat.value)?.match(t) ?? false),
);

/** 当前选中的模板 */
const selectedTemplate = computed(() => templates.value.find((t) => t.id === newTemplateId.value) ?? null);

function catCount(id: string): number {
  return templates.value.filter((t) => catList.value.find((c) => c.id === id)?.match(t) ?? false).length;
}

function switchCat(id: string) {
  createCat.value = id;
  const list = createCatTemplates.value;
  if (list.length > 0 && !list.some((t) => t.id === newTemplateId.value)) {
    newTemplateId.value = list[0].id;
  }
}

function selectTemplate(id: string) {
  newTemplateId.value = id;
}

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
  <div class="modal-backdrop" @click.self="handleClose">
    <div class="modal create-modal">
      <h3>新建项目</h3>
      <div class="create-body">
        <!-- 左：模板类别 -->
        <div class="create-cats">
          <button
            v-for="c in catList"
            :key="c.id"
            class="create-cat"
            :class="{ active: createCat === c.id }"
            @click="switchCat(c.id)"
          >
            <span>{{ c.label }}</span>
            <span class="dim">{{ catCount(c.id) }}</span>
          </button>
        </div>

        <!-- 中：模板卡片 -->
        <div class="create-cards">
          <button
            v-for="t in createCatTemplates"
            :key="t.id"
            class="create-card"
            :class="{ active: newTemplateId === t.id }"
            @click="selectTemplate(t.id)"
          >
            <span class="create-card-name">{{ t.name }}</span>
            <span class="dim">{{ t.builtin ? "内置" : "自定义" }}</span>
          </button>
          <p v-if="createCatTemplates.length === 0" class="create-cards-empty">该类别暂无模板</p>
        </div>

        <!-- 右：模板信息 + 表单 -->
        <div class="create-info">
          <div v-if="selectedTemplate" class="create-info-head">
            <div class="create-info-name">{{ selectedTemplate.name }}</div>
            <div class="dim">{{ selectedTemplate.builtin ? "内置模板" : "自定义模板" }}</div>
            <p class="sub">{{ selectedTemplate.description }}</p>
          </div>
          <div class="create-form">
            <div class="row">
              <label>项目名称</label>
              <input v-model="name" placeholder="如 MyGame" autofocus />
            </div>
          </div>
        </div>
      </div>

      <!-- 底部：位置行（全宽，位于下方） -->
      <div class="create-location">
        <div class="row">
          <label>位置</label>
          <input v-model="path" placeholder="选择父目录" readonly />
          <button @click="browseFolder">浏览…</button>
        </div>
        <p v-if="error" class="create-error">{{ error }}</p>
      </div>

      <div class="create-actions">
        <button @click="handleClose">取消</button>
        <button
          class="primary"
          :disabled="!name.trim() || !path || creating"
          @click="handleCreate"
        >
          {{ creating ? "创建中…" : "新建工程" }}
        </button>
      </div>
    </div>
  </div>
</template>