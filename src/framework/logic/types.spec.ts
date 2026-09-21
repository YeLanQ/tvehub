import { describe, expect, it } from "vitest";
import { isBtAssetRel } from "../behavior/behaviorTypes";
import { isFsmAssetRel } from "../fsm/fsmTypes";
import {
  cloneLogicRunnerSettings,
  DEFAULT_BT_RUNNER_SETTINGS,
  DEFAULT_FSM_RUNNER_SETTINGS,
  logicRunnerSettingsSig,
  parseLogicRunnerSettings,
  unwrapLogicAsset,
} from "./types";

// 逻辑运行器设置：扩展名校验、取值域钳制、签名与资产文档解包。

describe("parseLogicRunnerSettings", () => {
  it("非法输入回各自缺省（fsm/bt 同形状）", () => {
    expect(parseLogicRunnerSettings(null, ".fsm")).toEqual(DEFAULT_FSM_RUNNER_SETTINGS);
    expect(parseLogicRunnerSettings(42, ".bt")).toEqual(DEFAULT_BT_RUNNER_SETTINGS);
  });

  it("asset 扩展名不符清空（= 未绑定）；合法保留", () => {
    expect(parseLogicRunnerSettings({ asset: "logic/patrol.bt" }, ".fsm").asset).toBe("");
    expect(parseLogicRunnerSettings({ asset: "logic/patrol.fsm" }, ".fsm").asset).toBe("logic/patrol.fsm");
    expect(parseLogicRunnerSettings({ asset: "logic/patrol.FSM" }, ".fsm").asset).toBe("logic/patrol.FSM");
  });

  it("autoStart 布尔收敛；speed 钳到 [0.05, 20]", () => {
    const s = parseLogicRunnerSettings({ asset: "a.fsm", autoStart: 0, speed: 99 }, ".fsm");
    expect(s.autoStart).toBe(true); // 非布尔回默认 true
    expect(s.speed).toBe(20);
    expect(parseLogicRunnerSettings({ asset: "a.fsm", autoStart: false, speed: 0 }, ".fsm").speed).toBe(0.05);
  });
});

describe("克隆 / 签名 / 路径判断 / 解包", () => {
  it("clone 独立副本；签名含绑定/自启/倍率三项", () => {
    const s = parseLogicRunnerSettings({ asset: "a.fsm", autoStart: false, speed: 2 }, ".fsm");
    const c = cloneLogicRunnerSettings(s);
    c.asset = "b.fsm";
    expect(s.asset).toBe("a.fsm");
    expect(logicRunnerSettingsSig(s)).not.toBe(logicRunnerSettingsSig(c));
  });

  it("isFsmAssetRel / isBtAssetRel 按扩展名", () => {
    expect(isFsmAssetRel("a.fsm")).toBe(true);
    expect(isFsmAssetRel("a.bt")).toBe(false);
    expect(isBtAssetRel("a.bt")).toBe(true);
    expect(isBtAssetRel("a.fsm")).toBe(false);
  });

  it("unwrapLogicAsset 取 { graph } 包装的内层文档；裸文档原样返回", () => {
    const graph = { states: [] };
    expect(unwrapLogicAsset({ graph }, "fsm")).toBe(graph);
    expect(unwrapLogicAsset(graph, "fsm")).toBe(graph);
    expect(unwrapLogicAsset(null, "bt")).toBe(null);
  });
});
