// 粒子系统冒烟测试（headless，无需 GPU）。
// @priority P1（契约漂移待清：见 tests/ISSUES.md）
// 覆盖五段：
// ① 数据层：设置默认值 / parse 收敛（缺失、非法、越界、枚举回退）/ 深拷贝 / 结构签名；
// ② 节点层：注册表登记、工厂产出、序列化往返、旧场景兼容（无 particles 字段）、clone 深拷贝；
// ③ 发射器模拟：发射速率、寿命回收、容量上限、圆锥方向、重力、非循环停止、起始延迟、
//    播放控制（暂停/停止/重启）、预热、随寿命颜色/尺寸写缓冲、world 模拟空间、
//    原地更新 vs 结构重建；
// ④ 同步器 + ParticleSystem 运行时：图标精灵、Points 挂载、层跟随、属性变更原地更新、
//    结构变更重建、解绑释放；
// ⑤ 脚本 SDK 契约：tve.d.ts 与 tve.mjs 都声明了 ParticleSystemNode / engine.particles。
// 运行：pnpm smoke particles

import * as THREE from "three";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Node } from "../../../src/framework/prototype/Node";
import { ParticleSystemNode } from "../../../src/framework/prototype/nodes/ParticleSystemNode";
import { createDefaultRegistry } from "../../../src/framework/prototype/PrototypeRegistry";
import { createNodeFactory } from "../../../src/framework/factory/NodeFactory";
import {
  DEFAULT_PARTICLE_SETTINGS,
  PARTICLE_LIMITS,
  PARTICLES_CHILD_NAME,
  ParticleEmitter,
  ParticleSystem,
  cloneParticleSystemSettings,
  createGlslParticleMaterial,
  getParticleSpriteTexture,
  isParticleTextureRel,
  parseParticleSystemSettings,
  particleStructureSignature,
  type ParticleSystemSettings,
} from "../../../src/framework/particles";
import { SceneSynchronizer } from "../../../src/framework/engine/modules/SceneSynchronizer";
import type { GraphLike } from "../../../src/framework/scene/SceneClient";
import { approx, createSuite } from "../harness.mjs";

const { check, finish } = createSuite();

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
  const a = em.object.geometry.getAttribute("iPos") as THREE.BufferAttribute;
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
  check("texture 缺省为空串（内置软圆点）", d.texture === "");
  check("texture 非字符串回空串", parseParticleSystemSettings({ texture: 42 }).texture === "");
  check("texture 字符串原样保留", parseParticleSystemSettings({ texture: "assets/textures/spark.png" }).texture === "assets/textures/spark.png");
  check("isParticleTextureRel：png/webp 通过，mat/无扩展名拒绝", isParticleTextureRel("a/b.PNG") && isParticleTextureRel("x.webp") && !isParticleTextureRel("m.mat") && !isParticleTextureRel("noext"));

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
    check(
      "贴图不属结构参数（换贴图不重建）",
      particleStructureSignature(settings({ texture: "a.png" })) === particleStructureSignature(settings({ texture: "" })),
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
    check("instanceCount 跟随存活数（逐实例绘制数量）", em.object.geometry.instanceCount === em.aliveCount);
    em.dispose();
  }
  // —— 容量上限 ——
  {
    const em = new ParticleEmitter(settings({ emissionRate: 5000, startLifetime: 10, maxParticles: 50 }));
    advance(em, 1);
    check("maxParticles 封顶", em.aliveCount === 50, String(em.aliveCount));
    check("超容量不影响缓冲长度", (em.object.geometry.getAttribute("iPos") as THREE.BufferAttribute).count === 50);
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
  // —— 随寿命颜色 / 尺寸：逐粒子只上传 iT，插值在着色器（端点色与开关走 uniform）——
  {
    const em = new ParticleEmitter(
      settings({ emissionRate: 200, startLifetime: 1, startSize: 2, startColor: 0xff0000, endColor: 0x0000ff, colorOverLifetime: true, sizeOverLifetime: true, maxParticles: 500 }),
    );
    advance(em, 0.9);
    const tAttr = em.object.geometry.getAttribute("iT") as THREE.BufferAttribute;
    let okRange = em.aliveCount > 0;
    let minT = Infinity;
    let maxT = -Infinity;
    for (let i = 0; i < em.aliveCount; i++) {
      const v = tAttr.getX(i);
      if (v < 0 || v > 1) okRange = false;
      minT = Math.min(minT, v);
      maxT = Math.max(maxT, v);
    }
    check("iT 为归一化寿命且落在 [0,1]", okRange);
    check("iT 随年龄铺开（同帧粒子进度不同）", maxT - minT > 0.5, `${minT.toFixed(2)}~${maxT.toFixed(2)}`);
    const u = em.object.material.uniforms;
    check(
      "逐粒子不再上传颜色/尺寸（端点色与开关走 uniform）",
      !em.object.geometry.getAttribute("aColor") &&
        !em.object.geometry.getAttribute("aSize") &&
        (u.uStartColor.value as THREE.Color).getHex() === 0xff0000 &&
        (u.uEndColor.value as THREE.Color).getHex() === 0x0000ff &&
        u.uStartSize.value === 2 &&
        u.uColorOverLifetime.value === 1 &&
        u.uSizeOverLifetime.value === 1,
    );
    const sc = u.uStartColor.value as THREE.Color;
    check(
      "端点色写入线性空间（与 PBR 管线一致）",
      approx(sc.r, 1, 1e-3) && approx(sc.g, 0, 1e-3) && approx(sc.b, 0, 1e-3),
    );
    em.dispose();

    const flat = new ParticleEmitter(settings({ colorOverLifetime: false, sizeOverLifetime: false }));
    const fu = flat.object.material.uniforms;
    check(
      "关闭随寿期 → 开关 uniform 为 0（着色器取恒定色与全尺寸）",
      fu.uColorOverLifetime.value === 0 && fu.uSizeOverLifetime.value === 0,
    );
    flat.dispose();
  }
  // —— 缓冲上传：只上传存活区间（addUpdateRange），且范围不逐帧累积 ——
  {
    const em = new ParticleEmitter(settings({ emissionRate: 60, startLifetime: 1, maxParticles: 500 }));
    advance(em, 0.4);
    const iPos = em.object.geometry.getAttribute("iPos") as THREE.InstancedBufferAttribute;
    const iT = em.object.geometry.getAttribute("iT") as THREE.InstancedBufferAttribute;
    check(
      "稀疏系统只登记存活区间（容量 500 / 存活 ~24）",
      iPos.updateRanges.length === 1 &&
        iPos.updateRanges[0].start === 0 &&
        iPos.updateRanges[0].count === em.aliveCount * 3 &&
        iT.updateRanges.length === 1 &&
        iT.updateRanges[0].count === em.aliveCount,
    );
    advance(em, 0.4);
    check("多帧后区间不累积（每帧登记前先清空）", iPos.updateRanges.length === 1);
    const full = new ParticleEmitter(settings({ emissionRate: 5000, startLifetime: 10, maxParticles: 40 }));
    advance(full, 1);
    check(
      "满容量走整段上传（不登记区间）",
      full.aliveCount === 40 &&
        (full.object.geometry.getAttribute("iPos") as THREE.InstancedBufferAttribute).updateRanges.length === 0,
    );
    em.dispose();
    full.dispose();
  }
  // —— 零拷贝：local 空间模拟数组即渲染缓冲；world 空间每帧回写 ——
  {
    const opts = {
      emissionRate: 100,
      startLifetime: 5,
      startSpeed: 0,
      shape: "box" as const,
      shapeRadius: 0,
      gravityModifier: 0,
      maxParticles: 8,
    };
    const local = new ParticleEmitter(settings({ ...opts, simulationSpace: "local" }));
    local.update(1 / 60);
    const arrL = (local.object.geometry.getAttribute("iPos") as THREE.BufferAttribute).array as Float32Array;
    arrL[0] = 7;
    local.update(1 / 60);
    check("local 空间：模拟数组即 iPos 缓冲（写入不被回写覆盖 = 零拷贝）", arrL[0] === 7);
    local.dispose();

    const world = new ParticleEmitter(settings({ ...opts, simulationSpace: "world" }));
    const hostW = new THREE.Group();
    hostW.add(world.object);
    world.update(1 / 60, hostW);
    const arrW = (world.object.geometry.getAttribute("iPos") as THREE.BufferAttribute).array as Float32Array;
    arrW[0] = 7;
    world.update(1 / 60, hostW);
    check("world 空间：每帧按世界坐标回写本地坐标（与模拟数组分离）", arrW[0] !== 7);
    world.dispose();
  }
  // —— 满容量：轮转覆盖最旧（新粒子不被丢弃） ——
  {
    const em = new ParticleEmitter(
      settings({ emissionRate: 1000, startLifetime: 10, maxParticles: 20, shape: "box", shapeRadius: 0, startSpeed: 0, gravityModifier: 0 }),
    );
    advance(em, 1);
    const tAttr = em.object.geometry.getAttribute("iT") as THREE.BufferAttribute;
    let maxT = 0;
    for (let i = 0; i < em.aliveCount; i++) maxT = Math.max(maxT, tAttr.getX(i));
    // 1000/s 发射 1 秒 = 1000 个粒子进 20 槽；若满池即丢弃则粒子会老化到 iT≈0.1，
    // 实为持续覆盖 → 全部是刚发射的新粒子（iT 极小）
    check("满容量持续覆盖最旧（完全不断流）", em.aliveCount === 20 && maxT < 0.01, `maxT=${maxT.toFixed(4)}`);
    em.dispose();
  }
  // —— 包围球：按存活粒子重算（视锥剔除可用） ——
  {
    const em = new ParticleEmitter(
      settings({ emissionRate: 200, startLifetime: 5, startSpeed: 5, shape: "box", shapeRadius: 0, maxParticles: 200 }),
    );
    check("空系统包围球半径 0", em.object.geometry.boundingSphere?.radius === 0);
    advance(em, 0.5);
    const sphere = em.object.geometry.boundingSphere as THREE.Sphere;
    let inside = true;
    for (let i = 0; i < em.aliveCount; i++) {
      if (bufPos(em, i).distanceTo(sphere.center) > sphere.radius + 1e-6) inside = false;
    }
    check(
      "包围球覆盖全部存活粒子（含粒子半径余量）",
      inside && sphere.radius > 0 && em.object.frustumCulled === true,
    );
    em.dispose();
    // 多发射器各自独占包围球实例：共用同一个 Sphere 会让后更新者的范围覆盖其余
    // 发射器（三个渲染时读的是各 geometry.boundingSphere），视锥剔除随之出错
    const a = new ParticleEmitter(settings({ emissionRate: 200, startLifetime: 5, maxParticles: 200 }));
    const b = new ParticleEmitter(settings({ emissionRate: 200, startLifetime: 5, maxParticles: 200 }));
    advance(a, 0.3);
    advance(b, 0.3);
    check(
      "每个发射器独占包围球实例（互不覆盖）",
      a.object.geometry.boundingSphere !== b.object.geometry.boundingSphere,
    );
    a.dispose();
    b.dispose();
  }
  // —— 材质工厂注入（后端选择：GLSL / TSL 由工厂决定） ——
  {
    let made = 0;
    const em = new ParticleEmitter(settings({}), (s) => {
      made++;
      return createGlslParticleMaterial(s);
    });
    check("按注入的材质工厂创建材质", made === 1);
    check(
      "四边形基础几何：4 顶点 + 2 三角 + 逐实例属性 iPos/iT",
      (em.object.geometry.getAttribute("position") as THREE.BufferAttribute).count === 4 &&
        em.object.geometry.index?.count === 6 &&
        (em.object.geometry.getAttribute("iPos") as THREE.BufferAttribute).isInstancedBufferAttribute === true &&
        (em.object.geometry.getAttribute("iT") as THREE.BufferAttribute).isInstancedBufferAttribute === true &&
        em.object.geometry.isInstancedBufferGeometry === true,
    );
    em.dispose();
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
    check("材质透明 + 不写深度 + 开启视锥剔除", additive.object.material.transparent && !additive.object.material.depthWrite && additive.object.frustumCulled === true);
    check("实例网格命名 __particles 且 userData 指回发射器", additive.object.name === PARTICLES_CHILD_NAME && additive.object.userData.particleEmitter === additive);
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
  // —— 贴图：默认内置软圆点；setTexture 热替换；null 回内置 ——
  {
    const em = new ParticleEmitter(settings({}));
    const sprite = getParticleSpriteTexture();
    check("默认采样内置软圆点", em.texture === sprite);
    check(
      "内置软圆点为 64×64 RGBA DataTexture（全局共享一份）",
      sprite.image.width === 64 && sprite.image.height === 64 && getParticleSpriteTexture() === sprite,
    );
    const user = new THREE.Texture();
    em.setTexture(user);
    check("setTexture 热替换材质 uniform", em.texture === user && em.object.material.uniforms.uMap.value === user);
    em.setTexture(null);
    check("setTexture(null) 回内置软圆点", em.texture === sprite);
    const fs = em.object.material.fragmentShader;
    check(
      "片元着色器：按 UV 采样贴图并把贴图 RGB 乘进粒子颜色",
      /texture2D\( uMap, vUv \)/.test(fs) && /vColor\.rgb \* texel\.rgb/.test(fs),
    );
    const vs = em.object.material.vertexShader;
    check(
      "顶点着色器：视空间 billboard（无需点尺寸换算、不受点尺寸上限裁剪）",
      /mv\.xy \+= position\.xy \* size/.test(vs) && !/gl_PointSize/.test(vs),
    );
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
  check("syncNode 挂 __particles 实例网格", !!points && (points as THREE.Mesh).isMesh === true);
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
  check("重建后容量生效", (em2!.object.geometry.getAttribute("iPos") as THREE.BufferAttribute).count === 77);

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

  // 后端切换（材质工厂变化，如切到 WebGPU）→ 已绑定发射器重建并保留设置/层/贴图引用
  {
    runtime.update(1 / 30);
    const before = runtime.emitterOf(ps.id);
    ps.particles.emissionRate = 7;
    runtime.syncNode(ps, obj2);
    let madeByFactory = 0;
    runtime.setMaterialFactory((s) => {
      madeByFactory++;
      return createGlslParticleMaterial(s);
    });
    const after = runtime.emitterOf(ps.id);
    const mesh = obj2.children.find((c) => c.name === PARTICLES_CHILD_NAME)!;
    check(
      "材质工厂变化 → 发射器重建并沿用设置/层/单一子对象",
      after !== null &&
        after !== before &&
        madeByFactory === 1 &&
        after.current.emissionRate === 7 &&
        after.object.layers.mask === (1 << 5) &&
        obj2.children.filter((c) => c.name === PARTICLES_CHILD_NAME).length === 1 &&
        mesh === after.object,
    );
  }

  // 解绑
  runtime.unbind(ps.id);
  check("unbind 摘除实例网格", !obj2.children.some((c) => c.name === PARTICLES_CHILD_NAME) && runtime.emitterOf(ps.id) === null);
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
  // KIND_CLASSES/属性表自 tve 拆分后（39a16d9）位于 node-types.mjs；灯光收敛在 core/lights.mjs
  const nodeTypes = readFileSync(resolve(process.cwd(), "public/engine/core/tve/node-types.mjs"), "utf8");
  const lightsMjs = readFileSync(resolve(process.cwd(), "public/engine/core/lights.mjs"), "utf8");
  check("d.ts：EntityKind 含 particleSystemNode", /EntityKind[\s\S]*?"particleSystemNode"/.test(dts));
  check("d.ts：ScriptNodeKind 含 particleSystemNode", /ScriptNodeKind[\s\S]*?"particleSystemNode"/.test(dts));
  check("d.ts：声明 class ParticleSystemNode", /export class ParticleSystemNode extends Entity/.test(dts));
  check("d.ts：engine.particles: ParticlesApi", /readonly particles: ParticlesApi/.test(dts));
  check("mjs：KIND_CLASSES 映射 particleSystemNode", /particleSystemNode:\s*ParticleSystemNode/.test(nodeTypes));
  check("mjs：__nodeKinds 登记", /ParticleSystemNode\.__nodeKinds\s*=\s*\["particleSystemNode"\]/.test(nodeTypes));
  check("mjs：engine 挂 particles", /particles:\s*particlesApi/.test(mjs));
  check("mjs：导出 ParticleSystemNode 与小写别名", /ParticleSystemNode as particleSystemNode/.test(mjs));
  check("mjs：灯光设置 cullingMask 收敛语句完整（回归：曾被截断成 umber）", /typeof s\.cullingMask === "number"/.test(lightsMjs) && !/\number &&/.test(lightsMjs));
  check("d.ts：ParticleSettings / ParticleSystemNode 声明 texture", (dts.match(/^\s+texture: string;/gm) ?? []).length >= 2);
  check("mjs：ParticleSystemNode 属性表含 texture", /"blending",\s*"texture",/.test(nodeTypes));
  const player = readFileSync(resolve(process.cwd(), "public/web-preview/player.mjs"), "utf8");
  check("player：接线 createParticles 并每帧推进", /createParticles\(\s*particles/.test(player) && /particlesApi\.update\(dt\)/.test(player));
  check("player：粒子控制传入脚本宿主", /particles:\s*particlesApi/.test(player));
  check("player：粒子贴图走 textures.mjs 的 loadImageTex（sRGB）", /loadImageTex\(particleTexCache, rel, true\)/.test(player));
  const texSrc = readFileSync(resolve(process.cwd(), "public/engine/runtime/textures.mjs"), "utf8");
  check("textures.mjs 导出 loadImageTex 供粒子复用", /export function loadImageTex/.test(texSrc));
  // 构建导出：Rust 侧收集 particles.texture 并在发布重命名时重写引用
  const migrate = readFileSync(resolve(process.cwd(), "src-tauri/src/scene/migrate.rs"), "utf8");
  const preview = readFileSync(resolve(process.cwd(), "src-tauri/src/preview.rs"), "utf8");
  const build = readFileSync(resolve(process.cwd(), "src-tauri/src/build.rs"), "utf8");
  check("Rust：collect_particle_texture_refs 存在并在导出收集中调用", /pub fn collect_particle_texture_refs/.test(migrate) && /collect_particle_texture_refs\(&scene_json/.test(preview));
  check("Rust：发布重命名重写 particles.texture", /k == "particles"/.test(build) && /get_mut\("texture"\)/.test(build));
}

/** 等待异步贴图链路（catch + then 两级微任务）落定 */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ===========================================================================
async function previewPackagingSection(): Promise<void> {
  console.log("[7] 预览/导出打包：WebGPU 运行时按项目后端按需包含");
  const {
    configUsesWebgpu,
    WEB_PREVIEW_RUNTIME_FILES,
    WEB_PREVIEW_WEBGPU_FILES,
  } = await import("../../../src/app/lib/web-preview-runtime");

  // 清单：WebGPU 运行时单独分组，不进基础清单（WebGL 项目不多带 ~670KB）
  check(
    "WebGPU 运行时分组含 three 的 WebGPU 构建与粒子 TSL 材质",
    WEB_PREVIEW_WEBGPU_FILES.includes("engine/core/three.webgpu.min.js") &&
      WEB_PREVIEW_WEBGPU_FILES.includes("engine/core/particleNodeMaterial.mjs"),
    WEB_PREVIEW_WEBGPU_FILES.join(", "),
  );
  check(
    "基础清单不含 WebGPU 构建（按需包含）",
    !WEB_PREVIEW_RUNTIME_FILES.some((f) => f.includes("three.webgpu")),
  );
  check(
    "基础清单仍含 WebGL 构建与粒子运行时",
    WEB_PREVIEW_RUNTIME_FILES.includes("engine/core/three.module.min.js") &&
      WEB_PREVIEW_RUNTIME_FILES.includes("engine/core/particles.mjs"),
  );

  // 项目配置 → 是否随产物（webgl 不随；webgpu/auto 随；缺失/损坏按不随）
  check("renderer=webgl → 不带 WebGPU 运行时", !configUsesWebgpu('{"renderer":"webgl"}'));
  check("renderer=webgpu → 带 WebGPU 运行时", configUsesWebgpu('{"renderer":"webgpu"}'));
  check("renderer=auto → 带 WebGPU 运行时", configUsesWebgpu('{"renderer":"auto"}'));
  check(
    "配置缺失/损坏/未知值 → 不带（产物按 WebGL，播放器仍可回退）",
    !configUsesWebgpu(null) &&
      !configUsesWebgpu("") &&
      !configUsesWebgpu("{ not json") &&
      !configUsesWebgpu("{}") &&
      !configUsesWebgpu('{"renderer":"vulkan"}'),
  );

  // 播放器与舞台：后端选择 / 动态加载 / 回退 / TSL 注入
  const player = readFileSync(resolve("public/web-preview/player.mjs"), "utf8");
  check(
    "播放器按项目设置创建渲染后端并把 TSL 工厂注入粒子",
    /await createRenderer\(cfg\)/.test(player) &&
      /backend === "webgpu"/.test(player) &&
      /createNodeParticleMaterialFactory\(\)/.test(player) &&
      /particleMaterialFactory/.test(player),
  );
  check(
    "播放器在 WebGPU 下注入节点材质后端（材质 Hook 走 TSL 端口）",
    /setNodeMaterialBackend/.test(player) &&
      /nodeMaterialHooks.mjs/.test(player) &&
      /createNodeMaterialBackend()/.test(player),
  );
  const stage = readFileSync(resolve("public/engine/runtime/stage.mjs"), "utf8");
  check(
    "舞台层动态加载 WebGPU 构建并在失败时回退 WebGL",
    /export async function createRenderer/.test(stage) &&
      /import\("\.\.\/core\/three\.webgpu\.min\.js"\)/.test(stage) &&
      /已回退 WebGL/.test(stage),
  );
  check("舞台按后端返回 backend 标识（供后端相关材质选择）", /backend: "webgpu"/.test(stage) && /backend: "webgl"/.test(stage));

  // WebGPU 构建无裸导入（预览运行时无打包器，浏览器直载）
  const webgpuSrc = readFileSync(resolve("public/engine/core/three.webgpu.min.js"), "utf8");
  const deps = [...webgpuSrc.matchAll(/from\s*"([^"]+)"/g)].map((m) => m[1]);
  check(
    "WebGPU 构建仅依赖 three.core.min.js（与 WebGL 构建共享核心类）",
    deps.length > 0 && deps.every((d) => d === "./three.core.min.js"),
    deps.join(", "),
  );

  // 运行时粒子系统：三条创建路径（结构重建 / 运行期新增 / 场景树构建）都透传材质工厂
  const rs = readFileSync(resolve("public/engine/runtime/particles.mjs"), "utf8");
  const nodesSrc = readFileSync(resolve("public/engine/runtime/nodes.mjs"), "utf8");
  const withFactory =
    (rs.match(/createParticleEmitter\([^)]*factory\)/g) ?? []).length +
    (nodesSrc.match(/createParticleEmitter\([^)]*ctx\.particleMaterial\)/g) ?? []).length;
  check("粒子系统三条创建路径都透传材质工厂（重建/新增/场景树）", withFactory >= 3, `${withFactory} 处`);
  const core = readFileSync(resolve("public/engine/core/particles.mjs"), "utf8");
  check(
    "运行时导出 GLSL 材质工厂并支持注入（句柄接口与编辑器一致）",
    /export function createGlslParticleMaterial/.test(core) &&
      /materialFactory \?\? createGlslParticleMaterial/.test(core),
  );
}

// ===========================================================================
async function textureSection(): Promise<void> {
  console.log("[6] ParticleSystem 贴图异步加载（加载器注入 / 热替换 / 过期丢弃 / 失败回退）");
  const runtime = new ParticleSystem();
  const host = new THREE.Group();
  const factory = createNodeFactory(createDefaultRegistry());
  const ps = factory.createParticleSystem();
  const sprite = getParticleSpriteTexture();
  const texA = new THREE.Texture();
  const texB = new THREE.Texture();
  const calls: string[] = [];
  let resolveSlow: (t: THREE.Texture | null) => void = () => {};
  runtime.setTextureLoader((rel) => {
    calls.push(rel);
    if (rel === "slow.png") return new Promise((r) => (resolveSlow = r));
    if (rel === "b.png") return Promise.resolve(texB);
    if (rel === "fail.png") return Promise.reject(new Error("nope"));
    return Promise.resolve(null);
  });
  const emitter = () => runtime.emitterOf(ps.id)!;

  runtime.syncNode(ps, host);
  check("空贴图：不调用加载器，采样内置软圆点", calls.length === 0 && emitter().texture === sprite);

  ps.particles.texture = "b.png";
  runtime.syncNode(ps, host);
  check("贴图引用变更触发加载（rel 原样传入）", calls.length === 1 && calls[0] === "b.png");
  check("加载中仍采样内置软圆点（不闪黑）", emitter().texture === sprite);
  await tick();
  check("加载完成热替换到用户贴图", emitter().texture === texB);
  runtime.syncNode(ps, host);
  check("同一引用重复 sync 不重复加载", calls.length === 1);

  // 过期结果丢弃：先选慢贴图，再切回快贴图；慢贴图之后才返回，不应覆盖
  ps.particles.texture = "slow.png";
  runtime.syncNode(ps, host);
  ps.particles.texture = "b.png";
  runtime.syncNode(ps, host);
  await tick();
  check("切换后先采样后选的贴图", emitter().texture === texB);
  resolveSlow(texA);
  await tick();
  check("过期的慢结果不覆盖新选择", emitter().texture === texB);

  ps.particles.texture = "fail.png";
  runtime.syncNode(ps, host);
  await tick();
  check("加载失败回内置软圆点", emitter().texture === sprite);
  ps.particles.texture = "missing.png";
  runtime.syncNode(ps, host);
  await tick();
  check("加载器返回 null 回内置软圆点", emitter().texture === sprite);

  ps.particles.texture = "b.png";
  runtime.syncNode(ps, host);
  await tick();
  ps.particles.texture = "";
  runtime.syncNode(ps, host);
  check("清空贴图立即回内置（不等异步）", emitter().texture === sprite);

  ps.particles.texture = "b.png";
  runtime.syncNode(ps, host);
  await tick();
  const before = calls.length;
  ps.particles.maxParticles = 33;
  runtime.syncNode(ps, host);
  await tick();
  check("结构重建后新发射器重新取贴图", calls.length === before + 1 && emitter().texture === texB);

  const before2 = calls.length;
  runtime.setTextureLoader((rel) => {
    calls.push(rel);
    return Promise.resolve(texA);
  });
  await tick();
  check("重装加载器（项目切换）后已绑定发射器按新加载器重取", calls.length === before2 + 1 && emitter().texture === texA);
  runtime.setTextureLoader(null);
  check("断开加载器回内置软圆点", emitter().texture === sprite);

  // 解绑后在途结果作废（不抛错、不写入已释放的发射器）
  runtime.setTextureLoader((rel) => {
    calls.push(rel);
    return new Promise((r) => (resolveSlow = r));
  });
  const doomed = emitter();
  runtime.unbind(ps.id);
  resolveSlow(texA);
  await tick();
  check("解绑后在途贴图结果被丢弃", runtime.emitterOf(ps.id) === null && doomed.texture === sprite);
  runtime.dispose();
}

void textureSection().then(async () => {
  await previewPackagingSection();
  finish();
});
