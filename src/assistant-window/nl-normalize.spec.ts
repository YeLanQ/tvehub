// nl-normalize 纯逻辑单测：归一化产物的解析校验与文件存在性判定。
// LLM 调用本身不测（薄传输封装，失败一律回落 null 不影响主链路）。
import { describe, expect, it } from "vitest";
import {
  filterExistingFiles,
  normalizePrompt,
  normalizeRelPath,
  parseNormalizedTask,
} from "./nl-normalize";

describe("parseNormalizedTask", () => {
  it("正常：裸 JSON 解析出类型/表述/锚点/文件", () => {
    const raw =
      '{"taskType":"create","task":"编写脚本组件：使立方体旋转","keywords":["脚本","旋转"],"files":["src/Rot.ts"]}';
    const spec = parseNormalizedTask(raw);
    expect(spec).not.toBeNull();
    expect(spec?.taskType).toBe("create");
    expect(spec?.task).toContain("立方体");
    expect(spec?.keywords).toEqual(["脚本", "旋转"]);
    expect(spec?.files).toEqual(["src/Rot.ts"]);
  });

  it("宽松：容忍 markdown 围栏与前后缀杂文本", () => {
    const raw =
      '好的，以下是结构化结果：\n```json\n{"taskType":"analyze","task":"解释场景结构","keywords":["场景"],"files":[]}\n```\n以上。';
    const spec = parseNormalizedTask(raw);
    expect(spec?.taskType).toBe("analyze");
    expect(spec?.task).toBe("解释场景结构");
  });

  it("异常：非 JSON / 空串 / 全空字段 → null", () => {
    expect(parseNormalizedTask("普通文本回复")).toBeNull();
    expect(parseNormalizedTask("")).toBeNull();
    expect(parseNormalizedTask('{"taskType":"chat"}')).toBeNull();
    expect(parseNormalizedTask('{"task":"  "}')).toBeNull();
  });

  it("兜底：未知类型回落 operate；超长截断；数组截断", () => {
    const spec = parseNormalizedTask(
      '{"taskType":"什么","task":"t".repeat(300) as unknown as string,"keywords":["a","b"],"files":[]}',
    );
    expect(spec).toBeNull(); // task 字段是非法 JSON 表达式 → 解析失败

    const ok = parseNormalizedTask(
      `{"taskType":"unknown","task":"${"x".repeat(300)}","keywords":${JSON.stringify(
        Array.from({ length: 20 }, (_, i) => `k${i}`),
      )},"files":${JSON.stringify(Array.from({ length: 12 }, (_, i) => `f${i}.ts`))}}`,
    );
    expect(ok?.taskType).toBe("operate");
    expect(ok?.task.length).toBeLessThanOrEqual(160);
    expect(ok?.keywords).toHaveLength(8);
    expect(ok?.files).toHaveLength(8);
  });
});

describe("filterExistingFiles", () => {
  const listing = ["src/TweenMotion.ts", "assets/Main.scene", "README.md"];

  it("存在性判定：分隔符/引导符/大小写归一后匹配，重复去重", () => {
    const { files, dropped } = filterExistingFiles(
      ["src\\TweenMotion.ts", "./src/tweenmotion.ts", "src/TweenMotion.ts", "README.md"],
      listing,
    );
    expect(files).toEqual(["src/TweenMotion.ts", "README.md"]);
    expect(dropped).toBe(2);
  });

  it("不存在/空清单：剔除并计数，绝不保留未核实路径", () => {
    expect(filterExistingFiles(["src/Nope.ts"], listing)).toEqual({ files: [], dropped: 1 });
    expect(filterExistingFiles(["src/Nope.ts"], [])).toEqual({ files: [], dropped: 1 });
    expect(filterExistingFiles([], listing)).toEqual({ files: [], dropped: 0 });
  });
});

describe("normalizeRelPath / normalizePrompt", () => {
  it("路径归一：反斜杠、./、/ 前缀统一", () => {
    expect(normalizeRelPath(" src\\A\\B.ts ")).toBe("src/A/B.ts");
    expect(normalizeRelPath("./src/A.ts")).toBe("src/A.ts");
    expect(normalizeRelPath("/src/A.ts")).toBe("src/A.ts");
  });

  it("提示词含五类型与输出格式约定", () => {
    const p = normalizePrompt();
    for (const t of ["operate", "create", "optimize", "analyze", "chat"]) {
      expect(p).toContain(t);
    }
    expect(p).toContain("只输出一个 JSON 对象");
    expect(p).toContain("绝不读取文件内容");
  });
});
