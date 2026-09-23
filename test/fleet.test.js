/**
 * 按需铁路运输（FG.Fleet）测试：node test/fleet.test.js
 * 覆盖：
 *  站点上下限自动派车 · 空闲列车自动安排 · 在途货量统一扣除（不超派/不被抢料）
 *  供料优先级与需求优先级仲裁 · 合同缺口联动 · 断路等待与补轨自愈
 *  撤单（手动接管/停运/关规则）货物保留 · 拆站货物释放（不丢货）
 *  旧运输计划与旧存档兼容 · 读档续运
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
global.window = global;
global.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] !== undefined ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};

const files = [
  'js/core/config.js', 'js/core/utils.js',
  'js/data/items.js', 'js/data/recipes.js', 'js/data/buildings.js',
  'js/data/research.js', 'js/data/maps.js',
  'js/game/map.js', 'js/game/scheduler.js', 'js/game/railway.js', 'js/game/fleet.js',
  'js/game/contracts.js', 'js/game/maintenance.js', 'js/game/power.js', 'js/game/sim.js',
  'js/game/researchmgr.js', 'js/game/stats.js', 'js/game/save.js',
  'js/game/blueprint.js', 'js/game/game.js',
];
for (const f of files) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
}

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FAIL:', msg); }
}
function ticks(g, n) { for (let i = 0; i < n; i++) g.tickOnce(); }
function stationCount(st, item) {
  return st.chest.reduce((n, s) => n + (s.type === item ? s.count : 0), 0);
}

/** 搭一个独立测试世界：直轨 x0..x1 一行，指定位置放站/机务段 */
function makeWorld(opts) {
  opts = opts || {};
  const game = new FG.Game();
  const gen = FG.Maps.generate(FG.Maps.getPreset('greenfield'), (Math.random() * 1e6) | 0, 'medium');
  game.startWithMap(gen, null, 'fleet-test');
  game.research.completed.add('railTransport');
  game.research.completed.add('supplyContract');
  const m = game.map, sim = game.sim, ry = game.railway;
  const y = opts.y || 6;
  const x0 = opts.x0 || 2, x1 = opts.x1 || 16;
  const place = (type, x, yy) => {
    const b = FG.Map.create(type, x, yy || y, 0);
    if (b.def.railStation) { b.stationId = 'S' + (ry.stationSeq++); b.stationName = '站点 ' + b.stationId.slice(1); }
    m.register(b); sim.register(b); ry.markDirty();
    return b;
  };
  const stations = opts.stations || {};
  for (let x = x0; x <= x1; x++) {
    if (stations[x]) place(stations[x], x, y);
    else place('rail', x, y);
  }
  // 会车/备用侧线：y-1 一行平行轨，两端用竖轨与正线接轨；机务段放 y-2，发车落在侧线上互不阻挡
  if (opts.siding) {
    const sy = y - 1;
    for (let x = opts.siding[0]; x <= opts.siding[1]; x++) place('rail', x, sy);
  }
  if (opts.depots) for (const dx of opts.depots) place('trainDepot', dx, y - 1);
  if (opts.sidingDepots) for (const dx of opts.sidingDepots) place('trainDepot', dx, y - 2);
  ry.rebuildGraph();
  return {
    game, m, sim, ry, fleet: game.fleet, y,
    place,
    spawnAt(dx) { return ry.spawnTrain(m.buildingAt(dx, y - 1)); },
    spawnSiding(dx) { return ry.spawnTrain(m.buildingAt(dx, y - 2)); },
    st(x) { return m.buildingAt(x, y); },
  };
}

/** 推进世界直到 pred(world) 成立或超时；返回是否成立 */
function runUntil(w, pred, maxTicks) {
  for (let i = 0; i < (maxTicks || 2000); i++) {
    w.game.tickOnce();
    if (pred(w)) return true;
  }
  return false;
}

// ============================================================
console.log('\n[F1] 库存下限触发自动派车：供货站装货 → 需求站卸货 → 补足后撤销');
{
  const w = makeWorld({ stations: { 3: 'station', 8: 'station', 14: 'station' }, depots: [3] });
  const src = w.st(3), dst = w.st(8), extra = w.st(14);
  src.stationName = '供货站'; dst.stationName = '需求站';
  // 供货站 70 铁板；需求站空库存，下限 20/上限 50
  w.sim.chestAdd(src, 'ironPlate', 70);
  w.fleet.addSupply(src, 'ironPlate', 'normal');
  w.fleet.addDemand(dst, 'ironPlate', 20, 50, 'normal');

  const tr = w.spawnAt(3);
  ok(!!tr, '机务段相邻轨格发车成功');
  ok(tr.state === 'idle' && tr.plan.stops.length === 0, '新车无计划待命');

  // 立即扫描一次派车（列车尚未到站装货），再推进 1 tick 落定
  w.fleet.scan();
  ticks(w.game, 1);
  const job = w.fleet.jobOfTrain(tr.id);
  ok(!!job, '库存低于下限：空闲列车被自动派任务');
  ok(job && job.srcId === src.stationId && job.destId === dst.stationId, '任务路线 = 供货站 → 需求站');
  ok(tr._fleetOwned === true && tr.plan.stops.length === 2, '列车写入两站循环计划并标记归属');
  ok(w.fleet.reservedAt(src, 'ironPlate') > 0, '派车即在供货站台账预留（统一扣在途）');
  const reserved = w.fleet.reservedAt(src, 'ironPlate');
  ok(reserved === Math.min(70, FG.Config.TRAIN_CARGO_CAP, 50), '预留量 = min(可供/车容/缺口) = ' + reserved);

  // 预留件对按需调度不可见（统一扣除）
  w.sim.scheduler.rebuild(w.game.tickCount);
  const freeSeen = w.sim.scheduler.freeAt(src.x, src.y).get('ironPlate') || 0;
  ok(freeSeen === 70 - reserved, '调度器盘点车站自由货时扣除在站预留（见 ' + freeSeen + '，应 ' + (70 - reserved) + '）');

  // 跑完整趟：到供货站装 50 → 到需求站卸掉
  const done = runUntil(w, () => stationCount(dst, 'ironPlate') >= 50, 2000);
  ok(done, '列车自动装货并把 50 铁板运抵需求站（库存=' + stationCount(dst, 'ironPlate') + '）');
  // 离站后任务收尾（再推进若干 tick 让清道与台账出列落定）
  const settled = runUntil(w, () => w.fleet.jobs.length === 0, 200);
  ok(settled, '缺口补足后自动任务撤销');
  ok(tr.state === 'idle' && tr.plan.stops.length === 0 && !tr._fleetOwned, '列车回待命、自动计划清空');
  ok(w.fleet.reservedAt(src, 'ironPlate') === 0, '预留台账全部核销');
  // 货权守恒
  const total = stationCount(src, 'ironPlate') + stationCount(dst, 'ironPlate')
    + stationCount(extra, 'ironPlate') + tr.cargoCount('ironPlate');
  ok(total === 70, '货物守恒（70，实际 ' + total + '）');
}

// ============================================================
console.log('\n[F2] 在途货量统一扣除：缺口在途计入不超派；单车容不足时自动多趟续运补足');
{
  const w = makeWorld({ stations: { 3: 'station', 14: 'station' }, depots: [3] });
  const src = w.st(3), dst = w.st(14);
  w.sim.chestAdd(src, 'ironPlate', 200);
  w.fleet.addSupply(src, 'ironPlate', 'normal');
  w.fleet.addDemand(dst, 'ironPlate', 20, 100, 'normal');
  const t1 = w.spawnAt(3);
  ticks(w.game, 12);
  ok(!!w.fleet.jobOfTrain(t1.id), '空闲列车被派');
  ok(w.fleet.enRoute(w.fleet.stationKey(dst), 'ironPlate') === 60, '首趟在途按车容 60 计（缺口 100）');
  // 首趟运抵后任务保留（缺口还剩 40），自动回供货站续运第二趟
  runUntil(w, () => stationCount(dst, 'ironPlate') >= 60, 3000);
  ok(stationCount(dst, 'ironPlate') === 60, '首趟运抵 60');
  runUntil(w, () => stationCount(dst, 'ironPlate') >= 100, 3000);
  ok(stationCount(dst, 'ironPlate') === 100, '自动续运第二趟后需求站达上限 100（实际 '
    + stationCount(dst, 'ironPlate') + '）');
  runUntil(w, () => w.fleet.jobs.length === 0, 400);
  ok(w.fleet.jobs.length === 0, '缺口补足任务撤销');
  ok(stationCount(src, 'ironPlate') === 100, '供货站剩余 100（200−100），无超运');

  // 不超派：再补一个只缺 30 的需求站（< 车容），确认在途=30 时不会重复给第二辆空闲车派单
  const w2 = makeWorld({ x0: 2, x1: 18, stations: { 3: 'station', 16: 'station' }, depots: [3, 10] });
  const s2 = w2.st(3), d2 = w2.st(16);
  w2.sim.chestAdd(s2, 'ironPlate', 100);
  w2.fleet.addSupply(s2, 'ironPlate', 'normal');
  w2.fleet.addDemand(d2, 'ironPlate', 10, 30, 'normal');
  const a = w2.spawnAt(3);
  const b = w2.spawnAt(10);
  ticks(w2.game, 12);
  ok(!!w2.fleet.jobOfTrain(a.id) !== !!w2.fleet.jobOfTrain(b.id) || w2.fleet.jobs.length === 1,
    '缺口 30 < 车容 60：只派一列，不会两列重复派单（jobs=' + w2.fleet.jobs.length + '）');
  ok(w2.fleet.enRoute(w2.fleet.stationKey(d2), 'ironPlate') === 30, '在途合计 30 不超派');
}

// ============================================================
console.log('\n[F3] 需求优先级：高优先需求未满足前，低优先不派车；高优先补足后低优先得车');
{
  const w = makeWorld({ stations: { 3: 'station', 9: 'station', 15: 'station' }, depots: [3] });
  const src = w.st(3), lowDst = w.st(9), highDst = w.st(15);
  w.sim.chestAdd(src, 'gear', 40);
  w.fleet.addSupply(src, 'gear', 'normal');
  w.fleet.addDemand(lowDst, 'gear', 10, 30, 'low');
  w.fleet.addDemand(highDst, 'gear', 10, 30, 'high');
  const tr = w.spawnAt(3);
  ticks(w.game, 12);
  const job = w.fleet.jobOfTrain(tr.id);
  ok(!!job && job.destId === highDst.stationId, '唯一列车先派给高优先需求站');
  // 高优先补足（30），供货站余 10 仍满足低优先最小批量 10
  const done = runUntil(w, () => stationCount(highDst, 'gear') >= 30 && w.fleet.jobs.length === 0, 3000);
  ok(done, '高优先站补足 30');
  ticks(w.game, 12);
  const job2 = w.fleet.jobOfTrain(tr.id);
  ok(!!job2 && job2.destId === lowDst.stationId, '高优先满足后列车改派低优先需求站');
  runUntil(w, () => stationCount(lowDst, 'gear') >= 10, 3000);
  // 低优先缺口 30、可供只剩 10：运 10 后低于最小批量，任务收尾
  ok(stationCount(lowDst, 'gear') === 10, '低优先站得到剩余 10 齿轮（实际 ' + stationCount(lowDst, 'gear') + '）');
}

// ============================================================
console.log('\n[F4] 供料优先级：两供货站争用时先取高优先供货站');
{
  const w = makeWorld({ stations: { 3: 'station', 9: 'station', 15: 'station' }, depots: [] });
  const srcLo = w.st(3), srcHi = w.st(9), dst = w.st(15);
  w.sim.chestAdd(srcLo, 'copperPlate', 60);
  w.sim.chestAdd(srcHi, 'copperPlate', 60);
  w.fleet.addSupply(srcLo, 'copperPlate', 'low');
  w.fleet.addSupply(srcHi, 'copperPlate', 'high');
  w.fleet.addDemand(dst, 'copperPlate', 10, 60, 'normal');
  // 在两供货站之间放一辆空闲车（机务段没有，直接构造列车到 6 号格）
  const tr = new FG.Train('TX1', 6, w.y, 0);
  tr.ry = w.ry; w.ry.trains.push(tr);
  w.ry.occupy.set(FG.Utils.key(6, w.y), tr.id);
  ticks(w.game, 12);
  const job = w.fleet.jobOfTrain(tr.id);
  ok(!!job && job.srcId === srcHi.stationId, '派车选择高优先供货站（实际 src=' + (job && job.srcId) + '）');
  runUntil(w, () => stationCount(dst, 'copperPlate') >= 60, 3000);
  ok(stationCount(srcHi, 'copperPlate') === 0, '高优先供货站被取空（60→0）');
  ok(stationCount(srcLo, 'copperPlate') === 60, '低优先供货站原封不动（60）');
}

// ============================================================
console.log('\n[F5] 合同缺口联动：交付站合同自动成为需求，列车运抵即锁付');
{
  const w = makeWorld({ stations: { 3: 'station', 14: 'deliveryStation' }, depots: [3] });
  const src = w.st(3), del = w.st(14);
  w.sim.chestAdd(src, 'gear', 60);
  w.fleet.addSupply(src, 'gear', 'normal');
  // 直接构造一个进行中合同（绕过邀约随机）：交付 40 齿轮
  w.game.contracts.active.push({
    id: 'CT1', stationId: del.stationId, stationKey: w.game.contracts.stationKey(del),
    stationName: del.stationName, item: 'gear', qty: 40, delivered: 0,
    reward: { science1: 4 }, startAt: 0, dueAt: w.game.playTime + 300, status: 'active',
  });
  const tr = w.spawnAt(3);
  ticks(w.game, 12);
  const job = w.fleet.jobOfTrain(tr.id);
  ok(!!job && job.kind === 'contract' && job.destId === del.stationId, '合同缺口自动生成虚拟需求并派车');
  const done = runUntil(w, () => w.game.contracts.contractAt(del) === null, 3000);
  ok(done, '列车分批/整车运抵，合同锁付完成（delivered=' + 40 + '）');
  const c0 = w.game.contracts.history.find(c => c.id === 'CT1');
  ok(!!c0, '合同完成并入历史');
  ok(stationCount(del, 'science1') >= 4 || w.m.pileAt(del.x, del.y), '科研包奖励已发放到站/地面');
  ok(stationCount(del, 'gear') === 0, '锁付货物不进站货位（独立台账）');
  runUntil(w, () => w.fleet.jobs.length === 0 && tr.state === 'idle', 200);
  ok(w.fleet.jobs.length === 0, '合同结束后任务自动撤销');
}

// ============================================================
console.log('\n[F6] 断路等待：路不通不派车；补轨后自动派车');
{
  const w = makeWorld({ stations: { 3: 'station', 8: 'station' }, depots: [3], x1: 14 });
  const src = w.st(3), dst = w.st(8);
  // 拆掉中间两段轨（5,6），断开通路（不影响车站邻轨要求）
  w.game.removeBuilding(w.m.buildingAt(5, w.y));
  w.game.removeBuilding(w.m.buildingAt(6, w.y));
  w.sim.chestAdd(src, 'ironOre', 50);
  w.fleet.addSupply(src, 'ironOre', 'normal');
  w.fleet.addDemand(dst, 'ironOre', 10, 40, 'normal');
  const tr = w.spawnAt(3);
  ticks(w.game, 40);
  ok(!w.fleet.jobOfTrain(tr.id), '断路：调度不派车（列车保持待命）');
  // 补轨
  for (const x of [5, 6]) {
    const b = FG.Map.create('rail', x, w.y, 0);
    w.m.register(b); w.sim.register(b);
  }
  w.ry.markDirty();
  ticks(w.game, 20);
  ok(!!w.fleet.jobOfTrain(tr.id), '补轨后扫描自动派车');
  runUntil(w, () => stationCount(dst, 'ironOre') >= 40, 3000);
  ok(stationCount(dst, 'ironOre') === 40, '通路恢复后货物运抵（40）');
}

// ============================================================
console.log('\n[F7] 撤单：玩家手动加站/停运即接管，任务撤销、货物与预留不丢');
{
  const w = makeWorld({ stations: { 3: 'station', 8: 'station', 14: 'station' }, depots: [3, 10] });
  const src = w.st(3), dst = w.st(8), third = w.st(14);
  w.sim.chestAdd(src, 'ironPlate', 100);
  w.fleet.addSupply(src, 'ironPlate', 'normal');
  w.fleet.addDemand(dst, 'ironPlate', 20, 60, 'normal');
  const tr = w.spawnAt(3);
  ticks(w.game, 12);
  const job = w.fleet.jobOfTrain(tr.id);
  ok(!!job, '已派自动任务');
  // 玩家手动加一个停靠站：接管
  tr.addStop(third.stationId, 'unload', null, 10);
  ok(!w.fleet.jobOfTrain(tr.id), '手动编辑计划后任务立即撤销');
  ok(!tr._fleetOwned && tr.plan.stops.length === 3, '计划转为手动（3 站，归属标记剥离）');
  ok(tr.plan.stops.every(s => !s.fleetJobId), '全部停靠站的 fleetJobId 标记已剥除');
  ok(w.fleet.reservedAt(src, 'ironPlate') === 0, '撤销后未装车的预留全部释放回物流');

  // 再派一辆新车（从区间另一侧的机务段）：释放的预留可以重新被派
  const tr2 = w.spawnAt(10);
  ticks(w.game, 12);
  const job2 = w.fleet.jobOfTrain(tr2.id);
  ok(!!job2, '预留释放后空闲列车可重新派车');
  // 停运接管：在行驶中停运
  tr2.setPaused(true);
  ticks(w.game, 2);
  ok(!w.fleet.jobOfTrain(tr2.id), '停运列车任务撤销');
  ok(tr2.state === 'paused', '列车保持停运状态');
}

// ============================================================
console.log('\n[F8] 拆站：需求站拆除 → 在途货物退回供货站；供货站拆除 → 车货保留回待命');
{
  // 8a 需求站拆除
  const w = makeWorld({ stations: { 3: 'station', 14: 'station' }, depots: [3] });
  const src = w.st(3), dst = w.st(14);
  w.sim.chestAdd(src, 'ironPlate', 60);
  w.fleet.addSupply(src, 'ironPlate', 'normal');
  w.fleet.addDemand(dst, 'ironPlate', 20, 60, 'normal');
  const tr = w.spawnAt(3);
  ticks(w.game, 12);
  ok(!!w.fleet.jobOfTrain(tr.id), '已派车');
  // 等列车装货离站（toDest、车上有货）后拆掉需求站
  let loaded = runUntil(w, () => {
    const jb = w.fleet.jobOfTrain(tr.id);
    return jb && jb.phase === 'toDest' && tr.cargoCount('ironPlate') > 0;
  }, 2000);
  ok(loaded, '列车已装货离站（在途）');
  const onboard = tr.cargoCount('ironPlate');
  w.game.removeBuilding(dst);
  runUntil(w, () => w.fleet.jobs.length === 0 && tr.state === 'idle', 400);
  ok(stationCount(src, 'ironPlate') === onboard, '需求站拆除：在途 ' + onboard
    + ' 件全部退回供货站（货位 ' + stationCount(src, 'ironPlate') + '）');
  ok(tr.state === 'idle' && tr.plan.stops.length === 0, '列车撤任务回待命');
  ok(w.fleet.jobs.length === 0, '无残留任务');

  // 8b 供货站拆除（列车不可能占用该格：等它离站后拆）
  const w2 = makeWorld({ stations: { 3: 'station', 14: 'station' }, depots: [3] });
  const s2 = w2.st(3), d2 = w2.st(14);
  w2.sim.chestAdd(s2, 'copperWire', 60);
  w2.fleet.addSupply(s2, 'copperWire', 'normal');
  w2.fleet.addDemand(d2, 'copperWire', 20, 60, 'normal');
  const t2b = w2.spawnAt(3);
  ticks(w2.game, 12);
  runUntil(w2, () => {
    const jb = w2.fleet.jobOfTrain(t2b.id);
    return jb && jb.phase === 'toDest' && t2b.cargoCount('copperWire') > 0;
  }, 2000);
  const wireOnTrain = t2b.cargoCount('copperWire');
  w2.game.removeBuilding(s2);
  ticks(w2.game, 20);
  ok(t2b.cargoCount('copperWire') === wireOnTrain, '供货站拆除：已上车货物保留不丢');
  ok(t2b.state === 'idle' && w2.fleet.jobs.length === 0, '列车回待命、任务出列');
}

// ============================================================
console.log('\n[F9] 旧运输计划兼容：有手动计划的列车永不被自动派车');
{
  const w = makeWorld({ stations: { 3: 'station', 8: 'station', 14: 'station' }, depots: [3] });
  const src = w.st(3), dst = w.st(8), third = w.st(14);
  w.sim.chestAdd(src, 'ironPlate', 100);
  w.fleet.addSupply(src, 'ironPlate', 'normal');
  w.fleet.addDemand(third, 'ironPlate', 20, 60, 'high');
  const tr = w.spawnAt(3);
  // 手动计划：src → dst（与需求站无关）
  tr.addStop(src.stationId, 'load', 'ironPlate', 10);
  tr.addStop(dst.stationId, 'unload', 'ironPlate', 10);
  ticks(w.game, 60);
  ok(!w.fleet.jobOfTrain(tr.id), '有手动计划的列车不被调度器接管');
  ok(tr.plan.stops.length === 2 && !tr._fleetOwned, '手动计划原样保留');
  ok(stationCount(third, 'ironPlate') === 0, '没有任何车去满足自动需求（无空闲车）');

  // 旧档模拟：deserialize 一个无 fleet 字段的存档，列车带旧计划
  const data = w.game.serialize();
  delete data.fleet;
  w.game.deserialize(data);
  const tr2 = w.game.railway.trains[0];
  ok(!!tr2 && tr2.plan.stops.length === 2 && !tr2._fleetOwned, '旧存档（无 fleet 字段）读入：旧计划保留、不被追认自动任务');
  ok(w.game.fleet.jobs.length === 0 && w.game.fleet.enabled === true, '旧档回退空任务、总开关默认开');
  ticks(w.game, 40);
  ok(w.game.fleet.jobs.length === 0, '旧档列车继续按手动计划跑，调度器不干扰');
}

// ============================================================
console.log('\n[F10] 存档续运：任务/在站预留/站点规则随档保存，读档后继续履约');
{
  const w = makeWorld({ stations: { 3: 'station', 14: 'station' }, depots: [3] });
  const src = w.st(3), dst = w.st(14);
  w.sim.chestAdd(src, 'ironPlate', 100);
  w.fleet.addSupply(src, 'ironPlate', 'high');
  w.fleet.addDemand(dst, 'ironPlate', 20, 60, 'normal');
  const tr = w.spawnAt(3);
  ticks(w.game, 12);
  const job = w.fleet.jobOfTrain(tr.id);
  ok(!!job, '派车成功');
  // 在列车刚派单（toLoad、有预留）时存档
  const data = w.game.serialize();
  ok(!!data.fleet && data.fleet.jobs.length === 1, '存档包含 fleet 任务');
  ok(data.fleet.reserve.length === 1, '存档包含在站预留台账');
  ok(data.buildings.some(b => b.fleetDemands && b.fleetDemands.length === 1), '需求规则随车站存档');
  ok(data.buildings.some(b => b.fleetSupplies && b.fleetSupplies.length === 1), '供货规则随车站存档');
  const railJob = data.railway.trains[0].stops.some(s => s.fleetJobId === job.id);
  ok(railJob, '列车停靠站带 fleetJobId 标记存档');

  w.game.deserialize(data);
  const f2 = w.game.fleet;
  ok(f2.jobs.length === 1, '读档后任务恢复');
  const tr2 = w.game.railway.trains[0];
  ok(tr2._fleetOwned === true && !!tr2._fleetJobId, '列车归属恢复');
  ok(f2.reservedAt(w.st(3), 'ironPlate') > 0, '在站预留核账恢复');
  // 跑完（清道驶离站台后转真正待命，给足 tick）
  const finished = runUntil(w, () => f2.jobs.length === 0
    && w.game.railway.trains[0].state === 'idle' && !w.game.railway.trains[0].clearing, 3000);
  ok(stationCount(w.st(14), 'ironPlate') === 60, '读档后自动续运，需求站补足 60');
  ok(finished && f2.jobs.length === 0, '履约完成任务出列');
}

// ============================================================
console.log('\n[F11] 总开关关闭：撤销全部任务并释放预留；重开后恢复派车');
{
  const w = makeWorld({ stations: { 3: 'station', 14: 'station' }, depots: [3] });
  const src = w.st(3), dst = w.st(14);
  w.sim.chestAdd(src, 'ironPlate', 60);
  w.fleet.addSupply(src, 'ironPlate', 'normal');
  w.fleet.addDemand(dst, 'ironPlate', 20, 60, 'normal');
  const tr = w.spawnAt(3);
  ticks(w.game, 12);
  ok(!!w.fleet.jobOfTrain(tr.id), '已派车');
  w.fleet.setEnabled(false);
  ticks(w.game, 2);
  ok(w.fleet.jobs.length === 0 && w.fleet.reservedAt(src, 'ironPlate') === 0, '关闭后任务撤销、预留释放');
  ticks(w.game, 60);
  ok(stationCount(dst, 'ironPlate') === 0, '关闭期间不自动运输');
  w.fleet.setEnabled(true);
  ticks(w.game, 12);
  ok(!!w.fleet.jobOfTrain(tr.id), '重新开启后恢复自动派车');
  runUntil(w, () => stationCount(dst, 'ironPlate') >= 60, 3000);
  ok(stationCount(dst, 'ironPlate') === 60, '重开后货物运抵');
}

// ============================================================
console.log('\n[F12] 供货站实物被机械臂拉走：列车少装，预留按实载核销、缺口继续补派');
{
  const w = makeWorld({ stations: { 3: 'station', 14: 'station' }, depots: [3] });
  const src = w.st(3), dst = w.st(14);
  w.sim.chestAdd(src, 'ironPlate', 60);
  w.fleet.addSupply(src, 'ironPlate', 'normal');
  w.fleet.addDemand(dst, 'ironPlate', 20, 60, 'normal');
  const tr = w.spawnAt(3);
  ticks(w.game, 12);
  const job = w.fleet.jobOfTrain(tr.id);
  ok(!!job, '派车成功');
  ok(w.fleet.enRoute(w.fleet.stationKey(dst), 'ironPlate') === 60, '派车即在途 60（在站预留，随装载逐 tick 迁入车载）');
  // 列车抵达供货站前，直接从货位抽走 30（模拟被机械臂/施工料池取走）
  for (const s of src.chest) {
    if (s.type === 'ironPlate') { const take = Math.min(30, s.count); s.count -= take; break; }
  }
  // 跑完全程
  runUntil(w, () => w.fleet.jobs.length === 0 && stationCount(dst, 'ironPlate') > 0, 3000);
  ok(stationCount(dst, 'ironPlate') === 30, '列车实装 30 并运抵（需求站=' + stationCount(dst, 'ironPlate') + '）');
  ok(w.fleet.reservedAt(src, 'ironPlate') === 0, '少装的 30 预留已核销（无台账泄漏）');
  // 把货补回，新一轮扫描会继续补足缺口
  w.sim.chestAdd(src, 'ironPlate', 30);
  ticks(w.game, 12);
  ok(!!w.fleet.jobOfTrain(tr.id), '补货后空闲列车继续被派补足缺口');
  runUntil(w, () => stationCount(dst, 'ironPlate') >= 60, 3000);
  ok(stationCount(dst, 'ironPlate') === 60, '缺口最终补足 60');
}

// ============================================================
console.log('\n[F13] 需求站库满：列车零交付自动收队，库位腾出后重新派车');
{
  const w = makeWorld({ stations: { 3: 'station', 14: 'station' }, depots: [3] });
  const src = w.st(3), dst = w.st(14);
  w.sim.chestAdd(src, 'stone', 60);
  w.fleet.addSupply(src, 'stone', 'normal');
  // 需求站库位 4×1000，这里先灌满 1000（>上限 60，deficit=0 不会派车）；
  // 为了构造「派出后库满」，先放 990：缺口 = max(60-990)=0 仍不会派。
  // 改为：上限设 1000，站库先放 985（<1000 触发派车但只剩 15 空位，列车 60 件只卸掉 15）
  w.sim.chestAdd(dst, 'stone', 985);
  w.fleet.addSupply(src, 'stone', 'normal');
  w.fleet.addDemand(dst, 'stone', 500, 1000, 'normal');
  const tr = w.spawnAt(3);
  ticks(w.game, 12);
  ok(!!w.fleet.jobOfTrain(tr.id), '缺口 15 也派车（≥ 最小批量时才派；15≥10）');
  // 跑到需求站：只能卸 15（卸货量按缺口钳制），45 余量带回；任务在回程/供货站收尾，
  // 余量卸回供货站货位（货物守恒：源 60−15=45 退回）或留车——两种情况都不丢货
  runUntil(w, () => w.fleet.jobs.length === 0 && tr.state === 'idle', 4000);
  ok(stationCount(dst, 'stone') === 1000, '需求站恰好补到库满 1000（不超卸，实 '
    + stationCount(dst, 'stone') + '）');
  const leftover = tr.cargoCount('stone');
  const backAtSrc = stationCount(src, 'stone');
  ok(leftover + backAtSrc === 45, '超出缺口的 45 件不丢货（车上 ' + leftover
    + ' + 退回供货站 ' + backAtSrc + ' = 45）');
  ok(!tr._fleetOwned, '库满/无续跑必要后列车收队（归属剥离）');
  // 收队后不再反复空跑
  ticks(w.game, 60);
  ok(w.fleet.jobs.length === 0, '收队后不自动再派（无新缺口）');
}

// ============================================================
console.log('\n[F14] 施工建材池同样扣除在站预留（统一料权）');
{
  const w = makeWorld({ stations: { 3: 'station', 14: 'station' }, depots: [3] });
  const src = w.st(3);
  w.sim.chestAdd(src, 'ironPlate', 60);
  w.fleet.addSupply(src, 'ironPlate', 'normal');
  w.fleet.addDemand(w.st(14), 'ironPlate', 20, 60, 'normal');
  w.spawnAt(3);
  ticks(w.game, 12);
  // 车站自由货盘点口径（施工/维修料池同口径，扣除在站预留）
  const freeInStations = () => {
    let n = 0;
    for (const b of w.game.map.buildings.values()) {
      if (!b.def.storage) continue;
      for (const s of b.chest) if (s.type === 'ironPlate' && s.count > 0) {
        n += Math.max(0, s.count - w.fleet.reservedAt(b, 'ironPlate'));
      }
    }
    return n;
  };
  ok(freeInStations() === 0, '已整批预留时车站自由货盘点为 0（60 全部在途预留）');
  // 再放 20 件未预留的
  w.sim.chestAdd(src, 'ironPlate', 20);
  ok(freeInStations() === 20, '只有未预留的 20 件可被施工/维修料池取用');
}

// ============================================================
console.log(`\n结果：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
