<script setup lang="ts">
// ---------------------------------------------------------------------------
// 首页·「模板」分区：工程模板清单（只读展示）。
// 数据来自 lib/project-templates 的内置编译期注册（exe 旁自定义模板由「新建项目」
// 面板运行时合并，见 NewProjectDialog）；此处只按同一份内置清单展示名称/说明/来源。
// ---------------------------------------------------------------------------
import { ref } from "vue";
import { BUILTIN_PROJECT_TEMPLATES, type ProjectTemplate } from "../../lib/project-templates";

/** 工程模板（内置数据驱动；后续可接入后端自定义模板） */
const templates = ref<ProjectTemplate[]>(BUILTIN_PROJECT_TEMPLATES);
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <h2>模板</h2>
        <p class="sub">项目创建时使用的页面骨架</p>
      </div>
    </div>

    <div class="settings-card">
      <h3>工程模板</h3>
      <p class="sub">项目创建时使用的页面骨架（新建面板可选择）</p>
      <div v-if="templates.length === 0" class="tpl-empty">暂无工程模板。</div>
      <div v-for="t in templates" :key="t.id" class="tpl-row">
        <div class="tpl-info">
          <div class="tpl-name">{{ t.name }}</div>
          <div class="tpl-desc">{{ t.description }}</div>
        </div>
        <span class="tpl-tag">{{ t.builtin ? "内置" : "自定义" }}</span>
      </div>
    </div>
  </section>
</template>
