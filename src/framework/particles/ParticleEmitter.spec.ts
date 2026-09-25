import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ParticleEmitter } from "./ParticleEmitter";
import { ParticleSystem } from "./ParticleSystem";
import { DEFAULT_PARTICLE_SETTINGS, type ParticleSystemSettings } from "./types";
import { ParticleSystemNode } from "../prototype/nodes/ParticleSystemNode";

// 空闲降帧的活动信号语义（RendererManager 活动钩子消费）：
// emitting 必须区分「播放中的循环发射器」与「stop() 后的循环发射器」——
// 后者 finished 恒 false / playing 恒 true，历史上曾令视口永不降帧（真实事故）。
function makeSettings(over: Partial<ParticleSystemSettings> = {}): ParticleSystemSettings {
  return { ...DEFAULT_PARTICLE_SETTINGS, ...over };
}

describe("ParticleEmitter.emitting（活动信号）", () => {
  it("循环系统默认播放中：emitting=true 且 finished=false", () => {
    const e = new ParticleEmitter(makeSettings());
    expect(e.emitting).toBe(true);
    expect(e.finished).toBe(false);
    e.dispose();
  });

  it("stop() 后的循环系统：emitting=false（与 finished/playing 区分的关键场景）", () => {
    const e = new ParticleEmitter(makeSettings());
    e.stop();
    expect(e.emitting).toBe(false);
    // 循环系统的 finished 恒 false：证明 emitting 提供了 finished 给不出的语义
    expect(e.finished).toBe(false);
    e.dispose();
  });

  it("stop 后 play() 恢复发射：emitting 回到 true", () => {
    const e = new ParticleEmitter(makeSettings());
    e.stop();
    e.play();
    expect(e.emitting).toBe(true);
    e.dispose();
  });

  it("pause() 后 emitting=false，非循环系统播完 finished=true 且 emitting=false", () => {
    const e = new ParticleEmitter(makeSettings({ looping: false, duration: 0.1, startDelay: 0 }));
    e.pause();
    expect(e.emitting).toBe(false);
    e.play();
    e.update(1); // 超过 duration：发射窗口关闭
    expect(e.finished).toBe(true);
    expect(e.emitting).toBe(false);
    e.dispose();
  });
});

describe("ParticleSystem.hasActive（视口空闲降帧的活动判定）", () => {
  it("无绑定 = 无活动；播放中循环发射器 = 活动", () => {
    const ps = new ParticleSystem();
    expect(ps.hasActive()).toBe(false);

    const node = new ParticleSystemNode({ id: "p1" });
    const host = new THREE.Object3D();
    ps.syncNode(node, host);
    expect(ps.hasActive()).toBe(true);
  });

  it("stop() 后（粒子耗尽）= 无活动——降帧恢复的触发路径", () => {
    const ps = new ParticleSystem();
    const node = new ParticleSystemNode({ id: "p2" });
    ps.syncNode(node, new THREE.Object3D());
    ps.stop(node.id);
    // stop 后存活粒子自然消亡：推进足够时间清空，再判活动
    ps.update(5);
    expect(ps.hasActive()).toBe(false);
  });

  it("pause() 后 = 无活动（画面静止，允许降帧）；play() 恢复活动", () => {
    const ps = new ParticleSystem();
    const node = new ParticleSystemNode({ id: "p3" });
    ps.syncNode(node, new THREE.Object3D());
    ps.pause(node.id);
    expect(ps.hasActive()).toBe(false);
    ps.play(node.id);
    expect(ps.hasActive()).toBe(true);
  });
});
