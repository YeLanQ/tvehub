import { describe, expect, it } from "vitest";
import {
  cloneParticleSystemSettings,
  DEFAULT_PARTICLE_SETTINGS,
  isParticleTextureRel,
  parseParticleSystemSettings,
  particleStructureSignature,
  PARTICLE_LIMITS,
} from "./types";

// 粒子系统设置收敛：缺省回退、取值域钳制、枚举收敛与结构签名。

describe("parseParticleSystemSettings", () => {
  it("非法输入回默认", () => {
    for (const bad of [null, "x", 9, {}]) {
      expect(parseParticleSystemSettings(bad)).toEqual(DEFAULT_PARTICLE_SETTINGS);
    }
  });

  it("数值钳制 + maxParticles 取整", () => {
    const s = parseParticleSystemSettings({
      duration: 0, startLifetime: 999, startSize: -1, gravityModifier: 99,
      emissionRate: 1e6, maxParticles: 123.7, shapeAngle: 120,
    });
    expect(s.duration).toBe(PARTICLE_LIMITS.duration.min);
    expect(s.startLifetime).toBe(PARTICLE_LIMITS.startLifetime.max);
    expect(s.startSize).toBe(PARTICLE_LIMITS.startSize.min);
    expect(s.gravityModifier).toBe(PARTICLE_LIMITS.gravityModifier.max);
    expect(s.emissionRate).toBe(PARTICLE_LIMITS.emissionRate.max);
    expect(s.maxParticles).toBe(124); // Math.round
    expect(s.shapeAngle).toBe(89);
    expect(parseParticleSystemSettings({ maxParticles: 0 }).maxParticles).toBe(1); // 下限
  });

  it("枚举收敛：shape 四种、空间/混合非法回默认", () => {
    for (const shape of ["cone", "sphere", "hemisphere", "box"] as const) {
      expect(parseParticleSystemSettings({ shape }).shape).toBe(shape);
    }
    expect(parseParticleSystemSettings({ shape: "pyramid" }).shape).toBe("cone");
    expect(parseParticleSystemSettings({ simulationSpace: "world" }).simulationSpace).toBe("world");
    expect(parseParticleSystemSettings({ simulationSpace: "galaxy" }).simulationSpace).toBe("local");
    expect(parseParticleSystemSettings({ blending: "normal" }).blending).toBe("normal");
    expect(parseParticleSystemSettings({ blending: "multiply" }).blending).toBe("additive");
  });

  it("颜色收敛到 24 位无符号", () => {
    expect(parseParticleSystemSettings({ startColor: -1 }).startColor).toBe(0xffffff);
    expect(parseParticleSystemSettings({ startColor: "x" }).startColor).toBe(DEFAULT_PARTICLE_SETTINGS.startColor);
  });
});

describe("克隆 / 签名 / 贴图路径", () => {
  it("clone 独立；结构签名只看 maxParticles 与 blending", () => {
    const c = cloneParticleSystemSettings(DEFAULT_PARTICLE_SETTINGS);
    c.emissionRate = 99;
    expect(DEFAULT_PARTICLE_SETTINGS.emissionRate).toBe(20);
    const base = particleStructureSignature(DEFAULT_PARTICLE_SETTINGS);
    expect(particleStructureSignature({ ...DEFAULT_PARTICLE_SETTINGS, emissionRate: 99 })).toBe(base);
    expect(particleStructureSignature({ ...DEFAULT_PARTICLE_SETTINGS, maxParticles: 10 })).not.toBe(base);
    expect(particleStructureSignature({ ...DEFAULT_PARTICLE_SETTINGS, blending: "normal" })).not.toBe(base);
  });

  it("isParticleTextureRel 按扩展名（大小写不敏感）", () => {
    expect(isParticleTextureRel("fx/spark.png")).toBe(true);
    expect(isParticleTextureRel("fx/spark.TGA")).toBe(true);
    expect(isParticleTextureRel("fx/spark.mp3")).toBe(false);
    expect(isParticleTextureRel("fx/spark")).toBe(false);
  });
});
