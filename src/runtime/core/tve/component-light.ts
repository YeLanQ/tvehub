// ---------------------------------------------------------------------------
// 灯光组件门面：设置写入组件 JSON 并同步活动灯光对象（类型切换重建灯光）
// ---------------------------------------------------------------------------
import type * as THREE from "../three.module.min.js";
import { buildComponentLight } from "../lights";
import { numOr, D2R } from "./state";
import { BuiltinComponent, LIGHT_KINDS } from "./component-base";
import type { LightSettings } from "./component-base";

/**
 * 灯光对象结构视图：three 类型库仅在实际灯型上声明 is*Light 标志与
 * distance/decay/angle 等灯型字段，门面对 __compLight 下找到的任意灯光
 * 按结构读写（与 buildComponentLight 产出的灯型字段一致）。
 */
type LightObjView = THREE.Object3D & {
  isLight?: boolean;
  isPointLight?: boolean;
  isSpotLight?: boolean;
  isDirectionalLight?: boolean;
  color: THREE.Color;
  intensity: number;
  distance?: number;
  decay?: number;
  angle?: number;
  penumbra?: number;
  castShadow?: boolean;
  shadow?: {
    intensity: number;
    bias: number;
    radius: number;
    normalBias: number;
    camera: { near: number; layers: THREE.Layers; updateProjectionMatrix(): void };
  };
};

class Light extends BuiltinComponent {
  __settings(): LightSettings | null {
    // 断言安全：light 组件 JSON 的 light 段由 lightSettingsFrom 产出/收敛
    return this.__json && typeof this.__json.light === "object"
      ? (this.__json.light as LightSettings)
      : null;
  }
  __lightObj(): LightObjView | null {
    const group = this.entity.__obj.getObjectByName("__compLight");
    let light: LightObjView | null = null;
    if (group) {
      group.traverse((o) => {
        // 断言安全：isLight 为真的 three 对象即灯光实例，具备门面读写的灯型字段
        if (!light && (o as LightObjView).isLight) light = o as LightObjView;
      });
    }
    return light;
  }
  get enabled(): boolean {
    return this.__json ? this.__json.enabled !== false : true;
  }
  set enabled(v: boolean) {
    if (!this.__json) return;
    this.__json.enabled = v === true;
    const group = this.entity.__obj.getObjectByName("__compLight");
    if (group) group.visible = v === true;
  }
  get kind(): string {
    return this.__settings()?.kind ?? "point";
  }
  set kind(v: string) {
    const s = this.__settings();
    if (!s || !LIGHT_KINDS.includes(v) || s.kind === v) return;
    s.kind = v;
    const obj = this.entity.__obj;
    const old = obj.getObjectByName("__compLight");
    if (old) obj.remove(old);
    buildComponentLight(s, obj);
  }
  get color(): number {
    return (this.__settings()?.lightColor ?? 0xffffff) & 0xffffff;
  }
  set color(v: number) {
    const s = this.__settings();
    const n = Number(v);
    if (!s || !Number.isFinite(n)) return;
    s.lightColor = Math.max(0, Math.round(n)) & 0xffffff;
    this.__lightObj()?.color.setHex(s.lightColor);
  }
  get intensity(): number {
    return numOr(this.__settings()?.intensity, 1);
  }
  set intensity(v: number) {
    const s = this.__settings();
    const n = Number(v);
    if (!s || !Number.isFinite(n)) return;
    s.intensity = Math.max(0, n);
    const light = this.__lightObj();
    if (light) light.intensity = s.intensity;
  }
  get cullingMask(): number {
    const m = this.__settings()?.cullingMask;
    return typeof m === "number" && Number.isFinite(m) ? m | 0 : -1;
  }
  set cullingMask(v: number) {
    const s = this.__settings();
    const n = Number(v);
    if (!s || !Number.isFinite(n)) return;
    s.cullingMask = n | 0;
    const light = this.__lightObj();
    if (light) {
      light.layers.mask = s.cullingMask;
      if (light.shadow) light.shadow.camera.layers.mask = s.cullingMask;
    }
  }
  get distance(): number {
    return numOr(this.__settings()?.distance, 10);
  }
  set distance(v: number) {
    const s = this.__settings();
    const n = Number(v);
    const light = this.__lightObj();
    if (!s || !Number.isFinite(n)) return;
    s.distance = Math.max(0, n);
    if (light && (light.isPointLight || light.isSpotLight)) light.distance = s.distance;
  }
  get decay(): number {
    return numOr(this.__settings()?.decay, 2);
  }
  set decay(v: number) {
    const s = this.__settings();
    const n = Number(v);
    const light = this.__lightObj();
    if (!s || !Number.isFinite(n)) return;
    s.decay = Math.max(0, n);
    if (light && (light.isPointLight || light.isSpotLight)) light.decay = s.decay;
  }
  get angle(): number {
    return numOr(this.__settings()?.angle, 45);
  }
  set angle(v: number) {
    const s = this.__settings();
    const n = Number(v);
    const light = this.__lightObj();
    if (!s || !Number.isFinite(n)) return;
    s.angle = Math.min(89, Math.max(1, n));
    if (light && light.isSpotLight) light.angle = s.angle * D2R;
  }
  get penumbra(): number {
    return numOr(this.__settings()?.penumbra, 0.2);
  }
  set penumbra(v: number) {
    const s = this.__settings();
    const n = Number(v);
    const light = this.__lightObj();
    if (!s || !Number.isFinite(n)) return;
    s.penumbra = Math.min(1, Math.max(0, n));
    if (light && light.isSpotLight) light.penumbra = s.penumbra;
  }
  get castShadow(): boolean {
    return this.__settings()?.castShadow === true;
  }
  set castShadow(v: boolean) {
    const s = this.__settings();
    if (!s) return;
    s.castShadow = v === true;
    const light = this.__lightObj();
    if (
      light &&
      (light.isDirectionalLight || light.isSpotLight || light.isPointLight)
    ) {
      light.castShadow = s.castShadow;
    }
  }
  get shadowStrength(): number {
    return numOr(this.__settings()?.shadowStrength, 1);
  }
  set shadowStrength(v: number) {
    const s = this.__settings();
    const n = Number(v);
    if (!s || !Number.isFinite(n)) return;
    s.shadowStrength = Math.min(1, Math.max(0, n));
    const light = this.__lightObj();
    if (light && light.shadow) light.shadow.intensity = s.shadowStrength;
  }
  get shadowBias(): number {
    return numOr(this.__settings()?.shadowBias, -0.0005);
  }
  set shadowBias(v: number) {
    const s = this.__settings();
    const n = Number(v);
    if (!s || !Number.isFinite(n)) return;
    s.shadowBias = Math.min(0, Math.max(-0.05, n));
    const light = this.__lightObj();
    if (light && light.shadow) light.shadow.bias = s.shadowBias;
  }
  get shadowNormalBias(): number {
    return numOr(this.__settings()?.shadowNormalBias, 0);
  }
  set shadowNormalBias(v: number) {
    const s = this.__settings();
    const n = Number(v);
    if (!s || !Number.isFinite(n)) return;
    s.shadowNormalBias = Math.max(0, n);
    const light = this.__lightObj();
    if (light && light.shadow && s.shadowNormalBias > 0) light.shadow.normalBias = s.shadowNormalBias;
  }
  get shadowNear(): number {
    return numOr(this.__settings()?.shadowNear, 0.1);
  }
  set shadowNear(v: number) {
    const s = this.__settings();
    const n = Number(v);
    const light = this.__lightObj();
    if (!s || !Number.isFinite(n)) return;
    s.shadowNear = Math.max(0.01, n);
    if (light && light.shadow && !light.isDirectionalLight) {
      light.shadow.camera.near = s.shadowNear;
      light.shadow.camera.updateProjectionMatrix();
    }
  }
  get shadowRadius(): number {
    return numOr(this.__settings()?.shadowRadius, 4);
  }
  set shadowRadius(v: number) {
    const s = this.__settings();
    const n = Number(v);
    if (!s || !Number.isFinite(n)) return;
    s.shadowRadius = Math.min(5, Math.max(1, n));
    const light = this.__lightObj();
    if (light && light.shadow) light.shadow.radius = s.shadowRadius;
  }
  get shadowResolution(): number {
    return numOr(this.__settings()?.shadowResolution, 0);
  }
  set shadowResolution(v: number) {
    const s = this.__settings();
    const n = Number(v);
    if (!s || !Number.isFinite(n)) return;
    s.shadowResolution = [512, 1024, 2048, 4096].includes(n) ? n : 0;
    const obj = this.entity.__obj;
    const old = obj.getObjectByName("__compLight");
    if (old) obj.remove(old);
    buildComponentLight(s, obj);
  }
  get shadowType(): string {
    if (!this.castShadow) return "off";
    return this.shadowRadius >= 2 ? "soft" : "hard";
  }
  set shadowType(v: string) {
    if (v === "off") {
      this.castShadow = false;
    } else if (v === "hard" || v === "soft") {
      this.castShadow = true;
      this.shadowRadius = v === "hard" ? 1 : 4;
    }
  }
}

export { Light };
