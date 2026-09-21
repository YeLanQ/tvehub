import { describe, expect, it } from "vitest";
import { SKILLS, findSkill, routeSkill, skillIndexPrompt } from "./index";

describe("助手技能注册表", () => {
  it("正常：技能非空且 id 唯一（含领域与工作流两组）", () => {
    const ids = SKILLS.map((s) => s.id);
    expect(SKILLS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("tve-scripting");
    expect(ids).toContain("staged-delivery");
  });

  it("正常：findSkill 命中与未命中", () => {
    expect(findSkill("tve-operations")?.name).toBe("编辑器操作指引");
    expect(findSkill("nope")).toBeNull();
  });

  it("正常：索引提示包含全部 id 与加载说明", () => {
    const prompt = skillIndexPrompt();
    for (const s of SKILLS) {
      expect(prompt).toContain(s.id);
    }
    expect(prompt).toContain("load_skill");
  });

  it("正常：routeSkill 关键词命中对应技能", () => {
    expect(routeSkill("帮我写一个自转脚本 Component")?.id).toBe("tve-scripting");
    expect(routeSkill("白板怎么保存")?.id).toBe("tve-whiteboard");
    expect(routeSkill("节点图怎么加变量")?.id).toBe("tve-graph");
    expect(routeSkill("保存的时候报错了")?.id).toBe("debugging-discipline");
  });

  it("空值/异常：空串与无关文本不误触发", () => {
    expect(routeSkill("")).toBeNull();
    expect(routeSkill("你好")).toBeNull();
  });
});
