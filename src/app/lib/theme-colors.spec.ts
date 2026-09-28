// theme-colors 纯函数单测：覆盖表的规范化和 :root 应用。
// 编辑态（useThemeColorEditor）依赖 Tauri api，不在此测。
import { describe, expect, it } from "vitest";
import { THEME_COLOR_DEFS } from "./home-helpers";
import { applyThemeColors, normalizeOverrides } from "./theme-colors";

const bgDef = THEME_COLOR_DEFS.find((d) => d.key === "bg")!;
const textDef = THEME_COLOR_DEFS.find((d) => d.key === "text")!;

describe("normalizeOverrides", () => {
  it("保留已知键的合法色值", () => {
    expect(normalizeOverrides({ bg: "#112233", text: "#aabbcc" })).toEqual({
      bg: "#112233",
      text: "#aabbcc",
    });
  });

  it("大写色值归一为小写", () => {
    expect(normalizeOverrides({ bg: "#AABBCC" })).toEqual({ bg: "#aabbcc" });
  });

  it("丢弃未知键与非法色值", () => {
    expect(
      normalizeOverrides({ bg: "red", unknown: "#112233", [textDef.key]: "#12345" }),
    ).toEqual({});
  });

  it("非字符串值丢弃；null/undefined 返回空表", () => {
    expect(normalizeOverrides({ bg: 123 as unknown as string })).toEqual({});
    expect(normalizeOverrides(null)).toEqual({});
    expect(normalizeOverrides(undefined)).toEqual({});
  });
});

describe("applyThemeColors", () => {
  it("覆盖项写入行内样式，未覆盖项清除回落默认", () => {
    const root = document.documentElement;
    root.style.setProperty(bgDef.cssVar, "#999999");
    applyThemeColors({ [bgDef.key]: "#112233" });
    expect(root.style.getPropertyValue(bgDef.cssVar)).toBe("#112233");
    applyThemeColors({});
    expect(root.style.getPropertyValue(bgDef.cssVar)).toBe("");
  });

  it("全部默认值时行内不留任何主题令牌", () => {
    const root = document.documentElement;
    applyThemeColors(
      Object.fromEntries(THEME_COLOR_DEFS.map((d) => [d.key, d.defaultValue])),
    );
    for (const def of THEME_COLOR_DEFS) {
      expect(root.style.getPropertyValue(def.cssVar)).toBe(def.defaultValue);
    }
    applyThemeColors({});
    for (const def of THEME_COLOR_DEFS) {
      expect(root.style.getPropertyValue(def.cssVar)).toBe("");
    }
  });
});
