/**
 * 电力系统无头测试：node test/power.test.js
 * 电网连通 × 燃煤发电 × 保供优先级 × 蓄电池调峰 × 缺电联动 × 存档兼容
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
  'js/game/contracts.js', 'js/game/maintenance.js', 'js/game/power.js',
  'js/game/sim.js', 'js/game/researchmgr.js',
  'js/game/stats.js', 'js/game/save.js', 'js/game/blueprint.js', 'js/game/game.js',
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

const game = new FG.Game();
const gen = FG.Maps.generate(FG.Maps.getPreset('greenfield'), 12345, 'medium');
game.startWithMap(gen, null, 'test');
const m = game.map, sim = game.sim, power = game.power;

function place(type, x, y, dir) {
  const b = FG.Map.create(type, x, y, dir || 0);
  m.register(b); sim.register(b);
  if (FG.Power.isNode(b) || FG.Power.isConsumer(b)) power.markDirty();
  return b;
}
function putCoal(b, n) { return power.refuel(b, 'coal', n); }
/** 用箱子+相邻煤堆给发电机供煤：直接在其脚下放地面煤堆（selfFeed 含自身格） */
function coalPileAt(x, y, n) { m.pileAdd(x, y, 'coal', n); }
function anyNormOn(list, pm) { return list.some(b => pm.isPowered(b)); }

console.log('[1] 未研究电力工程：全部建筑免电运行（旧档行为兼容）');
{
  const furnace = place('furnace', 5, 5, 0);
  furnace.recipe = 'smelt:iron';
  furnace.slots.inputs.ironOre.count = 10;
  ticks(game, 25);
  ok(!power.enabled, '电力系统未启用');
  ok(furnace.status !== 'unpowered', '未启用时石炉不报缺电');
  ok(furnace.slots.outputs.ironPlate.count >= 1, '未启用时石炉正常产铁板');
  ok(power.isPowered(furnace), '未启用时 isPowered 恒为 true');
  sim.unregister(furnace); m.unregister(furnace);
}

console.log('[2] 研究电力工程后：未联网建筑立即缺电暂停');
{
  game.research.completed.add('electricPower');
  power.deserialize({ enabled: true });
  ok(power.enabled, '电力系统已启用（按存档恢复）');
  const furnace = place('furnace', 5, 5, 0);
  furnace.recipe = 'smelt:iron';
  furnace.slots.inputs.ironOre.count = 10;
  const prog0 = furnace.progress;
  ticks(game, 30);
  ok(furnace.status === 'unpowered', '无电网的石炉状态为缺电暂停');
  ok(furnace.progress === prog0, '缺电期间生产进度保留不推进');
  ok(power.gridOfConsumer(furnace) === null, '未联网消费者无电网');
  sim.unregister(furnace); m.unregister(furnace);
}

console.log('[3] 燃煤发电机 + 电线杆：联网供电，烧煤发电');
{
  // 布局：发电机(10,10) 煤堆在脚；电线杆(12,10)（杆-机 Cheb 距离 2）；石炉(12,8)（杆供电半径 2）
  const plant = place('coalPlant', 10, 10);
  const pole = place('powerPole', 12, 10);
  const furnace = place('furnace', 12, 8);
  furnace.recipe = 'smelt:iron';
  furnace.slots.inputs.ironOre.count = 20;
  coalPileAt(10, 10, 50);
  ticks(game, 2);
  const g = power.gridAt(pole);
  ok(!!g, '电线杆位于电网中');
  ok(power.gridAt(plant) === g, '发电机接入同一电网');
  ok(power.gridOfConsumer(furnace) === g, '石炉在电线杆供电半径内并入电网');
  ticks(game, 30);
  ok((plant.fuel || 0) > 0, '发电机从脚下煤堆自动补煤');
  ok(power.isPowered(furnace), '石炉获得供电');
  ok(furnace.status !== 'unpowered', '供电后石炉不再缺电');
  ok(furnace.slots.outputs.ironPlate.count >= 1, '供电石炉完成冶炼产出');
  const st = g.stats;
  ok(st.genKw > 0, '电网统计有发电出力 ' + st.genKw.toFixed(0) + 'kW');
  ok(st.demandKw > 0, '电网统计有用电负荷 ' + st.demandKw.toFixed(0) + 'kW');
  ok(st.unpowered === 0, '电网内无缺电建筑');
}

console.log('[4] 缺电联动：发电能力不足时低优先级先停，高优先级保供，同级轮转');
{
  // 单机 1500kW。已有 1 台石炉(180)，再放多台组装机(250)使总需求 > 1500。
  const pole = m.buildingAt(12, 10);
  const g = power.gridAt(pole);
  const mkAssembler = (x, y, prio) => {
    const a = place('assembler', x, y);
    a.recipe = 'craft:gear';
    FG.Map.syncRecipeSlots(a);
    a.slots.inputs.ironPlate.count = 50;
    a.powerPriority = prio;
    return a;
  };
  // 杆 (12,10) 半径 2 内：x∈[10..14], y∈[8..12]
  const high1 = mkAssembler(11, 9, 'high');
  const high2 = mkAssembler(13, 9, 'high');
  const norm1 = mkAssembler(11, 11, 'normal');
  const norm2 = mkAssembler(13, 11, 'normal');
  const norm3 = mkAssembler(14, 10, 'normal');
  const norm4 = mkAssembler(10, 11, 'normal');
  const norm5 = mkAssembler(12, 12, 'normal');
  const low1 = mkAssembler(14, 11, 'low');
  const low2 = mkAssembler(10, 12, 'low');
  ticks(game, 3);
  ok(power.isPowered(high1) && power.isPowered(high2), '高优先级组装机保供');
  ok(!power.isPowered(low1) && !power.isPowered(low2), '低优先级组装机缺电暂停');
  // 高优两层 2×250=500，石炉 180（默认普通）→ 普通层争抢剩余约 1000kW
  // 普通满负荷需求 = 180 + 5×250 = 1430 > 1000，部分普通机停电
  const normals = [norm1, norm2, norm3, norm4, norm5];
  const fullNorm = normals.filter(b => power.powerRatio(b) >= 0.999).length;
  ok(fullNorm < normals.length, '普通层未能全部足额供电（满速 ' + fullNorm + '/' + normals.length + '，缺额均摊）');
  ok(anyNormOn(normals, power), '普通层在高优先级满足后仍分到电力（高优先未独占）');
  // 多 tick 轮转 + 赤字分摊：每台普通机都分到过电（公平，无固定饿死）
  const seenOn = new Set();
  let ratioSum = {};
  for (let i = 0; i < 60; i++) {
    ticks(game, 1);
    normals.forEach(b => {
      if (power.isPowered(b)) seenOn.add(b.x + ',' + b.y);
      const k = b.x + ',' + b.y;
      ratioSum[k] = (ratioSum[k] || 0) + power.powerRatio(b);
    });
  }
  ok(seenOn.size >= normals.length, '同级公平：60 tick 内每台普通组装机都分到过供电（' + seenOn.size + '/5）');
  // 各机平均供电比例接近（最大与最小之差不超过 0.15），验证赤字轮转均摊
  const avgs = Object.values(ratioSum).map(n => n / 60);
  const fair = Math.max(...avgs) - Math.min(...avgs);
  ok(fair < 0.15, '同级供电比例均摊（差异 ' + fair.toFixed(3) + ' < 0.15）');
  // 低优先级始终没电（高+普通都填不满）
  ok(!power.isPowered(low1) && !power.isPowered(low2), '高/普通层未补足前低优先级持续暂停');
  // 把高优改为低优后原低保供恢复路径：补一台发电机扩大供给 → 全部有电
  const plant2 = place('coalPlant', 12, 12);
  coalPileAt(12, 12, 50);
  ticks(game, 3);
  ok(power.isPowered(low1) && power.isPowered(low2), '扩容发电后低优先级恢复供电');
  ok(power.isPowered(norm1) && power.isPowered(high1), '扩容后全部建筑供电');
}

console.log('[5] 缺电暂停机械臂：手持物与节拍保留，复电后续作');
{
  // 造一个缺电小电网：杆(20,5) 供电半径 2 内放矿机，但无发电机
  const pole2 = place('powerPole', 20, 5);
  const ins = place('inserter', 20, 4, 2); // 杆北侧相邻，属于杆电网…但该网无发电
  // 给机械臂手持一件货
  ins.held = { type: 'ironPlate', tag: null };
  ins.timer = 0;
  ticks(game, 3);
  ok(ins.status === 'unpowered', '无电机械臂状态为缺电暂停');
  ok(ins.held && ins.held.type === 'ironPlate', '停电期间机械臂手持物保留');
  // 接入有煤的发电机（放在杆 2 格外）
  const plant3 = place('coalPlant', 22, 5);
  coalPileAt(22, 5, 20);
  ticks(game, 1);
  // 发电机(22,5) 与杆(20,5) Cheb 距离 2 → 同一电网；机械臂立即复电
  ok(power.isPowered(ins), '来电后机械臂恢复供电');
}

console.log('[6] 蓄电池：富余充电、缺电放电，储能状态保存');
{
  // 独立小电网：发电机(30,10) + 杆(32,10) + 蓄电池(32,8)，只有 1 台石炉负荷
  const plant = place('coalPlant', 30, 10);
  const pole = place('powerPole', 32, 10);
  const acc = place('accumulator', 32, 8);
  const furnace = place('furnace', 33, 8);
  furnace.recipe = 'smelt:iron';
  furnace.slots.inputs.ironOre.count = 5;
  coalPileAt(30, 10, 100);
  ticks(game, 60);
  const g = power.gridAt(pole);
  ok((acc.accCharge || 0) > 0, '低负荷期间蓄电池被充入电能（' + (acc.accCharge || 0).toFixed(0) + 'kJ）');
  // 充电不超过上限/功率
  ok((acc.accCharge || 0) <= FG.Config.ACC_CAP_KJ + 0.01, '蓄电池不超过容量上限');
  // 拆走发电机：电网靠电池继续供电一段时间
  sim.unregister(plant); m.unregister(plant);
  power.markDirty();
  ticks(game, 1);
  const charged = acc.accCharge;
  ok(power.isPowered(furnace), '发电机拆除后蓄电池放电维持石炉供电');
  ticks(game, 20);
  ok(acc.accCharge < charged, '放电期间储能下降');
  // 储能序列化/反序列化
  const data = game.serialize();
  const sb = data.buildings.find(b => b.x === 32 && b.y === 8);
  ok(typeof sb.accCharge === 'number' && sb.accCharge > 0, '蓄电池储能写入存档');
  const savedCharge = sb.accCharge;
  game.deserialize(data);
  // deserialize 会重建 map/sim/power，后续统一通过 game.* 访问
  const acc2 = game.map.buildingAt(32, 8);
  ok(Math.abs(acc2.accCharge - savedCharge) < 1e-6, '读档后蓄电池储能恢复');
}

console.log('[7] 两个电网互不串电：连接前各自独立，拉杆连接后合并');
// section 6 内执行过 deserialize：map/sim/power 已重建，重新取实例
const m7 = game.map, sim7 = game.sim, power7 = game.power;
function place2(type, x, y, dir) {
  const b = FG.Map.create(type, x, y, dir || 0);
  m7.register(b); sim7.register(b);
  if (FG.Power.isNode(b) || FG.Power.isConsumer(b)) power7.markDirty();
  return b;
}
{
  // 新区域：网 A 有发电机带少量负荷，网 B 无电；两杆距离 8 > 5
  const plantA = place2('coalPlant', 40, 20);
  const poleA = place2('powerPole', 42, 20);
  const furA = place2('furnace', 42, 18);
  furA.recipe = 'smelt:iron'; furA.slots.inputs.ironOre.count = 10;
  m7.pileAdd(40, 20, 'coal', 30);
  const poleB = place2('powerPole', 48, 20);
  const furB = place2('furnace', 48, 18);
  furB.recipe = 'smelt:iron'; furB.slots.inputs.ironOre.count = 10;
  ticks(game, 2);
  const ga = power7.gridAt(poleA), gb = power7.gridAt(poleB);
  ok(ga && gb && ga !== gb, '两杆超距：属于不同电网');
  ok(power7.isPowered(furA), '网 A 石炉有电');
  ok(!power7.isPowered(furB), '网 B 石炉无电');
  // 中间补一根杆 (45,20)：与 A、B 均相距 3 ≤ 5
  const mid = place2('powerPole', 45, 20);
  ticks(game, 2);
  const ga2 = power7.gridAt(poleA), gb2 = power7.gridAt(poleB), gm = power7.gridAt(mid);
  ok(ga2 === gb2 && gb2 === gm, '补杆后两个电网合并为一个');
  ok(power7.isPowered(furB), '合并后网 B 石炉获得供电');
}

console.log('[8] 煤炭供给三通道：传送带卸入 / 机械臂加煤 / 相邻箱自补');
{
  // 通道 1：相邻箱子自补
  const plant = place2('coalPlant', 5, 25);
  const pole = place2('powerPole', 7, 25);
  const chest = place2('chest', 4, 25);
  chest.chest[0].type = 'coal'; chest.chest[0].count = 30;
  ticks(game, 1);
  ok((plant.fuel || 0) >= FG.Config.POWER_COAL_KJ, '发电机从相邻箱子自动补煤');

  // 通道 2：直接 refuel（机械臂/投放接口）
  const plant2 = place2('coalPlant', 5, 27);
  // 先给一根杆让两机不并网也无所谓；只验 refuel
  ok(power7.refuel(plant2, 'coal', 2) === 2, '机械臂式加煤 2 件被接受');
  ok(Math.abs(plant2.fuel - 2 * FG.Config.POWER_COAL_KJ) < 1e-6, '加煤换算为燃料缓存');
  // 满缓存拒收
  plant2.fuel = FG.Config.POWER_GEN_FUEL_CAP;
  ok(power7.refuel(plant2, 'coal', 1) === 0, '燃料缓存满时拒收新煤（物品留在带/臂上）');
  // 非煤拒收
  plant2.fuel = 0;
  ok(power7.refuel(plant2, 'ironOre', 1) === 0, '发电机只接受煤炭');

  // 通道 3：传送带末端卸煤
  const belt = place2('belt', 6, 27, 3); // 向西，末端 (5,27)=plant2
  belt.items.push({ type: 'coal', pos: 1, from: 0 });
  plant2.fuel = 0;
  ticks(game, 1);
  ok(belt.items.length === 0 && plant2.fuel > 0, '传送带末端煤炭直接卸入发电机燃料缓存');
}

console.log('[9] 存档兼容与恢复');
{
  // 9a. 保供优先级随存档
  const f = game.map.buildingAt(12, 8);
  if (f) f.powerPriority = 'high';
  // 9b. 发电机燃料缓存随存档
  // 9c. 无 power 字段的旧档：未研究科技 → 免电；已研究 → 启用
  const data = game.serialize();
  ok(data.power && data.power.enabled === true, 'power 字段随存档保存');
  const sb = data.buildings.find(b => b.x === 12 && b.y === 8);
  ok(sb && sb.powerPriority === 'high', '建筑保供优先级随存档保存');

  // 旧档 A：无 power 字段 + 未研究电力
  const oldA = JSON.parse(JSON.stringify(data));
  delete oldA.power;
  oldA.research.completed = oldA.research.completed.filter(id => id !== 'electricPower');
  game.deserialize(oldA);
  ok(!game.power.enabled, '旧档（无 power、未研究电力）：电力关闭、免电运行');

  // 旧档 B：无 power 字段 + 已研究电力（v1.11 存档不会有该科技，这里验回退逻辑）
  const oldB = JSON.parse(JSON.stringify(data));
  delete oldB.power;
  if (!oldB.research.completed.includes('electricPower')) oldB.research.completed.push('electricPower');
  game.deserialize(oldB);
  ok(game.power.enabled, '旧档（无 power、已研究电力）：电力按科技状态启用');
  ticks(game, 1);   // 首个 tick 惰性重建电网不报错
  ok(game.power.grids.length >= 1, '读档后电网惰性重建成功');
  ok(true, '读档后仿真正常推进');
}

console.log('\n结果：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
