import { describe, expect, it } from "vitest";
import {
  ALL_LAYERS_MASK,
  BUILTIN_LAYER_NAME,
  clampLayerIndex,
  cullingMaskLabel,
  definedLayerIndices,
  isLayerDefined,
  layerIndexOfName,
  layerNameAt,
  layerTableToJSON,
  MAX_LAYERS,
  maskHasLayer,
  maskWithLayer,
  nextFreeLayerIndex,
  parseCullingMask,
  parseLayerTable,
  parseTagList,
} from "./index";

// 渲染层系统：层表收敛/存档、层索引与掩码的换算。

describe("parseLayerTable 收敛", () => {
  it("index 0 强制内置 Default；非法输入回全空表", () => {
    const t = parseLayerTable(null);
    expect(t).toHaveLength(MAX_LAYERS);
    expect(t[0]).toBe(BUILTIN_LAYER_NAME);
    expect(t.slice(1).every((n) => n === "")).toBe(true);
  });

  it("合法命名入表；重名/空名/越界跳过", () => {
    const t = parseLayerTable(["ignored", "Water", "Water", "  ", "UI", "X".repeat(99)]);
    expect(t[1]).toBe("Water");
    expect(t[2]).toBe(""); // 重名置空
    expect(t[3]).toBe(""); // 空名
    expect(t[4]).toBe("UI");
    expect(t[5]).toBe("X".repeat(99)); // 长度不限（仅 trim）
  });

  it("层 0 的自定义名被强制覆盖回 Default", () => {
    const t = parseLayerTable(["Custom"]);
    expect(t[0]).toBe(BUILTIN_LAYER_NAME);
  });
});

describe("层表存档与查询", () => {
  const table = parseLayerTable([, "Water", , , "UI"]); // eslint-disable-line no-sparse-arrays

  it("layerTableToJSON 截尾稀疏存档", () => {
    expect(layerTableToJSON(table)).toEqual(["Default", "Water", "", "", "UI"]);
    expect(layerTableToJSON(parseLayerTable(null))).toEqual(["Default"]);
  });

  it("isLayerDefined / layerNameAt / layerIndexOfName / definedLayerIndices", () => {
    expect(isLayerDefined(table, 1)).toBe(true);
    expect(isLayerDefined(table, 2)).toBe(false);
    expect(isLayerDefined(table, -1)).toBe(false);
    expect(isLayerDefined(table, MAX_LAYERS)).toBe(false);
    expect(layerNameAt(table, 0)).toBe(BUILTIN_LAYER_NAME);
    expect(layerNameAt(table, 2)).toBe("Layer 2"); // 未定义回退显示名
    expect(layerIndexOfName(table, "Water")).toBe(1);
    expect(layerIndexOfName(table, "Nope")).toBe(-1);
    expect(definedLayerIndices(table)).toEqual([0, 1, 4]);
  });

  it("nextFreeLayerIndex 首个空位；全满返回 -1", () => {
    expect(nextFreeLayerIndex(table)).toBe(2);
    const full = new Array(MAX_LAYERS).fill("L");
    expect(nextFreeLayerIndex(full)).toBe(-1);
  });
});

describe("索引与掩码换算", () => {
  it("clampLayerIndex：任意来源收敛 0~31，越界/非法回 0", () => {
    expect(clampLayerIndex(5)).toBe(5);
    expect(clampLayerIndex(5.4)).toBe(5); // 四舍五入
    expect(clampLayerIndex(-1)).toBe(0);
    expect(clampLayerIndex(32)).toBe(0);
    expect(clampLayerIndex(NaN)).toBe(0);
    expect(clampLayerIndex("3")).toBe(0);
    expect(clampLayerIndex(null)).toBe(0);
  });

  it("parseCullingMask：int32 收敛、非法回全选", () => {
    expect(parseCullingMask(5)).toBe(5);
    expect(parseCullingMask(3.7)).toBe(3);
    expect(parseCullingMask(undefined)).toBe(ALL_LAYERS_MASK);
    expect(parseCullingMask("x")).toBe(ALL_LAYERS_MASK);
  });

  it("maskHasLayer / maskWithLayer 置位与清除", () => {
    let mask = 0;
    mask = maskWithLayer(mask, 3, true);
    expect(maskHasLayer(mask, 3)).toBe(true);
    expect(mask).toBe(8);
    mask = maskWithLayer(mask, 3, false);
    expect(maskHasLayer(mask, 3)).toBe(false);
    expect(mask).toBe(0);
  });
});

describe("cullingMaskLabel 摘要", () => {
  const table = parseLayerTable([, "Water", , , "UI"]); // eslint-disable-line no-sparse-arrays

  it("覆盖全部已定义层 → Everything（无论掩码是否恰为 -1）", () => {
    expect(cullingMaskLabel(table, ALL_LAYERS_MASK)).toBe("Everything");
    expect(cullingMaskLabel(table, 0b10011)).toBe("Everything"); // 恰好勾满 0/1/4
  });

  it("一个已定义层都没覆盖 → Nothing；其余为升序层名列表", () => {
    expect(cullingMaskLabel(table, 0)).toBe("Nothing");
    expect(cullingMaskLabel(table, 0b10)).toBe("Water");
    expect(cullingMaskLabel(table, 0b10001)).toBe("Default, UI");
  });

  it("空层表（只有内置 Default）的边界", () => {
    const t = parseLayerTable(null);
    expect(cullingMaskLabel(t, 1)).toBe("Everything");
    expect(cullingMaskLabel(t, 0)).toBe("Nothing");
  });
});

describe("parseTagList 标签收敛", () => {
  it("trim / 去空 / 去重 / 跳过非字符串，保持顺序", () => {
    expect(parseTagList([" a ", "b", "a", "", "  ", 3, null, "b"])).toEqual(["a", "b"]);
    expect(parseTagList(null)).toEqual([]);
    expect(parseTagList("x")).toEqual([]);
  });
});
