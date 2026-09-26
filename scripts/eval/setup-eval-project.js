// 评测项目引导：在首页窗口执行 —— 创建「渲染评测-完整」项目并交接编辑器窗口
(async () => {
  const vurl = (needle) => {
    const hit = performance.getEntriesByType('resource').map((e) => e.name).find((u) => u.includes(needle));
    return hit || ('http://localhost:1420' + needle);
  };
  const api = (await import(vurl('/src/lib/api.ts'))).api;
  const config = {
    version: '0.0.1', description: 'agent 渲染/碰撞评测用', mainScene: 'assets/Main.scene',
    entryScript: 'src/main.ts', designResolution: { width: 1280, height: 720 },
    orientation: 'landscape', scaleMode: 'fixedauto', hdrMode: 'ldr', antiAliasing: 2, renderer: 'webgl',
  };
  const scene = {
    type: 'scene',
    metadata: { name: 'Main Scene', version: { major: 1, minor: 0, patch: 0 } },
    settings: {
      rendering: { backgroundColor: 0, fogEnabled: false, fogColor: 0, fogNear: 1, fogFar: 100, ambientIntensity: 0.3, ambientColor: 16777215 },
      physics: { gravity: { x: 0, y: -9.81, z: 0 }, physicsEnabled: false },
    },
    root: { type: 'node', name: 'Root', children: [] },
  };
  const entryTs = '// agent 评测项目入口\nexport default {};\n';
  const out = {};
  const parent = 'C:\\dev\\projects\\aniks';
  const name = '渲染评测-完整';
  try {
    const info = await api.createProject(parent, name, 'builtin:agent-eval', {
      'project.config.json': JSON.stringify(config, null, 2),
      'assets/Main.scene': JSON.stringify(scene, null, 2),
      'src/main.ts': entryTs,
    });
    out.created = info.path;
  } catch (e) {
    out.createError = String(e);
    out.created = parent + '\\' + name;
  }
  const ps = (await import(vurl('/src/app/stores/project.ts'))).getProjectStore();
  out.opened = await ps.openProject(out.created);
  if (!out.opened) return out;
  const ho = await import(vurl('/src/app/lib/window-handoff.ts'));
  await ho.handoffToWindow('editor-agent-eval', out.created, name, ps.sceneRel);
  out.handedOff = true;
  return out;
})()
