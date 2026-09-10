// 粒子系统冒烟测试（headless，无需 GPU）。
// 覆盖五段：
// ① 数据层：设置默认值 / parse 收敛（缺失、非法、越界、枚举回退）/ 深拷贝 / 结构签名；
// ② 节点层：注册表登记、工厂产出、序列化往返、旧场景兼容（无 particles 字段）、clone 深拷贝；
// ③ 发射器模拟：发射速率、寿命回收、容量上限、圆锥方向、重力、非循环停止、起始延迟、
//    播放控制（暂停/停止/重启）、预热、随寿命颜色/尺寸写缓冲、world 模拟空间、
//    原地更新 vs 结构重建；
// ④ 同步器 + ParticleSystem 运行时：图标精灵、Points 挂载、层跟随、属性变更原地更新、
//    结构变更重建、解绑释放；
// ⑤ 脚本 SDK 契约：tve.d.ts 与 tve.mjs 都声明了 ParticleSystemNode / engine.particles。
// 跑法：
//   npx vite build --ssr scripts/smoke-particles.ts --outDir .tmp-smoke --emptyOutDir
//   node .tmp-smoke/smoke-particles.js

import * as THREE from "three";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Node } from "../src/framework/prototype/Node";
import { ParticleSystemNode } from "../src/framework/prototype/nodes/ParticleSystemNode";
import { createDefaultRegistry } from "../src/framework/prototype/PrototypeRegistry";
import { createNodeFactory } from "../src/framework/factory/NodeFactory";
import {
  DEFAULT_PARTICLE_SETTINGS,
  PARTICLE_LIMITS,
  PARTICLES_CHILD_NAME,
  ParticleEmitter,
  ParticleSystem,
  cloneParticleSystemSettings,
  parseParticleSystemSettings,
  particleStructureSignature,
  type ParticleSystemSettings,
} from "../src/framework/particles";
import { SceneSynchronizer } from "../src/framework/engine/modules/SceneSynchronizer";
import type { GraphLike } from "../src/framework/scene/SceneClient";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function approx(a: number, b: number, eps = 1e-3): boolean {
  return Math.abs(a - b) <= eps;
}

/** 最小 GraphLike（同步器只用到 get/all） */
function fakeGraph(nodes: Node[]): GraphLike {
  const map = new Map(nodes.map((n) => [n.id, n]));
  return { get: (id: string) => map.get(id), all: () => [...nodes] };
}

/** 以固定步长推进发射器 seconds 秒 */
function advance(em: ParticleEmitter, seconds: number, host?: THREE.Object3D, step = 1 / 60): void {
  const n = Math.round(seconds / step);
  for (let i = 0; i < n; i++) em.update(step, host);
}

function settings(patch: Partial<ParticleSystemSettings>): ParticleSystemSettings {
  return parseParticleSystemSettings({ ...DEFAULT_PARTICLE_SETTINGS, ...patch });
}

/** 读取缓冲里第 i 个粒子的位置 */
function bufPos(em: ParticleEmitter, i: number): THREE.Vector3 {
  const a = em.object.geometry.getAttribute("position") as THREE.BufferAttribute;
  return new THREE.Vector3(a.getX(i), a.getY(i), a.getZ(i));
}

// ===========================================================================
console.log("[1] 数据层：默认值 / parse 收敛 / 深拷贝 / 结构签名");
{
  const d = parseParticleSystemSettings(undefined);
  check("缺省解析 = 默认设置", JSON.stringify(d) === JSON.stringify(DEFAULT_PARTICLE_SETTINGS));
  check("默认循环 + 叠加混合 + 圆锥", d.looping && d.blending === "additive" && d.shape === "cone");

  const p = parseParticleSystemSettings({
    duration: -5,
    startLifetime: 99999,
    startSpeed: "fast",
    startSize: NaN,
    startColor: 0x1ff0000,
    gravityModifier: -100,
    emissionRate: Infinity,
    maxParticles: 3.7,
    shape: "torus",
    shapeAngle: 200,
    simulationSpace: "galaxy",
    blending: "multiply",
    colorOverLifetime: "yes",
    looping: 0,
  });
  check("duration 越界钳到下限", p.duration === PARTICLE_LIMITS.duration.min);
  check("startLifetime 越界钳到上限", p.startLifetime === PARTICLE_LIMITS.startLifetime.max);
  check("startSpeed 非数回默认", p.startSpeed === DEFAULT_PARTICLE_SETTINGS.startSpeed);
  check("startSize NaN 回默认", p.startSize === DEFAULT_PARTICLE_SETTINGS.startSize);
  check("颜色掩到 24 位", p.startColor === 0xff0000, p.startColor.toString(16));
  check("gravityModifier 钳到下限", p.gravityModifier === PARTICLE_LIMITS.gravityModifier.min);
  check("emissionRate Infinity 回默认", p.emissionRate === DEFAULT_PARTICLE_SETTINGS.emissionRate);
  check("maxParticles 取整", p.maxParticles === 4, String(p.maxParticles));
  check("未知 shape 回默认 cone", p.shape === "cone");
  check("shapeAngle 钳到 89", p.shapeAngle === PARTICLE_LIMITS.shapeAngle.max);
  check("未知 simulationSpace 回 local", p.simulationSpace === "local");
  check("未知 blending 回 additive", p.blending === "additive");
  check("布尔字段非布尔回默认", p.colorOverLifetime === true && p.looping === true);

  const a = settings({ emissionRate: 7 });
  const b = cloneParticleSystemSettings(a);
  b.emissionRate = 99;
  check("cloneParticleSystemSettings 为独立副本", a.emissionRate === 7 && b.emissionRate === 99);

  check(
    "结构签名只含容量与混合",
    particleStructureSignature(settings({ emissionRate: 1 })) ===
      particleStructureSignature(settings({ emissionRate: 999 })) &&
      particleStructureSignature(settings({ maxParticles: 10 })) !==
        particleStructureSignature(settings({ maxParticles: 11 })) &&
      particleStructureSignature(settings({ blending: "normal" })) !==
        particleStructureSignature(settings({ blending: "additive" })),
  );
}

// ===========================================================================
console.log("[2] 节点层：注册表 / 工厂 / 序列化往返 / 旧场景兼容 / clone");
{
  const registry = createDefaultRegistry();
  const factory = createNodeFactory(registry);
  check("注册表登记 particleSystemNode", registry.has(ParticleSystemNode.kType));
  const node = factory.createParticleSystem();
  check("工厂产出 typeKey", node.typeKey === "particleSystemNode" && node instanceof ParticleSystemNode);
  check("工厂默认名 Particle System", node.name === "Particle System");
  check("工厂节点默认设置", node.particles.emissionRate === DEFAULT_PARTICLE_SETTINGS.emissionRate);

  node.particles.emissionRate = 42;
  node.particles.shape = "sphere";
  node.particles.startColor = 0x00ff00;
  node.particles.simulationSpace = "world";
  const json = node.toJSON() as Record<string, unknown>;
  check("toJSON 写出 particles 字段", !!json.particles && (json.particles as ParticleSystemSettings).emissionRate === 42);
  const back = registry.createFromJSON(json as never) as ParticleSystemNode;
  check(
    "createFromJSON 往返保真",
    back instanceof ParticleSystemNode &&
      back.particles.emissionRate === 42 &&
      back.particles.shape === "sphere" &&
      back.particles.startColor === 0x00ff00 &&
      back.particles.simulationSpace === "world",
  );
  check("往返后设置为独立对象", back.particles !== node.particles);

  const legacy = registry.createFromJSON({
    type: "particleSystemNode",
    id: "ps-legacy",
    name: "Old",
  } as never) as ParticleSystemNode;
  check(
    "旧场景无 particles 字段 → 默认设置",
    JSON.stringify(legacy.particles) === JSON.stringify(DEFAULT_PARTICLE_SETTINGS),
  );

  const clone = node.clone();
  clone.particles.emissionRate = 1;
  check("clone 深拷贝设置", node.particles.emissionRate === 42 && clone.particles.emissionRate === 1);
  check("clone 生成新 id", clone.id !== node.id);
}

// ===========================================================================
console.log("[3] 发射器模拟");
{
  // —— 发射速率与稳态 ——
  {
    const em = new ParticleEmitter(settings({ emissionRate: 60, startLifetime: 1, maxParticles: 1000 }));
    check("建出即 0 粒子", em.aliveCount === 0);
    advance(em, 0.5);
    check("0.5s 后约 30 粒子（60/s）", em.aliveCount >= 28 && em.aliveCount <= 31, String(em.aliveCount));
    advance(em, 2);
    // 稳态 ≈ rate × lifetime = 60
    check("稳态存活 ≈ rate×lifetime", em.aliveCount >= 57 && em.aliveCount <= 61, String(em.aliveCount));
    check("drawRange 跟随存活数", em.object.geometry.drawRange.count === em.aliveCount);
    em.dispose();
  }
  // —— 容量上限 ——
  {
    const em = new ParticleEmitter(settings({ emissionRate: 5000, startLifetime: 10, maxParticles: 50 }));
    advance(em, 1);
    check("maxParticles 封顶", em.aliveCount === 50, String(em.aliveCount));
    check("超容量不影响缓冲长度", (em.object.geometry.getAttribute("position") as THREE.BufferAttribute).count === 50);
    em.dispose();
  }
  // —— 圆锥方向（半角 0 = 沿本地 -Z 直射；出生点在底圆内） ——
  {
    const em = new ParticleEmitter(
      settings({ emissionRate: 600, startLifetime: 5, startSpeed: 5, shape: "cone", shapeAngle: 0, shapeRadius: 0.5, gravityModifier: 0, maxParticles: 200 }),
    );
    advance(em, 0.5);
    let ok = em.aliveCount > 10;
    for (let i = 0; i < em.aliveCount; i++) {
      const p = bufPos(em, i);
      if (!(p.z < 0 && Math.hypot(p.x, p.y) <= 0.5 + 1e-6)) ok = false;
    }
    check("cone 半角 0 → 全部沿 -Z 且 xy 在底圆内", ok, `alive=${em.aliveCount}`);
    em.dispose();
  }
  // —— 球面：出生点在半径处且方向向外 ——
  {
    const em = new ParticleEmitter(
      settings({ emissionRate: 600, startLifetime: 5, startSpeed: 1, shape: "sphere", shapeRadius: 2, gravityModifier: 0, maxParticles: 200 }),
    );
    em.update(1 / 60);
    let ok = em.aliveCount > 0;
    for (let i = 0; i < em.aliveCount; i++) {
      const r = bufPos(em, i).length();
      if (!(r >= 2 - 1e-6 && r <= 2 + 1 / 60 + 1e-6)) ok = false;
    }
    check("sphere 出生点在球面并向外飞", ok);
    em.dispose();
  }
  // —— 半球：y ≥ 0 ——
  {
    const em = new ParticleEmitter(
      settings({ emissionRate: 600, startLifetime: 5, startSpeed: 1, shape: "hemisphere", shapeRadius: 1, gravityModifier: 0, maxParticles: 200 }),
    );
    advance(em, 0.3);
    let ok = em.aliveCount > 0;
    for (let i = 0; i < em.aliveCount; i++) if (bufPos(em, i).y < -1e-6) ok = false;
    check("hemisphere 全部 y ≥ 0", ok);
    em.dispose();
  }
  // —— 盒体：出生点在半边长内，速度沿 -Z ——
  {
    const em = new ParticleEmitter(
      settings({ emissionRate: 600, startLifetime: 5, startSpeed: 0, shape: "box", shapeRadius: 1.5, gravityModifier: 0, maxParticles: 200 }),
    );
    advance(em, 0.3);
    let ok = em.aliveCount > 0;
    for (let i = 0; i < em.aliveCount; i++) {
      const p = bufPos(em, i);
      if (Math.abs(p.x) > 1.5 || Math.abs(p.y) > 1.5 || Math.abs(p.z) > 1.5) ok = false;
    }
    check("box 出生点在盒内", ok);
    em.dispose();
  }
  // —— 重力 ——
  {
    const em = new ParticleEmitter(
      settings({ emissionRate: 100, startLifetime: 10, startSpeed: 0, shape: "box", shapeRadius: 0, gravityModifier: 1, maxParticles: 500 }),
    );
    em.update(1 / 60);
    const first = bufPos(em, 0).y;
    advance(em, 1);
    const later = bufPos(em, 0).y;
    check("gravityModifier=1 → 粒子下落", later < first - 3, `${first} → ${later}`);
    em.dispose();
    const up = new ParticleEmitter(
      settings({ emissionRate: 100, startLifetime: 10, startSpeed: 0, shape: "box", shapeRadius: 0, gravityModifier: -1, maxParticles: 500 }),
    );
    up.update(1 / 60);
    const y0 = bufPos(up, 0).y;
    advance(up, 1);
    check("负重力 → 上浮", bufPos(up, 0).y > y0 + 3);
    up.dispose();
  }
  // —— 非循环：duration 后停止发射，粒子消亡后 finished；play() 重启 ——
  {
    const em = new ParticleEmitter(
      settings({ looping: false, duration: 0.5, emissionRate: 100, startLifetime: 0.3, maxParticles: 500 }),
    );
    advance(em, 0.4);
    check("发射窗口内有粒子", em.aliveCount > 0);
    check("发射窗口内未 finished", !em.finished);
    advance(em, 1.5);
    check("非循环：duration + lifetime 后粒子全部消亡", em.aliveCount === 0, String(em.aliveCount));
    check("非循环：finished=true", em.finished);
    check("state.playing=false（已播完）", !em.state.playing);
    em.play();
    check("play() 从头开始（time 归零）", em.state.time === 0 && !em.finished);
    advance(em, 0.2);
    check("重播后重新发射", em.aliveCount > 0);
    em.dispose();
  }
  // —— 起始延迟 ——
  {
    const em = new ParticleEmitter(settings({ startDelay: 1, emissionRate: 100, startLifetime: 5, maxParticles: 500 }));
    advance(em, 0.8);
    check("startDelay 内不发射", em.aliveCount === 0, String(em.aliveCount));
    advance(em, 0.6);
    check("startDelay 后开始发射", em.aliveCount > 0);
    em.dispose();
  }
  // —— 暂停 / 停止 / 清空 / 重启 ——
  {
    const em = new ParticleEmitter(settings({ emissionRate: 100, startLifetime: 0.5, maxParticles: 500 }));
    advance(em, 0.3);
    const before = em.aliveCount;
    const t0 = em.state.time;
    em.pause();
    advance(em, 1);
    check("pause 期间粒子数与时间冻结", em.aliveCount === before && em.state.time === t0 && em.state.paused);
    em.play();
    advance(em, 1 / 60);
    check("play 续播（时间前进）", em.state.time > t0 && !em.state.paused);
    em.stop();
    advance(em, 1);
    check("stop 后不再发射，粒子自然消亡", em.aliveCount === 0);
    em.play();
    advance(em, 0.2);
    check("stop 后 play 重新开始发射", em.aliveCount > 0 && em.state.time <= 0.25);
    em.clear();
    check("clear 立即清空但不改播放态", em.aliveCount === 0 && em.state.playing);
    advance(em, 0.3);
    em.restart();
    check("restart 清空 + 时间归零", em.aliveCount === 0 && em.state.time === 0);
    em.dispose();
  }
  // —— 预热：首帧即接近稳态 ——
  {
    const cold = new ParticleEmitter(settings({ prewarm: false, looping: true, duration: 3, emissionRate: 50, startLifetime: 2, maxParticles: 500 }));
    cold.update(1 / 60);
    const warm = new ParticleEmitter(settings({ prewarm: true, looping: true, duration: 3, emissionRate: 50, startLifetime: 2, maxParticles: 500 }));
    warm.update(1 / 60);
    check("未预热首帧粒子极少", cold.aliveCount <= 2, String(cold.aliveCount));
    check("预热首帧即接近稳态（≈ rate×lifetime=100）", warm.aliveCount >= 90 && warm.aliveCount <= 105, String(warm.aliveCount));
    const noLoop = new ParticleEmitter(settings({ prewarm: true, looping: false, duration: 3, emissionRate: 50, startLifetime: 2, maxParticles: 500 }));
    noLoop.update(1 / 60);
    check("非循环系统忽略预热", noLoop.aliveCount <= 2, String(noLoop.aliveCount));
    cold.dispose();
    warm.dispose();
    noLoop.dispose();
  }
  // —— 随寿命颜色 / 尺寸写缓冲 ——
  {
    const em = new ParticleEmitter(
      settings({ emissionRate: 200, startLifetime: 1, startSize: 2, startColor: 0xff0000, endColor: 0x0000ff, colorOverLifetime: true, sizeOverLifetime: true, maxParticles: 500 }),
    );
    advance(em, 0.9);
    const color = em.object.geometry.getAttribute("aColor") as THREE.BufferAttribute;
    const size = em.object.geometry.getAttribute("aSize") as THREE.BufferAttribute;
    let okColor = true;
    let okSize = true;
    let sawFade = false;
    let sawShrunk = false;
    for (let i = 0; i < em.aliveCount; i++) {
      const r = color.getX(i);
      const b = color.getZ(i);
      const a = color.getW(i);
      // 红 → 蓝插值：r+b ≈ 1；alpha 在 [0,1]
      if (!approx(r + b, 1, 1e-3) || a < 0 || a > 1) okColor = false;
      if (a < 0.99) sawFade = true;
      const s = size.getX(i);
      if (s < 0 || s > 2 + 1e-6) okSize = false;
      if (s < 1.9) sawShrunk = true;
    }
    check("colorOverLifetime：start→end 插值且 alpha ∈ [0,1]", okColor && em.aliveCount > 0);
    check("colorOverLifetime：末段出现淡出", sawFade);
    check("sizeOverLifetime：尺寸在 (0, startSize] 且出现缩小", okSize && sawShrunk);
    em.dispose();

    const flat = new ParticleEmitter(
      settings({ emissionRate: 200, startLifetime: 1, startSize: 2, startColor: 0x00ff00, colorOverLifetime: false, sizeOverLifetime: false, maxParticles: 500 }),
    );
    advance(flat, 0.9);
    const fc = flat.object.geometry.getAttribute("aColor") as THREE.BufferAttribute;
    const fs = flat.object.geometry.getAttribute("aSize") as THREE.BufferAttribute;
    let okFlat = flat.aliveCount > 0;
    for (let i = 0; i < flat.aliveCount; i++) {
      if (!approx(fc.getY(i), 1) || !approx(fc.getW(i), 1) || !approx(fs.getX(i), 2)) okFlat = false;
    }
    check("关闭随寿期：颜色/alpha/尺寸恒定", okFlat);
    flat.dispose();
  }
  // —— world 模拟空间：旧粒子留在世界，缓冲按宿主逆矩阵回本地 ——
  {
    const host = new THREE.Group();
    host.position.set(10, 0, 0);
    const em = new ParticleEmitter(
      settings({ simulationSpace: "world", emissionRate: 100, startLifetime: 10, startSpeed: 0, shape: "box", shapeRadius: 0, gravityModifier: 0, maxParticles: 500 }),
    );
    host.add(em.object);
    em.update(1 / 60, host);
    const local0 = bufPos(em, 0);
    check("world 空间：缓冲为本地坐标（出生在宿主处 → 本地 ≈ 0）", approx(local0.length(), 0, 1e-4), local0.toArray().join(","));
    host.position.set(20, 0, 0);
    em.pause(); // 不再发射，只重写缓冲
    em.play();
    em.update(0, host);
    const local1 = bufPos(em, 0);
    check("world 空间：宿主移动后旧粒子留在原地（本地 x ≈ -10）", approx(local1.x, -10, 1e-4), local1.toArray().join(","));
    em.dispose();

    const localHost = new THREE.Group();
    localHost.position.set(10, 0, 0);
    const lm = new ParticleEmitter(
      settings({ simulationSpace: "local", emissionRate: 100, startLifetime: 10, startSpeed: 0, shape: "box", shapeRadius: 0, gravityModifier: 0, maxParticles: 500 }),
    );
    localHost.add(lm.object);
    lm.update(1 / 60, localHost);
    localHost.position.set(20, 0, 0);
    lm.update(0, localHost);
    check("local 空间：宿主移动粒子跟随（本地坐标不变）", approx(bufPos(lm, 0).length(), 0, 1e-4));
    lm.dispose();
  }
  // —— world 空间：方向随宿主旋转 ——
  {
    const host = new THREE.Group();
    host.rotation.y = Math.PI / 2; // 本地 -Z → 世界 -X
    const em = new ParticleEmitter(
      settings({ simulationSpace: "world", emissionRate: 600, startLifetime: 10, startSpeed: 2, shape: "cone", shapeAngle: 0, shapeRadius: 0, gravityModifier: 0, maxParticles: 200 }),
    );
    host.add(em.object);
    advance(em, 0.5, host);
    // 缓冲是本地坐标：世界 -X 方向对应本地 -Z（旋转逆变换），验证本地 z<0 且 x≈0
    let ok = em.aliveCount > 0;
    for (let i = 0; i < em.aliveCount; i++) {
      const p = bufPos(em, i);
      if (!(p.z < 0 && approx(p.x, 0, 1e-3))) ok = false;
    }
    check("world 空间：发射方向经宿主旋转后回本地仍为 -Z", ok);
    em.dispose();
  }
  // —— 原地更新 vs 结构重建 ——
  {
    const base = settings({ emissionRate: 100, startLifetime: 5, maxParticles: 500, blending: "additive" });
    const em = new ParticleEmitter(base);
    advance(em, 0.5);
    const alive = em.aliveCount;
    check("needsRebuild：只改速率 → false", !em.needsRebuild({ ...base, emissionRate: 1 }));
    check("needsRebuild：改容量 → true", em.needsRebuild({ ...base, maxParticles: 501 }));
    check("needsRebuild：改混合 → true", em.needsRebuild({ ...base, blending: "normal" }));
    em.setSettings({ ...base, emissionRate: 1 });
    check("setSettings 原地更新不重置存活粒子", em.aliveCount === alive && em.current.emissionRate === 1);
    em.setSettings({ ...base, simulationSpace: "world" });
    check("切换模拟空间清空粒子", em.aliveCount === 0);
    em.dispose();
    const normal = new ParticleEmitter(settings({ blending: "normal" }));
    check("normal 混合 → NormalBlending", normal.object.material.blending === THREE.NormalBlending);
    const additive = new ParticleEmitter(settings({ blending: "additive" }));
    check("additive 混合 → AdditiveBlending", additive.object.material.blending === THREE.AdditiveBlending);
    check("材质透明 + 不写深度 + 关视锥剔除", additive.object.material.transparent && !additive.object.material.depthWrite && !additive.object.frustumCulled);
    check("Points 命名 __particles 且 userData 指回发射器", additive.object.name === PARTICLES_CHILD_NAME && additive.object.userData.particleEmitter === additive);
    normal.dispose();
    additive.dispose();
  }
  // —— 大 dt 钳制：切标签页回来不爆发 ——
  {
    const em = new ParticleEmitter(settings({ emissionRate: 100, startLifetime: 5, maxParticles: 5000 }));
    em.update(10);
    check("单帧最多推进 0.1s（10s 帧只发约 10 粒子）", em.aliveCount <= 12, String(em.aliveCount));
    em.dispose();
  }
  // —— dispose ——
  {
    const host = new THREE.Group();
    const em = new ParticleEmitter(settings({}));
    host.add(em.object);
    em.dispose();
    check("dispose 从宿主摘除", host.children.length === 0 && em.object.userData.particleEmitter === null);
  }
}

// ===========================================================================
console.log("[4] 同步器 + ParticleSystem 运行时");
{
  const scene = new THREE.Scene();
  const sync = new SceneSynchronizer(scene);
  const runtime = new ParticleSystem();
  const registry = createDefaultRegistry();
  const factory = createNodeFactory(registry);

  const root = new Node({ name: "Root" });
  const ps = factory.createParticleSystem({ parentId: root.id });
  ps.particles.startColor = 0x123456;
  ps.layer = 3;
  root.addChildId(ps.id);
  const graph = fakeGraph([root, ps]);
  sync.rebuildAll(graph);

  const obj = sync.getObjectMap().get(ps.id)!;
  check("粒子节点映射为 Group", !!obj && (obj as THREE.Group).isGroup === true);
  check("nodeKind 标记", obj.userData.nodeKind === "particleSystemNode");
  const icon = obj.children.find((c) => c.name === "__particleIcon") as THREE.Sprite | undefined;
  check("同步器挂火花图标精灵", !!icon && (icon as THREE.Sprite).isSprite === true);
  check("图标按 startColor 着色", !!icon && (icon.material as THREE.SpriteMaterial).color.getHex() === 0x123456);
  check("同步器阶段不建 Points（由运行时挂）", !obj.children.some((c) => c.name === PARTICLES_CHILD_NAME));

  runtime.syncNode(ps, obj);
  const points = obj.children.find((c) => c.name === PARTICLES_CHILD_NAME) as THREE.Points | undefined;
  check("syncNode 挂 __particles Points", !!points && (points as THREE.Points).isPoints === true);
  check("Points 跟随节点层（layer 3）", !!points && points.layers.mask === 1 << 3, String(points?.layers.mask));
  check("stateFor 返回运行态", runtime.stateFor(ps.id)?.alive === 0 && runtime.stateFor(ps.id)?.playing === true);
  check("未绑定节点 stateFor → null", runtime.stateFor("nope") === null);

  runtime.update(1 / 30);
  runtime.update(1 / 30);
  check("运行时 update 推进发射", (runtime.stateFor(ps.id)?.alive ?? 0) > 0);

  // 属性变更：非结构参数 → 同一发射器实例
  const em1 = runtime.emitterOf(ps.id);
  ps.particles.emissionRate = 5;
  sync.onGraphChange({ kind: "properties", nodeId: ps.id }, graph);
  runtime.syncNode(ps, obj);
  check("非结构参数变更 → 发射器实例复用", runtime.emitterOf(ps.id) === em1 && em1?.current.emissionRate === 5);
  check("图标仍唯一（属性刷新不重复挂）", obj.children.filter((c) => c.name === "__particleIcon").length === 1);

  // 结构参数变更 → 重建
  ps.particles.maxParticles = 77;
  runtime.syncNode(ps, obj);
  const em2 = runtime.emitterOf(ps.id);
  check("结构参数变更 → 发射器重建", em2 !== em1 && em2 !== null);
  check("重建后旧 Points 已摘除，仅剩一个", obj.children.filter((c) => c.name === PARTICLES_CHILD_NAME).length === 1);
  check("重建后容量生效", (em2!.object.geometry.getAttribute("position") as THREE.BufferAttribute).count === 77);

  // 层变更：同步器 applyNodeLayer 同步到 Points
  ps.layer = 5;
  sync.onGraphChange({ kind: "properties", nodeId: ps.id }, graph);
  const points2 = obj.children.find((c) => c.name === PARTICLES_CHILD_NAME)!;
  check("节点层变更 → 同步器把 Points 层同步为 5", points2.layers.mask === 1 << 5, String(points2.layers.mask));

  // 播放控制 + 变更广播
  let notified = "";
  runtime.onChange((id) => (notified = id));
  check("pause 返回 true 并广播", runtime.pause(ps.id) && notified === ps.id && runtime.stateFor(ps.id)?.paused === true);
  check("restart 清空", runtime.restart(ps.id) && runtime.stateFor(ps.id)?.alive === 0);
  check("未绑定 id 的控制返回 false", !runtime.play("nope") && !runtime.restart("nope"));

  // 重新绑定到新对象（场景重建）
  const obj2 = new THREE.Group();
  runtime.syncNode(ps, obj2);
  check("宿主对象变化 → 重挂到新对象", obj2.children.some((c) => c.name === PARTICLES_CHILD_NAME) && !obj.children.some((c) => c.name === PARTICLES_CHILD_NAME));

  // 解绑
  runtime.unbind(ps.id);
  check("unbind 摘除 Points", !obj2.children.some((c) => c.name === PARTICLES_CHILD_NAME) && runtime.emitterOf(ps.id) === null);
  runtime.syncNode(ps, obj2);
  runtime.unbindAll();
  check("unbindAll 清空", runtime.stateFor(ps.id) === null);
  runtime.dispose();
  sync.dispose();
}

// ===========================================================================
console.log("[5] 脚本 SDK 契约（tve.d.ts ↔ tve.mjs 镜像）");
{
  const dts = readFileSync(resolve(process.cwd(), "src/framework/scripting/tve.d.ts"), "utf8");
  const mjs = readFileSync(resolve(process.cwd(), "public/engine/core/tve.mjs"), "utf8");
  check("d.ts：EntityKind 含 particleSystemNode", /EntityKind[\s\S]*?"particleSystemNode"/.test(dts));
  check("d.ts：ScriptNodeKind 含 particleSystemNode", /ScriptNodeKind[\s\S]*?"particleSystemNode"/.test(dts));
  check("d.ts：声明 class ParticleSystemNode", /export class ParticleSystemNode extends Entity/.test(dts));
  check("d.ts：engine.particles: ParticlesApi", /readonly particles: ParticlesApi/.test(dts));
  check("mjs：KIND_CLASSES 映射 particleSystemNode", /particleSystemNode:\s*ParticleSystemNode/.test(mjs));
  check("mjs：__nodeKinds 登记", /ParticleSystemNode\.__nodeKinds\s*=\s*\["particleSystemNode"\]/.test(mjs));
  check("mjs：engine 挂 particles", /particles:\s*particlesApi/.test(mjs));
  check("mjs：导出 ParticleSystemNode 与小写别名", /ParticleSystemNode as particleSystemNode/.test(mjs));
  check("mjs：灯光设置 cullingMask 收敛语句完整（回归：曾被截断成 umber）", /typeof s\.cullingMask === "number"/.test(mjs) && !/\number &&/.test(mjs));
  const player = readFileSync(resolve(process.cwd(), "public/web-preview/player.mjs"), "utf8");
  check("player：接线 createParticles 并每帧推进", /createParticles\(particles\)/.test(player) && /particlesApi\.update\(dt\)/.test(player));
  check("player：粒子控制传入脚本宿主", /particles:\s*particlesApi/.test(player));
}

console.log(failed ? `\n粒子系统冒烟：${failed} 项失败` : "\n粒子系统冒烟：全部通过");
process.exitCode = failed > 0 ? 1 : 0;
