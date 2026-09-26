// 评测⑥：数据化网格——菜单建节点 → 占位 → JSON 数据导入 → 编辑器几何 → 运行时产物一致性
(async () => {
  const vurl = (needle) => {
    const hit = performance.getEntriesByType('resource').map((e) => e.name).find((u) => u.includes(needle));
    return hit || ('http://localhost:1420' + needle);
  };
  const cmds = await import(vurl('/src/app/commands/index.ts'));
  const store = (await import(vurl('/src/app/stores/editor.ts'))).getEditorStore();
  const engine = store.engine;
  const dg = await import(vurl('/src/framework/mesh/dataGeometry.ts'));
  const run = (id, args) => cmds.runCommand(id, args, { logError: false });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};

  engine.graph.removeNodes(engine.graph.all().map((n) => n.id));

  // 1. 菜单入口建数据网格节点（subtype=data）
  const n = await run('node.add', { kind: 'mesh', subtype: 'data', name: '验证数据网格' });
  const nid = n?.id ?? n;
  const node = engine.graph.get(nid);
  out.nodeSource = node?.source;
  const obj = engine.synchronizer.getObjectMap().get(nid);
  await sleep(300);
  out.placeholderVerts = obj?.geometry.getAttribute('position')?.count; // 占位 box = 24

  // 2. 导入 JSON 网格（四棱锥：5 顶点 6 三角形，非平面确保法线可算）
  const pyr = JSON.stringify({
    positions: [0,0,0, 2,0,0, 2,0,2, 0,0,2, 1,1.5,1],
    indices: [0,2,1, 0,3,2, 0,1,4, 1,2,4, 2,3,4, 3,0,4],
  });
  const payload = dg.importMeshDataFile('pyramid.json', '.json', pyr);
  const before = node.toJSON();
  const after = JSON.parse(JSON.stringify(before));
  after.dataMesh = payload;
  engine.patchNode(nid, before, after, '导入数据网格');
  await sleep(400);

  // 状态自检：图层数据 / 对象几何 / 运行时构建 三方各自落到哪一步
  const nodeCheck = engine.graph.get(nid);
  out.graphSource = nodeCheck.source;
  out.graphDataMesh = nodeCheck.dataMesh ? `vc=${nodeCheck.dataMesh.vertexCount}` : String(nodeCheck.dataMesh);
  const obj2 = engine.synchronizer.getObjectMap().get(nid);
  out.objSig = String((obj2?.userData ?? {}).geomSig ?? '');
  const geom = obj2.geometry;
  out.dataVerts = geom.getAttribute('position')?.count;       // 期望 5
  out.dataTris = geom.getIndex() ? geom.getIndex().count / 3 : 0; // 期望 6
  out.hasNormals = !!geom.getAttribute('normal');
  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  out.bounds = [bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z].map((v) => Number(v.toFixed(2))); // [0,0,0,2,1.5,2]

  // 3. 运行时产物镜像：同一节点 JSON 经 public/engine/runtime/mesh.mjs 构建，顶点逐点一致
  const rt = await import('http://localhost:1420/engine/runtime/mesh.mjs');
  const json = engine.graph.get(nid).toJSON();
  const rtObj = rt.createMesh(json, { materialParams: new Map() });
  const rp = rtObj.geometry.getAttribute('position');
  out.rtVerts = rp?.count; // 期望 5
  let maxDiff = -1;
  if (rp && rp.count === geom.getAttribute('position').count) {
    maxDiff = 0;
    for (let i = 0; i < rp.count * 3; i++) maxDiff = Math.max(maxDiff, Math.abs(rp.array[i] - geom.getAttribute('position').array[i]));
  }
  out.rtMirrorMaxDiff = Number(maxDiff.toFixed(4)); // 期望 0

  // 4. 检查器卡渲染（Data Mesh）
  await run('node.select', { id: nid });
  await sleep(500);
  out.uiCard = document.body.textContent.includes('Data Mesh');
  out.uiSource = document.body.textContent.includes('pyramid.json');

  out.pass = out.nodeSource === 'data' &&
    out.placeholderVerts === 24 &&
    out.dataVerts === 5 && out.dataTris === 6 && out.hasNormals &&
    JSON.stringify(out.bounds) === JSON.stringify([0, 0, 0, 2, 1.5, 2]) &&
    out.rtVerts === 5 && out.rtMirrorMaxDiff === 0 &&
    out.uiCard && out.uiSource;
  return out;
})()
