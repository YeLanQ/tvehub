<script setup lang="ts">
/**
 * 局域网服务卡：统一配置（开关/端口/绑定网卡/设备名/访问口令/开机自启）
 * + 当前访问地址与二维码。
 *
 * 交互约定：每个字段失焦或选项变更即提交补丁（后端补丁式写入，没有「保存」按钮）；
 * 端口与网卡变更会重启监听，故改动前把控件禁用一小会儿（busy）。
 */
import { computed, ref, watch } from "vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import LanQrCode from "./LanQrCode.vue";
import {
  lanShare,
  patchLanShareConfig,
  primaryUrl,
  setLanShareEnabled,
  humanSize,
} from "../../lib/lan-share";
import { toastErr, toastOk } from "../../lib/toast";
import { isTauri } from "../../../lib/tauri-env";
import "../../../styles/components/lan-service.scss";

const config = computed(() => lanShare.status?.config ?? null);
const running = computed(() => lanShare.status?.running ?? false);
const notice = computed(() => lanShare.status?.notice ?? "");
const urls = computed(() => lanShare.status?.urls ?? []);
const primary = computed(() => primaryUrl(lanShare.status));

/** 地址下拉：空值 = 绑定全部网卡（自动挑选对外地址） */
const hostOptions = computed(() => {
  const list = urls.value.map((u) => ({
    value: u.ip,
    label: `${u.ip}${u.private ? "（内网）" : ""}${u.primary ? " · 推荐" : ""}`,
  }));
  return [{ value: "", label: "全部网卡（自动选择地址）" }, ...list];
});

// 本地编辑态：端口/设备名/口令在输入过程中不提交，失焦或回车才写回
const portDraft = ref("");
const nameDraft = ref("");
const codeDraft = ref("");

watch(
  () => [config.value?.port, config.value?.deviceName, config.value?.accessCode],
  () => {
    portDraft.value = String(config.value?.port ?? "");
    nameDraft.value = config.value?.deviceName ?? "";
    codeDraft.value = config.value?.accessCode ?? "";
  },
  { immediate: true },
);

const totalSize = computed(() => (lanShare.status?.shares ?? []).reduce((n, s) => n + s.size, 0));

async function patch(patchObj: Parameters<typeof patchLanShareConfig>[0]): Promise<void> {
  try {
    await patchLanShareConfig(patchObj);
  } catch (e) {
    toastErr(`设置失败：${e}`);
  }
}

async function toggleService(e: Event): Promise<void> {
  const on = (e.target as HTMLInputElement).checked;
  try {
    await setLanShareEnabled(on);
    toastOk(on ? "共享已开启" : "共享已关闭");
  } catch (err) {
    toastErr(`操作失败：${err}`);
  }
}

function commitPort(): void {
  const next = Number.parseInt(portDraft.value, 10);
  if (!Number.isFinite(next) || next === config.value?.port) {
    portDraft.value = String(config.value?.port ?? "");
    return;
  }
  void patch({ port: next });
}

function commitName(): void {
  const next = nameDraft.value.trim();
  if (!next || next === config.value?.deviceName) {
    nameDraft.value = config.value?.deviceName ?? "";
    return;
  }
  void patch({ deviceName: next });
}

function commitCode(): void {
  const next = codeDraft.value.trim();
  if (next === (config.value?.accessCode ?? "")) return;
  void patch({ accessCode: next });
}

async function openInBrowser(url: string): Promise<void> {
  try {
    if (isTauri()) await openUrl(url);
    else window.open(url, "_blank", "noopener");
  } catch (e) {
    toastErr(`打开失败：${e}`);
  }
}
</script>

<template>
  <section class="lan-card">
    <header class="lan-card-head">
      <div>
        <h3>共享</h3>
        <p class="lan-hint">
          手机与电脑连同一个 Wi-Fi，扫右侧二维码即可打开共享内容。服务走明文 HTTP，
          仅面向可信局域网；访问口令只是防误入，不等于加密。
        </p>
      </div>
      <label class="lan-switch" :class="{ on: running }">
        <input type="checkbox" :checked="running" :disabled="lanShare.busy" @change="toggleService" />
        <span class="lan-switch-track"><span class="lan-switch-dot" /></span>
        <span class="lan-switch-label">{{ running ? "已开启" : "已关闭" }}</span>
      </label>
    </header>

    <div class="lan-card-body">
      <div class="lan-form">
        <label class="lan-field">
          <span class="lan-field-label">设备名</span>
          <input
            v-model="nameDraft"
            :disabled="lanShare.busy"
            spellcheck="false"
            placeholder="显示在访问页标题"
            @blur="commitName"
            @keydown.enter="($event.target as HTMLInputElement).blur()"
          />
          <span class="lan-field-hint">手机打开共享页时看到的名称</span>
        </label>

        <label class="lan-field">
          <span class="lan-field-label">访问地址</span>
          <select
            :value="config?.host ?? ''"
            :disabled="lanShare.busy || !running"
            @change="patch({ host: ($event.target as HTMLSelectElement).value })"
          >
            <option v-for="opt in hostOptions" :key="opt.value || '__all__'" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
          <span class="lan-field-hint">默认绑定全部网卡；指定网卡后只在对应网络可访问</span>
        </label>

        <label class="lan-field">
          <span class="lan-field-label">端口</span>
          <input
            v-model="portDraft"
            type="number"
            min="1024"
            max="65535"
            :disabled="lanShare.busy || !running"
            @blur="commitPort"
            @keydown.enter="($event.target as HTMLInputElement).blur()"
          />
          <span class="lan-field-hint">被占用时会自动改用空闲端口，并在下方提示</span>
        </label>

        <label class="lan-field">
          <span class="lan-field-label">访问口令</span>
          <input
            v-model="codeDraft"
            type="text"
            spellcheck="false"
            :disabled="lanShare.busy"
            placeholder="留空 = 不需要口令"
            @blur="commitCode"
            @keydown.enter="($event.target as HTMLInputElement).blur()"
          />
          <span class="lan-field-hint">设置后访问者需先输入口令；明文传输，勿用作密码</span>
        </label>

        <div class="lan-field-row">
          <label class="lan-check">
            <input
              type="checkbox"
              :checked="config?.autoStart ?? false"
              :disabled="lanShare.busy"
              @change="patch({ autoStart: ($event.target as HTMLInputElement).checked })"
            />
            <span>随应用启动自动开启</span>
          </label>
          <label class="lan-check">
            <input
              type="checkbox"
              :checked="config?.allowDownload ?? true"
              :disabled="lanShare.busy"
              @change="patch({ allowDownload: ($event.target as HTMLInputElement).checked })"
            />
            <span>允许访问者下载源文件</span>
          </label>
        </div>

        <div class="lan-meta">
          <span v-if="running">监听 {{ lanShare.status?.bound }}</span>
          <span v-else>服务未开启</span>
          <span>·</span>
          <span>{{ lanShare.status?.shares.length ?? 0 }} 项共享 · {{ humanSize(totalSize) }}</span>
        </div>
        <div v-if="notice" class="lan-notice">{{ notice }}</div>
        <p v-if="!running" class="lan-hint">
          开启后这里会显示可扫的地址；也可以先在下面发布内容，发布时会自动开启服务。
        </p>
      </div>

      <div class="lan-qr-slot">
        <LanQrCode
          v-if="running && primary"
          :value="primary.url"
          title="扫码进入共享首页"
          :caption="primary.url"
          :size="172"
          :actions="true"
        />
        <div v-else class="lan-qr-placeholder">
          <span>{{ running ? "未探测到可用网卡地址，请在下方下拉里手动指定" : "服务未开启" }}</span>
        </div>
        <button
          v-if="running && primary"
          class="lan-btn ghost lan-open-btn"
          @click="openInBrowser(primary.url)"
        >
          在本机浏览器打开
        </button>
      </div>
    </div>
  </section>
</template>
