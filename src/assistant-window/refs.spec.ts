import { describe, expect, it } from "vitest";
import { isBinaryRef, parseFileRefs } from "./refs";

describe("parseFileRefs（@引用解析）", () => {
  it("正常：解析裸令牌与方括号令牌，去重保序", () => {
    const refs = parseFileRefs(
      "看看 @src/main.ts 和 @[assets/my model.glb]，再对比 @src/main.ts",
    );
    expect(refs).toEqual(["src/main.ts", "assets/my model.glb"]);
  });

  it("边界：多 references 混排中文标点不会粘连", () => {
    expect(parseFileRefs("@a.ts，@b.shader；@c.ts")).toEqual(["a.ts", "b.shader", "c.ts"]);
  });

  it("异常：语气误用（@的/@好）与空括号不当作文件", () => {
    expect(parseFileRefs("@的 @好 @人")).toEqual([]);
    expect(parseFileRefs("@[]")).toEqual([]);
  });

  it("空值：空串返回空数组", () => {
    expect(parseFileRefs("")).toEqual([]);
  });
});

describe("isBinaryRef（二进制引用判定）", () => {
  it("正常：模型/贴图/音频为二进制引用", () => {
    expect(isBinaryRef("assets/models/person.glb")).toBe(true);
    expect(isBinaryRef("assets/audio/hit.mp3")).toBe(true);
    expect(isBinaryRef("assets/textures/sky.hdr")).toBe(true);
  });
  it("异常/边界：脚本与场景是文本；无扩展名不算二进制", () => {
    expect(isBinaryRef("src/main.ts")).toBe(false);
    expect(isBinaryRef("assets/Main.scene")).toBe(false);
    expect(isBinaryRef("README")).toBe(false);
  });
});
