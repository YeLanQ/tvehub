// ---------------------------------------------------------------------------
// 灯光组件门面：设置写入组件 JSON 并同步活动灯光对象（类型切换重建灯光）
// ---------------------------------------------------------------------------
import { buildComponentLight } from "../lights";
import { state, numOr, D2R } from "./state";
import { BuiltinComponent, LIGHT_KINDS } from "./component-base";

class Light extends BuiltinComponent {
  __settings() {
    return this.__json && typeof this.__json.light === "object" ? this.__json.light : null;
  }
  __lightObj() {
    const group = this.entity.__obj.getObjectByName("__compLight");
    let light = null;
    if (group) group.traverse((o) => { if (!light && o.isLight) light = o; });
    return light;
  }
  get enabled() {
    return this.__json ? this.__json.enabled !== false : true;
  }
  set enabled(v) {
    if (!this.__json) return;
    this.__json.enabled = v === true;
    const group = this.entity.__obj.getObjectByName("__compLight");
    if (group) group.visible = v === true;
  }
  get kind() {
    return this.__settings()?.kind ?? "point";
  }
  set kind(v) {
    const s = this.__settings();
    if (!s || !LIGHT_KINDS.includes(v) || s.kind === v) return;
    s.kind = v;
    const obj = this.entity.__obj;
    const old = obj.getObjectByName("__compLight");
    if (old) obj.remove(old);
    buildComponentLight(s, obj);
  }
  get color() {
    return (this.__settings()?.lightColor ?? 0xffffff) & 0xffffff;
  }
  set color(v) {
    const s = this.__settings();
    const n = Number(v);
    if (!s || !Number.isFinite(n)) return;
    s.lightColor = Math.max(0, Math.round(n)) & 0xffffff;
    this.__lightObj()?.color.setHex(s.lightColor);
  }
  get intensity() {
    return numOr(this.__settings()?.intensity, 1);
  }
  set intensity(v) {
    const s = this.__settings();
    const n = Number(v);
    if (!s || !Number.isFinite(n)) return;
    s.intensity = Math.max(0, n);
    const light = this.__lightObj();
    if (light) light.intensity = s.intensity;
  }
  get cullingMask() {
    const m = this.__settings()?.cullingMask;
    return typeof m === "number" && Number.isFinite(m) ? m | 0 : -1;
  }
  set cullingMask(v) {
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
  get distance() {
    return numOr(this.__settings()?.distance, 10);
  }
  set distance(v) {
    const s = this.__settings();
    const n = Number(v);
    const light = this.__lightObj();
    if (!s || !Number.isFinite(n)) return;
    s.distance = Math.max(0, n);
    if (light && (light.isPointLight || light.isSpotLight)) light.distance = s.distance;
  }
  get decay() {
    return numOr(this.__settings()?.decay, 2);
  }
  set decay(v) {
    const s = this.__settings();
    const n = Number(v);
    const light = this.__lightObj();
    if (!s || !Number.isFinite(n)) return;
    s.decay = Math.max(0, n);
    if (light && (light.isPointLight || light.isSpotLight)) light.decay = s.decay;
  }
  get angle() {
    return numOr(this.__settings()?.angle, 45);
  }
  set angle(v) {
    const s = this.__settings();
    const n = Number(v);
    const light = this.__lightObj();
    if (!s || !Number.isFinite(n)) return;
    s.angle = Math.min(89, Math.max(1, n));
    if (light && light.isSpotLight) light.angle = s.angle * D2R;
  }
  get penumbra() {
    return numOr(this.__settings()?.penumbra, 0.2);
  }
  set penumbra(v) {
    const s = this.__settings();
    const n = Number(v);
    const light = this.__lightObj();
    if (!s || !Number.isFinite(n)) return;
    s.penumbra = Math.min(1, Math.max(0, n));
    if (light && light.isSpotLight) light.penumbra = s.penumbra;
  }
  get castShadow() {
    return this.__settings()?.castShadow === true;
  }
  set castShadow(v) {
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
  get shadowStrength() {
    return numOr(this.__settings()?.shadowStrength, 1);
  }
  set shadowStrength(v) {
    const s = this.__settings();
    const n = Number(v);
    if (!s || !Number.isFinite(n)) return;
    s.shadowStrength = Math.min(1, Math.max(0, n));
    const light = this.__lightObj();
    if (light && light.shadow) light.shadow.intensity = s.shadowStrength;
  }
  get shadowBias() {
    return numOr(this.__settings()?.shadowBias, -0.0005);
  }
  set shadowBias(v) {
    const s = this.__settings();
    const n = Number(v);
    if (!s || !Number.isFinite(n)) return;
    s.shadowBias = Math.min(0, Math.max(-0.05, n));
    const light = this.__lightObj();
    if (light && light.shadow) light.shadow.bias = s.shadowBias;
  }
  get shadowNormalBias() {
    return numOr(this.__settings()?.shadowNormalBias, 0);
  }
  set shadowNormalBias(v) {
    const s = this.__settings();
    const n = Number(v);
    if (!s || !Number.isFinite(n)) return;
    s.shadowNormalBias = Math.max(0, n);
    const light = this.__lightObj();
    if (light && light.shadow && s.shadowNormalBias > 0) light.shadow.normalBias = s.shadowNormalBias;
  }
  get shadowNear() {
    return numOr(this.__settings()?.shadowNear, 0.1);
  }
  set shadowNear(v) {
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
  get shadowRadius() {
    return numOr(this.__settings()?.shadowRadius, 4);
  }
  set shadowRadius(v) {
    const s = this.__settings();
    const n = Number(v);
    if (!s || !Number.isFinite(n)) return;
    s.shadowRadius = Math.min(5, Math.max(1, n));
    const light = this.__lightObj();
    if (light && light.shadow) light.shadow.radius = s.shadowRadius;
  }
  get shadowResolution() {
    return numOr(this.__settings()?.shadowResolution, 0);
  }
  set shadowResolution(v) {
    const s = this.__settings();
    const n = Number(v);
    if (!s || !Number.isFinite(n)) return;
    s.shadowResolution = [512, 1024, 2048, 4096].includes(n) ? n : 0;
    const obj = this.entity.__obj;
    const old = obj.getObjectByName("__compLight");
    if (old) obj.remove(old);
    buildComponentLight(s, obj);
  }
  get shadowType() {
    if (!this.castShadow) return "off";
    return this.shadowRadius >= 2 ? "soft" : "hard";
  }
  set shadowType(v) {
    if (v === "off") {
      this.castShadow = false;
    } else if (v === "hard" || v === "soft") {
      this.castShadow = true;
      this.shadowRadius = v === "hard" ? 1 : 4;
    }
  }
}

export { Light };