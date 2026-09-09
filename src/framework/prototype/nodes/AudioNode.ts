import { Node, type NodeInit } from "../Node";
import type { INode } from "../interfaces";
import { cloneRecord } from "../types";
import {
  DEFAULT_AUDIO_SETTINGS,
  cloneAudioSettings,
  parseAudioSettings,
  type AudioSourceSettings,
} from "../../audio";

export interface AudioNodeInit extends NodeInit {
  /** 音源播放设置（音频资产引用 + 播放参数） */
  audio?: AudioSourceSettings;
}

/** 音源节点能力接口：音源播放设置（音频资产引用 + 播放参数） */
export interface IAudioNode extends INode {
  audio: AudioSourceSettings;
}

/**
 * 音源节点：场景中的声音发射器（不渲染几何，仅持有音源数据）。
 * - 2D（spatial=2d）：全局播放（背景乐/UI 音效），不随距离衰减；
 * - 3D（spatial=3d）：位置音源，随监听器（活动渲染相机）距离/方位衰减；
 * - 播放意图（autoplay/loop/volume/speed…）为节点数据随场景序列化，
 *   运行时由 AudioSystem 驱动（Web Audio）。
 */
export class AudioNode extends Node implements IAudioNode {
  static override readonly kType: string = "audioNode";
  override readonly typeKey: string = AudioNode.kType;

  /** 音源播放设置（source 为音频资产相对路径；空串 = 未绑定） */
  audio: AudioSourceSettings = { ...DEFAULT_AUDIO_SETTINGS };

  constructor(init: AudioNodeInit = {}) {
    super(init);
    this.audio = init.audio ? cloneAudioSettings(init.audio) : this.audio;
  }

  override clone(): AudioNode {
    return new AudioNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      tag: this.tag,
      prefab: this.prefab,
      components: this.components,
      audio: cloneAudioSettings(this.audio),
    });
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    target.audio = cloneAudioSettings(this.audio);
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    this.audio = parseAudioSettings(source.audio);
  }
}
