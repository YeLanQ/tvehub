// ---------------------------------------------------------------------------
// tve —— 引擎脚本 SDK 运行时（模块说明符 "tve"）。
// 类型契约见 src/framework/scripting/tve.d.ts（两者保持镜像同步；本文件是
// 播放器侧实现，编辑器侧不加载本模块）。
//
// 设计约束：
// - 对用户脚本只暴露引擎自有类型（Vec3 普通对象 / 度制欧拉角，与编辑器
//   数据模型一致），不暴露任何 three.js 接口；three 对象仅在本模块内部使用；
// - 本模块不主动启动：由 scripts.mjs（脚本宿主）经 installRuntime 注入
//   场景注册表与动画控制后，engine 各接口才可用（未注入时安全空转）。
//
// 本文件为入口模块（组装 engine 对象 + 统一导出）；实现拆分到 ./tve/ 子目录。
// ---------------------------------------------------------------------------
import { postLog } from "./log.mjs";
import { tween, EASING, Tween } from "./tween.mjs";

import { state, formatArgs } from "./tve/state.mjs";
import { tickTime, inputApi } from "./tve/input.mjs";
import {
  Entity,
  getEntity,
  installRuntime,
  resolveNodeEntity,
  registerComponent,
  registerScriptClass,
  resolveScriptClass,
  resolveScriptInstance,
} from "./tve/runtime.mjs";
import { resolveComponentField } from "./tve/component-registry.mjs";
import {
  RigidBody,
  Collider,
  Light,
  AudioSource,
  AnimationClip,
  SkeletalAnimation,
} from "./tve/component-registry.mjs";
import {
  Transform,
  MeshNode,
  LightNode,
  CameraNode,
  SkyboxNode,
  FogNode,
  ParticleSystemNode,
  TerrainNode,
  UICanvasNode,
  UIImageNode,
  UITextNode,
  UIButtonNode,
  UILayoutNode,
} from "./tve/node-types.mjs";
import { Component, property, nodeType } from "./tve/decorators.mjs";
import { Delegate } from "./tve/delegate.mjs";
import { Pool } from "./tve/pool.mjs";
import { DataCenter, dataCenter } from "./tve/data-center.mjs";
import { animationApi, audioApi, particlesApi, physicsApi, sceneApi } from "./tve/engine-api.mjs";
import { uiApi } from "./tve/ui-api.mjs";
import { math } from "./tve/math.mjs";

export const VERSION = "1.3.0";

const easing = Object.freeze({ ...EASING });

const engine = {
  time: state.timeState,
  input: inputApi,
  scene: sceneApi,
  animation: animationApi,
  audio: audioApi,
  particles: particlesApi,
  physics: physicsApi,
  ui: uiApi,
  tween,
  log(...args) {
    postLog("info", formatArgs(args));
    console.log(...args);
  },
  warn(...args) {
    postLog("warn", formatArgs(args));
    console.warn(...args);
  },
  error(...args) {
    postLog("error", formatArgs(args));
    console.error(...args);
  },
};

export {
  Component,
  Entity,
  engine,
  math,
  tween,
  easing,
  Tween,
  Transform,
  MeshNode,
  LightNode,
  CameraNode,
  SkyboxNode,
  FogNode,
  ParticleSystemNode,
  TerrainNode,
  UICanvasNode,
  UIImageNode,
  UITextNode,
  UIButtonNode,
  UILayoutNode,
  Transform as transform,
  MeshNode as meshNode,
  LightNode as lightNode,
  CameraNode as cameraNode,
  SkyboxNode as skyboxNode,
  FogNode as fogNode,
  ParticleSystemNode as particleSystemNode,
  TerrainNode as terrainNode,
  UICanvasNode as uiCanvasNode,
  UIImageNode as uiImageNode,
  UITextNode as uiTextNode,
  UIButtonNode as uiButtonNode,
  UILayoutNode as uiLayoutNode,
  Delegate,
  Pool,
  DataCenter,
  dataCenter,
  RigidBody,
  Collider,
  Light,
  AudioSource,
  AnimationClip,
  SkeletalAnimation,
};

// 宿主接口（scripts.mjs 调用）
export {
  getEntity,
  installRuntime,
  registerComponent,
  registerScriptClass,
  resolveComponentField,
  resolveNodeEntity,
  resolveScriptClass,
  resolveScriptInstance,
  tickTime,
  property,
  nodeType,
};
