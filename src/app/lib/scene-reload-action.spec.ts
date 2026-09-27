// sceneReloadAction：外部 .scene 修改的响应动作判定（正常/边界/异常/空值四类）。
import { describe, expect, it } from "vitest";
import { sceneReloadAction } from "./scene-reload-action";

describe("sceneReloadAction", () => {
  it("正常：当前场景按脏态分级（脏确认/非脏自动）", () => {
    expect(sceneReloadAction(true, true)).toBe("confirm");
    expect(sceneReloadAction(true, false)).toBe("auto");
  });

  it("边界：非当前场景无论脏态都只提示", () => {
    expect(sceneReloadAction(false, true)).toBe("notice");
    expect(sceneReloadAction(false, false)).toBe("notice");
  });

  it("异常：入参为假值时安全降级", () => {
    expect(sceneReloadAction(false as unknown as boolean, true)).toBe("notice");
    expect(sceneReloadAction(true, undefined as unknown as boolean)).toBe("auto");
  });

  it("空值：双假值（非当前 + 非脏）返回 notice", () => {
    expect(sceneReloadAction(false as unknown as boolean, false as unknown as boolean)).toBe("notice");
  });
});
