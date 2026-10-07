// 命令入参窄化帮手单测：devtools/MCP/助手通道的 args 实际是任意 JSON，
// 帮手的收窄语义（尤其弱模型字符串布尔）是命令正确性的第一道闸。

import { describe, expect, it } from "vitest";
import { asBool, asRecord, asStringList, asStrings } from "./args";

describe("asBool 三态布尔", () => {
  it("正常：布尔与字符串布尔都收", () => {
    expect(asBool(true)).toBe(true);
    expect(asBool("true")).toBe(true);
    expect(asBool(false)).toBe(false);
    expect(asBool("false")).toBe(false);
  });

  it("边界：大小写敏感，「TRUE」/「True」不收（弱模型正确率优先于宽容度）", () => {
    expect(asBool("TRUE")).toBeUndefined();
    expect(asBool("True")).toBeUndefined();
  });

  it("空值：undefined/null/其余类型返回 undefined（调用方落到缺省值）", () => {
    expect(asBool(undefined)).toBeUndefined();
    expect(asBool(null)).toBeUndefined();
    expect(asBool(1)).toBeUndefined();
    expect(asBool("yes")).toBeUndefined();
  });
});

describe("asStringList 字符串列表", () => {
  it("正常：数组逐项 String 化；单字符串按中英文逗号切分", () => {
    expect(asStringList(["a.scene", "b.scene"])).toEqual(["a.scene", "b.scene"]);
    expect(asStringList("assets/A.scene，assets/B.scene")).toEqual([
      "assets/A.scene",
      "assets/B.scene",
    ]);
    expect(asStringList("assets/A.scene, assets/B.scene")).toEqual([
      "assets/A.scene",
      "assets/B.scene",
    ]);
  });

  it("边界：空串/纯逗号给空数组（调用方回落构建面板配置）", () => {
    expect(asStringList("")).toEqual([]);
    expect(asStringList(" , ， ")).toEqual([]);
  });

  it("空值：非数组非字符串返回空数组", () => {
    expect(asStringList(undefined)).toEqual([]);
    expect(asStringList(null)).toEqual([]);
    expect(asStringList(42)).toEqual([]);
  });
});

describe("既有帮手回归", () => {
  it("asRecord：对象收窄，数组/原始值拒收", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([1])).toBeUndefined();
    expect(asRecord("x")).toBeUndefined();
  });

  it("asStrings：仅数组形态，单字符串不切分（历史语义保持）", () => {
    expect(asStrings(["a", 1])).toEqual(["a", "1"]);
    expect(asStrings("a,b")).toEqual([]);
  });
});
