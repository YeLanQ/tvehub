import { describe, expect, it } from "vitest";
import {
  buildFileTocBlock,
  isLargeFile,
  isOversizeError,
  shouldIndexInstead,
  type FileIndexBrief,
} from "./fileidx";

describe("shouldIndexInstead（索引模式判定）", () => {
  it("正常：小文件整包注入", () => {
    expect(shouldIndexInstead("short content", false)).toBe(false);
  });

  it("边界：超阈值或读取端截断即转索引", () => {
    expect(shouldIndexInstead("x".repeat(12_001), false)).toBe(true);
    expect(shouldIndexInstead("x".repeat(12_000), false)).toBe(false);
    expect(shouldIndexInstead("短内容", true)).toBe(true);
  });

  it("异常：仅超限错误（512KB）转索引，其他读取失败不转", () => {
    expect(shouldIndexInstead(undefined, undefined, "文件超过 512KB，不适合直接插入")).toBe(true);
    expect(shouldIndexInstead(undefined, undefined, "文件不存在")).toBe(false);
  });

  it("空值：空内容与空串不转索引", () => {
    expect(shouldIndexInstead(undefined, undefined)).toBe(false);
    expect(shouldIndexInstead("", false)).toBe(false);
  });
});

describe("isLargeFile / isOversizeError", () => {
  it("isLargeFile 以字符数判定，truncated 直接判大", () => {
    expect(isLargeFile("a".repeat(12_001))).toBe(true);
    expect(isLargeFile("a")).toBe(false);
    expect(isLargeFile("a", true)).toBe(true);
  });
  it("isOversizeError 匹配后端拒读文案", () => {
    expect(isOversizeError("文件超过 512KB，不适合直接插入")).toBe(true);
    expect(isOversizeError("读取失败: os error")).toBe(false);
  });
});

describe("buildFileTocBlock（索引目录注入块）", () => {
  const brief: FileIndexBrief = {
    path: "src/Rotator.ts",
    summary: "旋转组件",
    moduleCount: 2,
    modules: [
      { title: "声明 class Rotator", summary: "每帧自转", lineStart: 10, lineEnd: 48 },
      { title: "声明 function ease", summary: "缓动工具", lineStart: 50, lineEnd: 80 },
    ],
  };

  it("正常：含文件头、行号目录与 file.search 指令", () => {
    const block = buildFileTocBlock("src/Rotator.ts", brief);
    expect(block).toContain("--- 文件：src/Rotator.ts（较大，已建模块索引：共 2 个模块");
    expect(block).toContain("1. [L10-48] 声明 class Rotator：每帧自转");
    expect(block).toContain('{"path":"src/Rotator.ts","query":"关键词"}');
    expect(block).toContain("--- 结束 ---");
  });

  it("边界：模块目录超过上限时截断并列出剩余数", () => {
    const big: FileIndexBrief = {
      path: "big.md",
      summary: "大文档",
      moduleCount: 45,
      modules: Array.from({ length: 45 }, (_, i) => ({
        title: `章节${i}`,
        summary: `s${i}`,
        lineStart: i * 10 + 1,
        lineEnd: (i + 1) * 10,
      })),
    };
    const block = buildFileTocBlock("big.md", big);
    expect(block).toContain("…另有 5 个模块未列出");
    expect(block).toContain("40. [L391-400] 章节39：s39");
    expect(block).not.toContain("章节40：");
  });

  it("异常/空值：空模块目录仍产出可用块", () => {
    const empty: FileIndexBrief = { path: "e.txt", summary: "", moduleCount: 0, modules: [] };
    const block = buildFileTocBlock("e.txt", empty);
    expect(block).toContain("共 0 个模块");
    expect(block).toContain("file.search");
  });
});
