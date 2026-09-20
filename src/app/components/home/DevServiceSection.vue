<script setup lang="ts">
// ---------------------------------------------------------------------------
// 首页·「开发者服务」分区：控制服务器、工具权限、MCP 配置与文档入口。
// - 控制服务器（本地 TCP + MCP 端点）启停与连接信息展示；命令执行端在编辑器窗口，
//   本窗口只负责启停、端口/工具权限配置与连接信息展示（见 lib/devtools）；
// - 工具权限：每个工具可单独启用/禁用（关闭后对 TCP 与 MCP 同时生效）；
// - MCP 服务：端点与配置 JSON 展示，点击复制（复制提示条在 HomeView 根级）；
// - 文档与资源：内嵌文档查看器（弹层在 HomeView 根级）与外链入口；
// 状态同步（控制服务器状态 / 工具权限）在首页窗口挂载时完成，见 HomeView。
// ---------------------------------------------------------------------------
import { computed, ref } from "vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "../../../lib/tauri-env";
import {
  devtools,
  setDevToolsPort,
  setToolEnabled,
  enabledMcpTools,
  sanitizeMcpName,
} from "../../lib/devtools/state";
import { startDevTools, stopDevTools } from "../../lib/devtools";
import { toastWarn, toastErr } from "../../lib/toast";
import {
  groupDevToolsTools,
  mcpEndpointOf,
  mcpStdioCommandOf,
  mcpConfigJson,
  mcpStdioConfigJson,
} from "../../lib/devtools/devtools-format";

const emit = defineEmits<{
  /** 打开内嵌文档查看器（弹层挂在 HomeView 根级，与确认框同级） */
  openDocs: [hash: string];
  /** 复制成功（提示条挂在 HomeView 根级，2 秒后消失） */
  copied: [];
}>();

/** 运行环境标记（开发者服务页控制服务器等功能开关用） */
const inTauri = isTauri();

/** 开发文档外链（开发者服务页展示） */
const DOC_LINKS = [
  {
    name: "TypeScript 手册",
    desc: "脚本与插件开发的语言参考",
    url: "https://www.typescriptlang.org/docs/",
  },
];

/**
 * 文档入口（静态 docs 网页，public/docs）：桌面端开全局单例文档窗口，
 * 浏览器直开回退应用内弹层（HomeView 决定）。hash 为文档路径（public/docs
 * 相对路径，去 .md 扩展名）。
 */
const DOC_PAGES = [
  {
    name: "编辑器文档",
    desc: "场景编辑、资产、动画、脚本、预览与构建等使用手册",
    hash: "editor/overview",
  },
  {
    name: "SDK 文档",
    desc: "tve 脚本 API：组件生命周期、装饰器、engine 接口",
    hash: "sdk/overview",
  },
];

/** 打开内嵌文档（弹层在 HomeView；此处只发请求事件） */
function openDocsViewer(hash: string): void {
  emit("openDocs", hash);
}

// ---------------------------------------------------------------------------
// 开发者服务：控制服务器与开发文档入口
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 开发者服务·控制服务器：本地 TCP（换行分隔 JSON）+ MCP 端点。
// 命令由编辑器窗口执行；本窗口只负责启停、端口/权限配置与连接信息展示。
// ---------------------------------------------------------------------------

/** 启停进行中标记 */
const devSvcBusy = ref(false);
/** 工具权限按分组展示 */
const groupedDevTools = computed(() => groupDevToolsTools(devtools.tools));
/** MCP 已暴露工具（按权限过滤 + MCP 合法名） */
const enabledMcpToolsList = computed(() =>
  enabledMcpTools().map((t) => ({ ...t, mcpName: sanitizeMcpName(t.name) })),
);
const mcpEndpoint = computed(() => mcpEndpointOf(devtools.info, devtools.port));
const mcpStdioCommand = computed(() => mcpStdioCommandOf(devtools.info));
const mcpConfig = computed(() => mcpConfigJson(mcpEndpoint.value));
const mcpStdioConfig = computed(() => mcpStdioConfigJson(mcpStdioCommand.value, devtools.port));

/** 启用/停用本地控制服务器（复选框；执行端在编辑器窗口，启停命令全局生效） */
async function toggleDevService(e: Event): Promise<void> {
  const on = (e.target as HTMLInputElement).checked;
  if (!inTauri) {
    (e.target as HTMLInputElement).checked = false;
    toastWarn("开发者服务控制服务器仅桌面端可用");
    return;
  }
  devSvcBusy.value = true;
  try {
    if (on) await startDevTools();
    else await stopDevTools();
  } catch (err) {
    devtools.enabled = false;
    toastErr(`开发者服务启动失败：${err}`);
  } finally {
    devSvcBusy.value = false;
  }
}

/** 复制端点/配置文本（复制成功提示条在 HomeView 根级） */
async function copyDevToolsText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    emit("copied");
  } catch (e) {
    console.error("复制失败:", e);
  }
}

/** 打开开发文档外链（Tauri 内走 opener 插件，浏览器环境回退新标签页） */
async function openDocLink(url: string) {
  try {
    if (inTauri) await openUrl(url);
    else window.open(url, "_blank", "noopener");
  } catch (e) {
    console.error("打开链接失败:", e);
  }
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <h2>开发者服务</h2>
        <p class="sub">调试工具与开发文档</p>
      </div>
    </div>

    <!-- 控制服务器：本地 TCP + MCP 端点（外部工具远程操控编辑器） -->
    <div class="settings-card">
      <h3>控制服务器</h3>
      <template v-if="inTauri">
        <div class="devtools-controls">
          <div class="devtools-field">
            <input
              id="dev-svc-toggle"
              type="checkbox"
              :checked="devtools.enabled"
              :disabled="devSvcBusy"
              @change="toggleDevService"
            />
            <label for="dev-svc-toggle">启用服务</label>
          </div>
          <div class="devtools-field">
            <label for="dev-svc-port">固定端口</label>
            <input
              id="dev-svc-port"
              class="devtools-port"
              type="number"
              min="0"
              max="65535"
              :value="devtools.port"
              @change="
                setDevToolsPort(Number(($event.target as HTMLInputElement).value) || 0)
              "
            />
            <span class="dim">0 = 随机端口；重启服务后生效</span>
          </div>
          <span class="dim devtools-status">
            {{
              devtools.enabled && devtools.info
                ? `已启用 · ${devtools.info.url}`
                : "启用后外部工具可经本地 TCP / MCP 操控编辑器"
            }}
          </span>
        </div>
        <p v-if="devtools.error" class="devtools-err">{{ devtools.error }}</p>
        <p class="hint">
          应用启动时自动开启（默认端口 39100，被占用自动换随机端口）。
          协议：换行分隔 JSON（请求 {"id":1,"method":"editor.state","params":{}}），
          同一端口提供 MCP streamable-http 端点 /mcp。命令由编辑器窗口按下方
          「工具权限」执行；在此停用后本次运行不再自动开启。
        </p>
      </template>
      <p v-else class="hint">当前为浏览器直开环境，控制服务器不可用。</p>
    </div>

    <!-- 工具权限：每个工具可单独启用/禁用（禁用后远程调用返回错误） -->
    <div class="settings-card">
      <h3>工具权限</h3>
      <div class="devtools-groups">
        <div v-for="g in groupedDevTools" :key="g.group" class="devtools-group">
          <div class="devtools-group-title">{{ g.group }}</div>
          <label v-for="t in g.tools" :key="t.id" class="devtools-row">
            <input
              type="checkbox"
              :checked="t.enabled"
              @change="
                setToolEnabled(t.id, ($event.target as HTMLInputElement).checked)
              "
            />
            <span>{{ t.name }}</span>
          </label>
        </div>
      </div>
      <p class="hint">关闭的工具对 TCP 与 MCP 同时生效；MCP 只暴露已启用的工具。</p>
    </div>

    <!-- MCP 服务：外部 AI 客户端（Claude / Cursor 等）接入配置 -->
    <div class="settings-card">
      <h3>MCP 服务</h3>
      <div class="about-row">
        <span>服务名</span>
        <span class="dim mono">tve-devtools</span>
      </div>
      <div class="about-row">
        <span>HTTP 端点</span>
        <span
          class="devtools-code mono"
          title="点击复制"
          @click="copyDevToolsText(mcpEndpoint)"
        >
          {{ mcpEndpoint }}
        </span>
      </div>
      <div class="mcp-tools">
        <div v-for="t in enabledMcpToolsList" :key="t.mcpName" class="mcp-tool">
          <span class="mono mcp-tool-name">{{ t.mcpName }}</span>
          <span class="dim mcp-tool-desc">{{ t.description }}</span>
        </div>
      </div>
      <details>
        <summary>streamable-http 配置</summary>
        <pre
          class="devtools-code mono"
          title="点击复制"
          @click="copyDevToolsText(mcpConfig)"
        >{{ mcpConfig }}</pre>
      </details>
      <details>
        <summary>stdio 配置</summary>
        <pre
          class="devtools-code mono"
          title="点击复制"
          @click="copyDevToolsText(mcpStdioConfig)"
        >{{ mcpStdioConfig }}</pre>
      </details>
    </div>

    <!-- 文档与资源 -->
    <div class="settings-card">
      <h3>文档与资源</h3>
      <div v-for="d in DOC_PAGES" :key="d.hash" class="tpl-row">
        <div class="tpl-info">
          <div class="tpl-name">{{ d.name }}</div>
          <div class="tpl-desc">{{ d.desc }}</div>
        </div>
        <button title="在文档窗口中打开" @click="openDocsViewer(d.hash)">打开</button>
      </div>
      <div v-for="d in DOC_LINKS" :key="d.url" class="tpl-row">
        <div class="tpl-info">
          <div class="tpl-name">{{ d.name }}</div>
          <div class="tpl-desc">{{ d.desc }}</div>
        </div>
        <button @click="openDocLink(d.url)">打开</button>
      </div>
    </div>
  </section>
</template>
