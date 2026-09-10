<script setup lang="ts">
// ---------------------------------------------------------------------------
// 首页·「创意工坊」分区：资源仓库（public/repos）两栏工作台。
// - 左标签栏 = 仓库分类（目录即分类），右内容栏 = 选中分类的文件清单；
// - 原型分类（code/effect）可在工坊里增删改：表单落盘扩展名取当前分类，
//   保存后整表覆写到后端分类目录并刷新；删除走系统确认框；
// - 只读分类仅在文件管理器中打开目录（浏览器直开环境不可用，见 isTauri）；
// 仓库读写动作见 lib/repos（与后端 repos.rs 同规则），本组件只持有浏览/表单状态。
// ---------------------------------------------------------------------------
import { computed, onMounted, reactive, ref } from "vue";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { confirm } from "../../lib/confirm";
import { isTauri } from "../../../lib/tauri-env";
import {
  cachedRepoCategories,
  deleteRepoFile,
  formatRepoSize,
  listRepoCategories,
  loadRepoCategoryTexts,
  writeRepoFile,
  type RepoCategory,
  type RepoFile,
} from "../../lib/repos";

/** 运行环境标记（浏览器直开环境读不到仓库目录，「打开目录」也仅桌面端可用） */
const inTauri = isTauri();

// 创意工坊：资源仓库（public/repos 下的分类目录；左标签栏切换分类，右内容栏展示）
// 初始值取模块级缓存（首次进入应用时已扫描过）：分区重挂载先出内容，再后台刷新
const repoCategories = ref<RepoCategory[]>(cachedRepoCategories() ?? []);
/** 当前分类 id（默认第一个：code 脚本原型） */
const activeCategoryId = ref(repoCategories.value.find((c) => c.id === "code")?.id ?? "");
/** 分类文本内容加载中（选中分类后按需读取文本文件） */
const repoLoading = ref(false);

/** 当前分类（无分类时 null） */
const activeCategory = computed<RepoCategory | null>(
  () => repoCategories.value.find((c) => c.id === activeCategoryId.value) ?? null,
);
/** 当前分类的文件清单 */
const activeFiles = computed(() => activeCategory.value?.files ?? []);
/** 当前分类的新原型扩展名（null = 只读浏览分类） */
const activePrototypeExt = computed(() => activeCategory.value?.prototypeExt ?? null);
/** 当前分类是否支持在工坊里增删改原型（code/effect 等原型分类） */
const canEditActiveCategory = computed(() => activePrototypeExt.value !== null);
/** 当前分类是否为脚本原型（表单提示按扩展名区分：脚本可用 {{CLASS_NAME}}） */
const isScriptCategory = computed(() => activePrototypeExt.value === "ts");

/** 表单文案（按分类扩展名自适应） */
const protoFormText = computed(() =>
  isScriptCategory.value
    ? {
        namePlaceholder: "旋转脚本",
        codeHint: "代码（支持 {{CLASS_NAME}} 占位符，创建脚本时替换为脚本类名）",
        codePlaceholder: "// @desc 描述会自动写在首行\nimport { Component, property } from \"tve\";",
      }
    : {
        namePlaceholder: "全息效果",
        codeHint: "着色器源码（自定义着色器：Properties + CGINCLUDE + 两个 CGPROGRAM 块）",
        codePlaceholder:
          "// @desc 描述会自动写在首行\nShader \"effect/MyEffect\"\n{\n    Properties { _Color (\"Color\", Color) = (1, 1, 1, 1) }\n}",
      },
);

/** 刷新仓库分类清单（public/repos/*，元信息） */
async function refreshRepos(): Promise<void> {
  repoCategories.value = await listRepoCategories();
  const ids = repoCategories.value.map((c) => c.id);
  if (!ids.includes(activeCategoryId.value)) {
    activeCategoryId.value = ids.includes("code") ? "code" : (ids[0] ?? "");
  }
  await loadActiveFiles();
}

/** 读取当前分类的文本文件内容（二进制跳过；重复切换命中缓存不重复读盘） */
async function loadActiveFiles(): Promise<void> {
  const cat = activeCategory.value;
  if (!cat) return;
  if (cat.files.every((f) => !f.text || f.code)) return;
  repoLoading.value = true;
  try {
    const loaded = await loadRepoCategoryTexts(cat);
    repoCategories.value = repoCategories.value.map((c) => (c.id === cat.id ? loaded : c));
  } finally {
    repoLoading.value = false;
  }
}

/** 切换分类（表单为显式保存，切换即关闭） */
async function selectCategory(id: string): Promise<void> {
  if (id === activeCategoryId.value) return;
  activeCategoryId.value = id;
  protoForm.open = false;
  await loadActiveFiles();
}

// 原型编辑表单（脚本原型 / 效果原型共用：落盘扩展名取当前分类，见 repos.ts 的 PROTOTYPE_EXTS）
const protoForm = reactive({ open: false, editingId: "", name: "", description: "", code: "" });

/** 打开添加/编辑表单（p 为被编辑的文件；缺省 = 新增） */
function openProtoForm(p?: RepoFile): void {
  protoForm.open = true;
  protoForm.editingId = p?.file ?? "";
  protoForm.name = p?.name ?? "";
  protoForm.description = p?.description ?? "";
  protoForm.code = p?.code ?? "";
}

/** 保存表单（新增或编辑；整表覆写到后端分类目录） */
async function saveProtoForm(): Promise<void> {
  const cat = activeCategory.value;
  const ext = activePrototypeExt.value;
  if (!cat || !ext) return;
  const name = protoForm.name.trim();
  if (!name) {
    alert("请填写原型名称");
    return;
  }
  if (!protoForm.code.trim()) {
    alert("请填写原型内容（脚本可用 {{CLASS_NAME}} 占位符）");
    return;
  }
  const file = `${name}.${ext}`;
  try {
    // 一个原型一个独立文件：public/repos/<分类>/<名称>.<扩展名>
    await writeRepoFile(cat.id, file, protoForm.description.trim(), protoForm.code);
    // 编辑时改名 = 另存新文件 + 删除旧文件
    if (protoForm.editingId && protoForm.editingId !== file) {
      await deleteRepoFile(cat.id, protoForm.editingId);
    }
  } catch (e) {
    alert(`保存失败：${e}`);
    return;
  }
  protoForm.open = false;
  await refreshRepos();
}

/** 删除原型（删除对应 public/repos/<分类>/ 下的文件） */
async function removeProtoFile(f: RepoFile): Promise<void> {
  const cat = activeCategory.value;
  if (!cat) return;
  if (
    !(await confirm({
      title: "删除原型",
      message: `确定删除原型「${f.name}」？将删除文件 ${cat.id}/${f.file}`,
      confirmText: "删除",
      danger: true,
    }))
  ) {
    return;
  }
  try {
    await deleteRepoFile(cat.id, f.file);
  } catch (e) {
    alert(`删除失败：${e}`);
    return;
  }
  await refreshRepos();
}

/** 在系统文件管理器中打开分类目录（直接往里放文件后「刷新」即可） */
async function openCategoryDir(): Promise<void> {
  const cat = activeCategory.value;
  if (!cat?.dir) return;
  try {
    await revealItemInDir(cat.dir);
  } catch (e) {
    alert(`打开目录失败：${e}`);
  }
}

onMounted(() => {
  // 打开分区即读取仓库分类（读取期间内容栏显示加载态）
  void refreshRepos();
});
</script>

<template>
  <section class="page workshop-page">
    <div class="page-head">
      <div>
        <h2>创意工坊</h2>
        <p class="sub">资源仓库：public/repos 下的分类目录（目录即分类，标签名与目录名一致）</p>
      </div>
      <div class="head-actions">
        <button :disabled="repoLoading" @click="refreshRepos">
          {{ repoLoading ? "读取中…" : "刷新" }}
        </button>
        <button v-if="canEditActiveCategory" class="primary" @click="openProtoForm()">
          添加原型
        </button>
      </div>
    </div>

    <!-- 两栏：左标签栏（仓库分类）/ 右内容栏（选中分类的文件） -->
    <div class="workshop-layout">
      <nav class="workshop-tabs">
        <button
          v-for="c in repoCategories"
          :key="c.id"
          class="workshop-tab"
          :class="{ active: c.id === activeCategoryId }"
          :title="c.dir"
          @click="selectCategory(c.id)"
        >
          <span class="ws-tab-name">{{ c.label }}</span>
          <span class="ws-tab-count">{{ c.files.length }}</span>
        </button>
        <div v-if="repoCategories.length === 0" class="ws-tabs-empty">
          暂无分类
        </div>
      </nav>

      <div class="workshop-content">
        <template v-if="activeCategory">
          <div class="workshop-content-head">
            <div>
              <h3>{{ activeCategory.label }}</h3>
              <p class="sub">
                {{ activeCategory.hint }} · {{ activeFiles.length }} 个文件
              </p>
            </div>
            <div class="head-actions">
              <button
                :disabled="!inTauri"
                title="在系统文件管理器中打开该分类目录（放入文件后点「刷新」即可显示）"
                @click="openCategoryDir"
              >
                打开目录
              </button>
            </div>
          </div>

          <!-- 原型表单（原型分类可增删改；表单提示按分类扩展名自适应） -->
          <div v-if="protoForm.open && canEditActiveCategory" class="settings-card proto-form">
            <h3>
              {{ protoForm.editingId ? "编辑原型" : "添加原型" }}
              <span class="dim">
                （{{ activeCategory.id }}/{{ protoForm.name.trim() || "名称" }}.{{ activePrototypeExt }}）
              </span>
            </h3>
            <div class="proto-field">
              <label>名称</label>
              <input v-model="protoForm.name" :placeholder="protoFormText.namePlaceholder" />
            </div>
            <div class="proto-field">
              <label>描述</label>
              <input v-model="protoForm.description" placeholder="一句话说明用途（可选）" />
            </div>
            <div class="proto-field">
              <label>{{ protoFormText.codeHint }}</label>
              <textarea
                v-model="protoForm.code"
                rows="12"
                spellcheck="false"
                :placeholder="protoFormText.codePlaceholder"
              ></textarea>
            </div>
            <div class="proto-form-actions">
              <button @click="protoForm.open = false">取消</button>
              <button class="primary" @click="saveProtoForm">保存</button>
            </div>
          </div>

          <div v-if="activeFiles.length" class="proto-grid">
            <div v-for="f in activeFiles" :key="f.file" class="proto-card">
              <div class="proto-head">
                <span class="proto-name">{{ f.name }}</span>
                <span class="proto-file">
                  {{ f.file }}
                  <template v-if="formatRepoSize(f.size)"> · {{ formatRepoSize(f.size) }}</template>
                </span>
              </div>
              <p class="proto-desc">{{ f.description || "（无描述）" }}</p>
              <pre v-if="f.text" class="proto-code">{{ f.code || "（空内容）" }}</pre>
              <p v-else class="proto-binary">二进制文件（.{{ f.ext }}）：工坊不预览内容</p>
              <div v-if="canEditActiveCategory" class="proto-actions">
                <button @click="openProtoForm(f)">编辑</button>
                <button @click="removeProtoFile(f)">删除</button>
              </div>
            </div>
          </div>

          <div v-else class="workshop-empty">
            <p>「{{ activeCategory.label }}」分类暂无文件。</p>
            <p class="dim">
              <template v-if="canEditActiveCategory">
                点右上「添加原型」新建一个
                <span class="mono">.{{ activePrototypeExt }}</span>
                文件；也可直接放入
                <span class="mono">public/repos/{{ activeCategory.id }}/</span>
                后点「刷新」。
              </template>
              <template v-else>
                把文件放入
                <span class="mono">public/repos/{{ activeCategory.id }}/</span>
                后点「刷新」即可在此显示。
              </template>
            </p>
          </div>
        </template>
        <div v-else class="workshop-empty">
          <p>{{ inTauri ? "仓库读取中…" : "浏览器直开环境无法读取仓库目录（工坊在桌面端可用）" }}</p>
        </div>
      </div>
    </div>
  </section>
</template>
