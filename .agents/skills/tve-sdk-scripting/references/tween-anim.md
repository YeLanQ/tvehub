# 单元：补间与动画（tween / .anim / 骨骼动画图）

## 契约（速查）

`tween`（= engine.tween）：创建即播放，引擎每帧自动推进（脚本 onUpdate 前）。
工厂：`to/from(target, props, dur)`、`value(from,to,dur)`、`color(a,b,dur)`、
`position/rotation(度)/scale(entity, to, dur)`、`sequence([...]) / parallel([...])`、
`delay(s)`、`call(fn)`、`killAll(complete?)`、全局 `timeScale`。
链式：`easing(name|fn)/delay/loop(n; -1=无限)/yoyo()/onStart/onUpdate/onComplete/
then(next)/stop(complete?)/pause/resume`。
缓动名（EaseName）：`linear` + quad/cubic/quart/quint/sine/expo/circ/back/elastic/
bounce × In/Out/InOut（`backOut` 回弹、`elasticOut` 弹簧、`bounceOut` 落地弹）。
可插值目标：Entity 变换/数字字段、UI Widget 字段（size/anchoredPosition 等 {x,y}）、
任意普通对象的同名字段（允许部分字段）。

`.anim` 关键帧剪辑：`AnimationClip` 门面（`clip/time/speed/loop/autoplay/play/
pause/resume/stop/duration`）——`@property(AnimationClip) anim!` 自动绑定。
骨骼动画：`SkeletalAnimation` 门面（仅模型网格节点）：`play(clipOrState)/
setParam/ensureGraph(AnimGraphDef)`（动画图条件过渡）、权重混合 `fadeIn/fadeOut/
crossFade/playOneShot/playAdditive`、骨骼直写 `setBonePosition/Rotation`、
形态键 `setMorphWeight`、IK `addIK/setIKTargetPosition`、`attachToBone(entity, bone)`。

## 模板：入场 + 往返巡航（sequence/loop）

`public/repos/code/TweenDemo.ts` 骨架（见该文件全文）：

```ts
onStart() {
  tween.from(this.entity, { scale: { x: 0.01, y: 0.01, z: 0.01 } }, 0.6)
    .easing("backOut").onComplete(() => engine.log("入场完成"));
  const px = this.entity.position.x;
  tween.sequence([
    tween.position(this.entity, { x: px + this.range }, this.duration).easing("sineInOut"),
    tween.delay(0.3),
    tween.position(this.entity, { x: px }, this.duration).easing("sineInOut"),
    tween.delay(0.3),
  ]).loop(-1);
}
```

## 模板：UI 按钮脉冲（sequence + 防重入）

`public/repos/code/ButtonPulse.ts` 骨架：

```ts
private pulse() {
  if (this.busy) return;                       // 补间期间忽略再次点击（防打架）
  this.busy = true;
  const s = this.entity.scale;
  tween.sequence([
    tween.scale(this.entity, { x: s.x * this.punch, y: s.y * this.punch, z: 1 }, 0.08).easing("quadOut"),
    tween.scale(this.entity, { x: s.x, y: s.y, z: 1 }, 0.2).easing("bounceOut"),
  ]).onComplete(() => { this.busy = false; });
}
```

## 模板：骨骼动画图（状态机驱动）

```ts
@property(AnimationClip) clipAnim!: AnimationClip;   // .anim 关键帧剪辑
@property(SkeletalAnimation) skel!: SkeletalAnimation;  // 模型内嵌动画（仅模型节点）

onStart() {
  this.clipAnim.play();
  const ok = this.skel.ensureGraph({
    entry: "idle",
    states: [{ name: "idle", clip: "Idle" }, { name: "run", clip: "Run" }],
    transitions: [{ from: "idle", to: "run", duration: 0.25,
                    conditions: [{ param: "speed", op: ">", value: 0.1 }] }],
    params: { speed: 0 },
  });
  this.skel.setParam("speed", 1);        // 条件评估每帧读参数 → 自动过渡
  this.skel.crossFade("Idle", "Run", 0.3);   // 或手动交叉淡化
}
onDestroy() { tween.killAll(); }          // 组件销毁清补间，防悬挂
```

## 测试例

- 工坊示例：`TweenDemo.ts`、`AnimationDemo.ts`、`ButtonPulse.ts`。
- 回归：`smoke-tween-runtime.mjs`（推进/缓动/序列/killAll，P0）。
