<script setup lang="ts">
/**
 * 构建面板 · 微信小游戏渠道设置区：AppID（继承链说明）、屏幕方向、发布/调试
 * 模式。全部状态经 defineModel 双向绑定到面板（BuildPanel），本组件无自有状态。
 */
const wechatAppId = defineModel<string>("wechatAppId", { required: true });
const wechatOrientation = defineModel<"portrait" | "landscape">("wechatOrientation", {
  required: true,
});
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
    压缩模型经主线程纯 JS 解码器加载（略慢于 wasm，属一次性加载成本）。包体积不做构建期限制，由开发者工具在发布时判定。
  </p>
</template>
