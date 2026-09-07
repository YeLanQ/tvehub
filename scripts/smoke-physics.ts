// 物理后端冒烟测试：真实加载 rapier/jolt WASM，建 世界 + 静态地板 + 动力学球，
// 步进 2 秒验证球落到地板上（动力学）与运动学目标生效。跑法同 smoke:mesh：
//   npx vite build --ssr scripts/smoke-physics.ts --outDir .tmp-smoke --emptyOutDir
//   node .tmp-smoke/smoke-physics.js

import { createRapierWorld } from "../src/framework/physics/backend/rapierBackend";
import { createJoltWorld } from "../src/framework/physics/backend/joltBackend";

const GRAVITY = { x: 0, y: -9.81, z: 0 };
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

interface WorldFactory {
  (backend: string): Promise<import("../src/framework/physics/backend/types").IPhysicsWorld>;
}

function floorDesc(): import("../src/framework/physics/backend/types").PhysicsBodyDesc {
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
  };
}

function ballDesc(y: number): import("../src/framework/physics/backend/types").PhysicsBodyDesc {
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
  };
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
  world.destroyBody(ball);
  world.dispose();
  console.log(`[${backend}] OK`);
}

async function main(): Promise<void> {
  await exercise("rapier", () => createRapierWorld({ gravity: GRAVITY }));
  await exercise("jolt", () => createJoltWorld({ gravity: GRAVITY }));
  console.log("物理后端冒烟测试全部通过");
}

main().catch((e) => {
  console.error("冒烟测试失败:", e);
  process.exit(1);
});
