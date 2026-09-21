import { describe, expect, it } from "vitest";
import {
  AUDIO_EXTS,
  cloneAudioSettings,
  DEFAULT_AUDIO_SETTINGS,
  isAudioAssetRel,
  parseAudioSettings,
} from "./types";

// 音源设置收敛：路径判断、字段钳制与克隆。

describe("isAudioAssetRel", () => {
  it("按扩展名匹配 AUDIO_EXTS（大小写不敏感）", () => {
    for (const ext of AUDIO_EXTS) {
      expect(isAudioAssetRel(`sfx/hit.${ext}`)).toBe(true);
    }
    expect(isAudioAssetRel("sfx/hit.MP3")).toBe(true);
    expect(isAudioAssetRel("sfx/hit.txt")).toBe(false);
    expect(isAudioAssetRel("sfx/hit")).toBe(false);
  });
});

describe("parseAudioSettings", () => {
  it("非法输入回默认", () => {
    for (const bad of [null, 5, "x", {}]) {
      expect(parseAudioSettings(bad)).toEqual(DEFAULT_AUDIO_SETTINGS);
    }
  });

  it("volume 钳 [0,1]、speed 钳 [0.1,4]、距离下限 0.01、rolloff 非负", () => {
    const s = parseAudioSettings({ volume: 2, speed: 0, refDistance: -1, maxDistance: 0, rolloff: -3 });
    expect(s.volume).toBe(1);
    expect(s.speed).toBe(0.1);
    expect(s.refDistance).toBe(0.01);
    expect(s.maxDistance).toBe(0.01);
    expect(s.rolloff).toBe(0);
    expect(parseAudioSettings({ volume: -1 }).volume).toBe(0);
    expect(parseAudioSettings({ speed: 9 }).speed).toBe(4);
  });

  it("spatial 枚举收敛（仅 3d 显式生效，其余回 2d）", () => {
    expect(parseAudioSettings({ spatial: "3d" }).spatial).toBe("3d");
    expect(parseAudioSettings({ spatial: "4d" }).spatial).toBe("2d");
  });

  it("布尔缺省回默认（autoplay/loop）", () => {
    expect(parseAudioSettings({ autoplay: "yes" }).autoplay).toBe(DEFAULT_AUDIO_SETTINGS.autoplay);
    expect(parseAudioSettings({ loop: false }).loop).toBe(false);
  });
});

describe("cloneAudioSettings", () => {
  it("独立副本（改克隆不影响原设置）", () => {
    const c = cloneAudioSettings(DEFAULT_AUDIO_SETTINGS);
    c.volume = 0.1;
    expect(DEFAULT_AUDIO_SETTINGS.volume).not.toBe(0.1);
  });
});
