// 主题颜色自定义：覆盖值的 规范化 / 持久化（prefs.json theme_colors）/ 应用到 :root。
// 颜色项定义（THEME_COLOR_DEFS）与默认值事实源见 home-helpers（ui-kit variables.scss 产物）。
// 每个窗口入口调 installThemeSync()：启动恢复覆盖 + 跟随其他窗口的实时修改。

import { computed, onUnmounted, ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { api } from "../../lib/api";
import { THEME_COLOR_DEFS, type ThemeColorDef } from "./home-helpers";

/** 覆盖表：key（THEME_COLOR_DEFS 的 key）→ #rrggbb；只存与默认不同的项 */
export type ThemeOverrides = Record<string, string>;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** 过滤未知键与非法色值（prefs 里读到的脏数据不进样式） */
export function normalizeOverrides(
  raw: Record<string, string> | null | undefined,
): ThemeOverrides {
  const out: ThemeOverrides = {};
  if (!raw) return out;
  const known = new Set(THEME_COLOR_DEFS.map((d) => d.key));
  for (const [k, v] of Object.entries(raw)) {
    if (known.has(k) && typeof v === "string" && HEX_RE.test(v)) out[k] = v.toLowerCase();
  }
  return out;
}

/** 把覆盖表写到我方根元素；缺省项清除行内覆盖，回落样式表默认值 */
export function applyThemeColors(
  overrides: ThemeOverrides,
  root: HTMLElement = document.documentElement,
): void {
  for (const def of THEME_COLOR_DEFS) {
    const v = overrides[def.key];
    if (v) root.style.setProperty(def.cssVar, v);
    else root.style.removeProperty(def.cssVar);
  }
}

/** 启动恢复 + 跟随跨窗口修改（set_theme_colors 后端广播 prefs:theme-changed） */
export function installThemeSync(): void {
  void api
    .getThemeColors()
    .then((raw) => applyThemeColors(normalizeOverrides(raw)))
    .catch(() => {});
  void listen<Record<string, string>>("prefs:theme-changed", (e) => {
    applyThemeColors(normalizeOverrides(e.payload));
  }).catch(() => {});
}

/**
 * 偏好页编辑态：当前值（默认或覆盖）、即时应用到界面、防抖持久化。
 * 覆盖值改回默认即从覆盖表移除（prefs.json 只存有效差异）。
 */
export function useThemeColorEditor() {
  const values = ref<Record<string, string>>(
    Object.fromEntries(THEME_COLOR_DEFS.map((d) => [d.key, d.defaultValue])),
  );

  let overrides: ThemeOverrides = {};
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function isModified(def: ThemeColorDef): boolean {
    return values.value[def.key].toLowerCase() !== def.defaultValue.toLowerCase();
  }
  const anyModified = computed(() => THEME_COLOR_DEFS.some((d) => isModified(d)));

  function apply() {
    applyThemeColors(overrides);
  }

  function persist() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    void api.setThemeColors({ ...overrides }).catch(() => {
      // 保存失败不影响本次会话已应用的效果
    });
  }

  function persistSoon() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 400);
  }

  function setColor(def: ThemeColorDef, value: string) {
    values.value[def.key] = value;
    if (value.toLowerCase() === def.defaultValue.toLowerCase()) delete overrides[def.key];
    else overrides[def.key] = value;
    apply();
    persistSoon();
  }

  function resetColor(def: ThemeColorDef) {
    values.value[def.key] = def.defaultValue;
    delete overrides[def.key];
    apply();
    persist();
  }

  function resetAll() {
    for (const def of THEME_COLOR_DEFS) values.value[def.key] = def.defaultValue;
    overrides = {};
    apply();
    persist();
  }

  async function load() {
    try {
      overrides = normalizeOverrides(await api.getThemeColors());
      for (const def of THEME_COLOR_DEFS) {
        if (overrides[def.key]) values.value[def.key] = overrides[def.key];
      }
      apply();
    } catch {
      // 非 Tauri / 读取失败：保持默认主题
    }
  }

  onUnmounted(() => {
    if (saveTimer) clearTimeout(saveTimer);
  });

  return { values, isModified, anyModified, setColor, resetColor, resetAll, load };
}
