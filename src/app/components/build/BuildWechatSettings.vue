<script setup lang="ts">
/**
 * 构建面板 · 微信小游戏渠道设置区：AppID（继承链说明）、屏幕方向、分包加载、
 * 发布/调试模式。全部状态经 defineModel 双向绑定到面板（BuildPanel），本组件
 * 无自有状态。
 */
const wechatAppId = defineModel<string>("wechatAppId", { required: true });
const wechatOrientation = defineModel<"portrait" | "landscape">("wechatOrientation", {
  required: true,
});
const wechatSubpackages = defineModel<boolean>("wechatSubpackages", { required: true });
const wechatSubpackageSize = defineModel<number>("wechatSubpackageSize", { required: true });
const release = defineModel<boolean>("release", { required: true });
const debug = defineModel<boolean>("debug", { required: true });
</script>

<template>
  <div class="bp-field col">
    <label for="bp-wechat-appid">
      AppID
      <span class="bp-label-hint">可选，留空走继承链</span>
    </label>
    <input
      id="bp-wechat-appid"
      v-model="wechatAppId"
      placeholder="wx1234567890abcdef"
      spellcheck="false"
    />
    <p class="bp-note">
      留空时继承上次产物中的 AppID（首次构建为 touristappid
      游客模式：可运行模拟器，真机预览需真实 AppID）。更换 AppID
      后需在微信开发者工具重新导入工程。
    </p>
  </div>
  <div class="bp-field">
    <label>屏幕方向</label>
    <div class="bp-check-row">
      <label class="bp-check">
        <input v-model="wechatOrientation" type="radio" value="portrait" />
        <span>竖屏</span>
      </label>
      <label class="bp-check">
        <input v-model="wechatOrientation" type="radio" value="landscape" />
        <span>横屏</span>
      </label>
    </div>
  </div>
  <div class="bp-field">
    <label for="bp-wechat-subpackages">分包加载</label>
    <label class="bp-check">
      <input id="bp-wechat-subpackages" v-model="wechatSubpackages" type="checkbox" />
      <span>二进制资产分包（主包 4MB 限制的解法）</span>
    </label>
  </div>
  <div v-if="wechatSubpackages" class="bp-field col">
    <label for="bp-wechat-subpackage-size">
      单个分包体积上限（MB）
      <span class="bp-label-hint">1 ~ 4，缺省 2</span>
    </label>
    <input
      id="bp-wechat-subpackage-size"
      v-model.number="wechatSubpackageSize"
      type="number"
      min="1"
      max="4"
      step="1"
    />
    <p class="bp-note">
      文件化二进制资产（贴图/模型/音频）按体积分入 pkg-N 分包，启动时并行预加载全部分包后才进游戏
      （需基础库 ≥ 2.1.0）；场景与文本资产仍在主包 data.js 内。超限的单个资产独占一个分包，
      体积限制最终由微信开发者工具在预览/上传时判定。
    </p>
  </div>
  <div class="bp-field">
    <label for="bp-wechat-release">发布模式</label>
    <label class="bp-check">
      <input id="bp-wechat-release" v-model="release" type="checkbox" />
      <span>资源 uid 重命名 + 引用重写 + JSON 压缩（与调试模式互斥）</span>
    </label>
  </div>
  <div class="bp-field">
    <label for="bp-wechat-debug">调试模式</label>
    <label class="bp-check">
      <input id="bp-wechat-debug" v-model="debug" type="checkbox" />
      <span>运行日志输出到控制台（与发布模式互斥）</span>
    </label>
  </div>
  <p class="bp-note">
    产物为微信小游戏工程（场景与资产全内联，运行期零文件系统）：用「微信开发者工具」导入
    <code>build/wechat</code> 目录即可运行。当前限制：Basis 纹理压缩不支持（请关闭「纹理压缩」后构建）；Draco
    压缩模型经主线程 wasm 解码器加载。包体积不做构建期限制，由开发者工具在发布时判定。
  </p>
</template>
