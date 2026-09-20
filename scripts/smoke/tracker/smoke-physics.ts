// 物理后端冒烟测试：真实加载 rapier/jolt WASM，建 世界 + 静态地板 + 动力学球，
// 步进 2 秒验证球落到地板上（动力学）与运动学目标生效；高度场段：静态斜坡
// 高度场（沿 +x 从 0 升到 4）+ 两球落点校准 y 对齐/方向（各引擎高度场约定
// 不同：rapier 绝对高度列主序、jolt mOffset/mScale、ammo 中线原点需补偿）。
// 运行：pnpm smoke physics

import { createRapierWorld } from "../../../src/framework/physics/backend/rapierBackend";
import { createJoltWorld } from "../../../src/framework/physics/backend/joltBackend";

const GRAVITY = { x: 0, y: -9.81, z: 0 };
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

interface WorldFactory {
  (backend: string): Promise<import("../../../src/framework/physics/backend/types").IPhysicsWorld>;
}

type ShapeDesc = import("../../../src/framework/physics/backend/types").ColliderShapeDesc;

function floorDesc(): import("../../../src/framework/physics/backend/types").PhysicsBodyDesc {
  return {
    nodeId: "floor",
    mode: "static",
    position: { x: 0, y: 0, z: 0 },
    quaternion: IDENTITY,
    colliders: [
      {
        shape: "box",
        halfExtents: { x: 10, y: 0.5, z: 10 },
        radius: 1,
        halfHeight: 1,
        points: [],
        heights: null,
        samples: 0,
        terrainSizeX: 0,
        terrainSizeZ: 0,
        minHeight: 0,
        maxHeight: 0,
        offset: { x: 0, y: -0.5, z: 0 },
        friction: 0.6,
        restitution: 0.1,
        isSensor: false,
      },
    ],
    mass: 1,
    linearDamping: 0,
    angularDamping: 0,
    gravityScale: 1,
    ccd: false,
    lockRotation: false,
    upright: false,
  };
}

function ballDesc(y: number): import("../../../src/framework/physics/backend/types").PhysicsBodyDesc {
  return {
    nodeId: "ball",
    mode: "dynamic",
    position: { x: 0, y, z: 0 },
    quaternion: IDENTITY,
    colliders: [
      {
        shape: "sphere",
        halfExtents: { x: 0.5, y: 0.5, z: 0.5 },
        radius: 0.5,
        halfHeight: 0.5,
        points: [],
        heights: null,
        samples: 0,
        terrainSizeX: 0,
        terrainSizeZ: 0,
        minHeight: 0,
        maxHeight: 0,
        offset: { x: 0, y: 0, z: 0 },
        friction: 0.6,
        restitution: 0.1,
        isSensor: false,
      },
    ],
    mass: 2,
    linearDamping: 0.05,
    angularDamping: 0.05,
    gravityScale: 1,
    ccd: false,
    lockRotation: false,
    upright: false,
  };
}

/**
 * 高度场两级平台（碰撞 LOD 下采样后的 desc）：x<0 高 1、x≥0 高 3（台阶级在
 * 中心；球放在 ±2.5 远离边缘，平地上不滚动，静止点确定）。校准各引擎的
 * y 对齐约定（绝对高度 vs 中线居中）与 x 方向性（矩阵行列映射转置会交换
 * 两级位置）。
 */
function terraceHeightfieldDesc(): ShapeDesc {
  const s = 64;
  const heights = new Float32Array(s * s);
  for (let iz = 0; iz < s; iz++) {
    for (let ix = 0; ix < s; ix++) heights[iz * s + ix] = ix < s / 2 ? 1 : 3;
  }
  return {
    shape: "heightfield",
    halfExtents: { x: 5, y: 2, z: 5 },
    radius: 1,
    halfHeight: 1,
    points: [],
    heights,
    samples: s,
    terrainSizeX: 10,
    terrainSizeZ: 10,
    minHeight: 1,
    maxHeight: 3,
    offset: { x: 0, y: 0, z: 0 },
    friction: 0.6,
    restitution: 0,
    isSensor: false,
  };
}

function ballDescAt(x: number, y: number): import("../../../src/framework/physics/backend/types").PhysicsBodyDesc {
  const d = ballDesc(y);
  d.nodeId = `ball@${x}`;
  d.position.x = x;
  return d;
}

async function exercise(backend: string, create: WorldFactory): Promise<void> {
  const world = await create({ gravity: GRAVITY });
  const floor = world.createBody(floorDesc());
  const ball = world.createBody(ballDesc(3));
  if (!floor || !ball) throw new Error(`${backend}: createBody 失败`);
  // 步进 2 秒：球应落到地板上（球心 ≈ 0.5）
  let y = Number.NaN;
  for (let i = 0; i < 120; i++) {
    world.step(1 / 60);
    const t = ball.readTransform();
    y = t ? t.position.y : Number.NaN;
  }
  console.log(`[${backend}] 球 2s 后高度 = ${y.toFixed(3)}`);
  if (!(y > 0.3 && y < 0.8)) throw new Error(`${backend}: 球未正确落到地板（y=${y}）`);
  // 运动学目标：与生产用法一致（每步重发目标），位姿应收敛到目标附近
  ball.setMode("kinematic");
  let ky = Number.NaN;
  for (let i = 0; i < 60; i++) {
    ball.setKinematicTarget({ x: 0, y: 5, z: 0 }, IDENTITY);
    world.step(1 / 60);
    const t = ball.readTransform();
    ky = t ? t.position.y : Number.NaN;
  }
  console.log(`[${backend}] 运动学目标后高度 = ${ky.toFixed(3)}`);
  if (!(ky > 4.5 && ky < 5.5)) throw new Error(`${backend}: 运动学目标未收敛（y=${ky}）`);
  // 冲量：动态化后清速度、施加向上冲量，速度应非零
  ball.setMode("dynamic");
  ball.setMass(2);
  ball.setLinearVelocity({ x: 0, y: 0, z: 0 });
  ball.applyImpulse({ x: 0, y: 10, z: 0 });
  const v = ball.getLinearVelocity();
  console.log(`[${backend}] 冲量后速度 = ${v ? v.y.toFixed(2) : "null"}`);
  if (!v || v.y <= 0) throw new Error(`${backend}: 冲量未生效`);
  // 射线投射：自 y=5 向下先命中球（球落回地板后球顶 ≈1，距离 ≈4），
  // 排除球后命中地板（顶 y=0，距离 5），射程 3m 内无命中。
  // 冲量把球弹起：先清速度放回地板位再测，位置确定
  ball.setLinearVelocity({ x: 0, y: 0, z: 0 });
  ball.setTransform({ x: 0, y: 0.5, z: 0 }, IDENTITY);
  for (let i = 0; i < 5; i++) world.step(1 / 60);
  const down = { origin: { x: 0, y: 5, z: 0 }, direction: { x: 0, y: -1, z: 0 } };
  const hits = world.castRay({ ...down, maxDistance: 100 });
  if (hits.length === 0 || hits[0].nodeId !== "ball") throw new Error(`${backend}: 射线未命中球（${hits[0]?.nodeId ?? "无"}）`);
  if (!(hits[0].distance > 3.5 && hits[0].distance < 4.5)) throw new Error(`${backend}: 射线命中球距离异常（${hits[0].distance}）`);
  const floorHits = world.castRay({ ...down, maxDistance: 100, excludeNodeIds: ["ball"] });
  if (floorHits.length === 0 || floorHits[0].nodeId !== "floor") throw new Error(`${backend}: 排除球后未命中地板（${floorHits[0]?.nodeId ?? "无"}）`);
  const shortHits = world.castRay({ ...down, maxDistance: 3 });
  if (shortHits.length !== 0) throw new Error(`${backend}: 射程 3m 内不应命中`);
  console.log(`[${backend}] 射线命中球 d=${hits[0].distance.toFixed(2)} / 排除后地板 d=${floorHits[0].distance.toFixed(2)}`);
  world.destroyBody(ball);
  world.dispose();
  console.log(`[${backend}] OK`);
}

/** 高度场：静态两级平台 + 两球落点（校准各引擎的 y 对齐约定与 +x 方向性） */
async function exerciseHeightfield(backend: string, create: WorldFactory): Promise<void> {
  const world = await create({ gravity: GRAVITY });
  const terrain = world.createBody({
    nodeId: "terrain",
    mode: "static",
    position: { x: 0, y: 0, z: 0 },
    quaternion: IDENTITY,
    colliders: [terraceHeightfieldDesc()],
    mass: 1,
    linearDamping: 0,
    angularDamping: 0,
    gravityScale: 1,
    ccd: false,
    lockRotation: false,
    upright: false,
  });
  // 低台球（x=-2.5 → 平台高 1，球心应停 ≈1.5）与高台球（x=+2.5 → 平台高 3，球心 ≈3.5）
  const low = world.createBody(ballDescAt(-2.5, 8));
  const high = world.createBody(ballDescAt(2.5, 8));
  if (!terrain || !high || !low) throw new Error(`${backend}: 高度场 createBody 失败`);
  for (let i = 0; i < 180; i++) world.step(1 / 60);
  const yLow = low.readTransform()?.position.y ?? Number.NaN;
  const yHigh = high.readTransform()?.position.y ?? Number.NaN;
  console.log(`[${backend}] 高度场落点：高台 y=${yHigh.toFixed(3)}（期望 ≈3.5），低台 y=${yLow.toFixed(3)}（期望 ≈1.5）`);
  // y 对齐：若引擎把高度场按中线居中而未补偿，两球都会下沉 ~2m
  if (!(yLow > 1.1 && yLow < 1.9)) throw new Error(`${backend}: 高度场低台落点错（y=${yLow}）`);
  if (!(yHigh > 3.1 && yHigh < 3.9)) throw new Error(`${backend}: 高度场高台落点错（y=${yHigh}）`);
  // 方向性：高台在 +x 侧（行列映射转置会交换两级位置）
  if (!(yHigh > yLow + 1)) throw new Error(`${backend}: 高度场方向错误（高台应在 +x 侧）`);
  world.dispose();
  console.log(`[${backend}] 高度场 OK`);
}

async function main(): Promise<void> {
  await exercise("rapier", () => createRapierWorld({ gravity: GRAVITY }));
  await exercise("jolt", () => createJoltWorld({ gravity: GRAVITY }));
  await exerciseHeightfield("rapier", () => createRapierWorld({ gravity: GRAVITY }));
  await exerciseHeightfield("jolt", () => createJoltWorld({ gravity: GRAVITY }));
  console.log("物理后端冒烟测试全部通过");
}

main().catch((e) => {
  console.error("冒烟测试失败:", e);
  process.exit(1);
});
