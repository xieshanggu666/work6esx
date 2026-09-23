/**
 * 电力网络测试：node test/power.test.js
 * 覆盖：
 *  科技门控（未研究时设备不耗电、旧档行为不变）/ 线路连通分量与覆盖吸附 /
 *  燃煤发电机按需发电烧煤（不满载不浪费、无燃料停机）/ 机械臂与传送带给发电机送煤 /
 *  缺电轮停分层（高→中→低→实验室最末）/ 同级轮转 / 断电冻结进度、恢复续作 /
 *  蓄电池充放与削峰 / 储能状态与燃料随存档保存 / 旧存档（无 power 字段）兼容 /
 *  拓扑重建（放置/拆除/施工落成/升级）/ 拆除燃料落地面堆不丢煤 / 传送带不耗电
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
global.window = global;

const files = [
  'js/core/config.js', 'js/core/utils.js',
  'js/data/items.js', 'js/data/recipes.js', 'js/data/buildings.js',
  'js/data/research.js', 'js/data/maps.js', 'js/data/pipelines.js',
  'js/game/map.js', 'js/game/scheduler.js', 'js/game/railway.js', 'js/game/fleet.js',
  'js/game/contracts.js', 'js/game/maintenance.js', 'js/game/power.js',
  'js/game/sim.js', 'js/game/researchmgr.js', 'js/game/stats.js',
  'js/game/save.js', 'js/game/blueprint.js', 'js/game/game.js',
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
function newGame(seed) {
  const g = new FG.Game();
  g.startWithMap(FG.Maps.generate(FG.Maps.getPreset('greenfield'), seed || 7, 'medium'), null, 'power');
  g.research.completed.add('automationScience');
  g.research.completed.add('electricity');
  g.power.enable();
  return g;
}
function place(g, type, x, y, dir) {
  const b = FG.Map.create(type, x, y, dir || 0);
  g.map.register(b); g.sim.register(b);
  if (FG.Power.isConnectable(b)) g.power.markDirty();
  return b;
}
/** 找一片陆地空 3×3（不含矿/水） */
function findLand(g, x0, y0) {
  for (let y = y0; y < g.map.h - 3; y++) {
    for (let x = x0; x < g.map.w - 3; x++) {
      let clear = true;
      for (let dy = 0; dy < 3 && clear; dy++) for (let dx = 0; dx < 3; dx++) {
        if (g.map.buildingAt(x + dx, y + dy) || g.map.terrainAt(x + dx, y + dy) === 'water'
            || g.map.oreAt(x + dx, y + dy)) clear = false;
      }
      if (clear) return { x, y };
    }
  }
  return null;
}
function genSet(g, x, y, coal) {
  const gen = place(g, 'coalGenerator', x, y);
  gen.fuel.type = 'coal'; gen.fuel.count = coal;
  return gen;
}
/** 发电机+线路+一台 90kW 用电设备（默认组装机带配方） */
function poweredRig(g, ox, oy, coal) {
  const gen = genSet(g, ox, oy, coal);
  const pole = place(g, 'powerPole', ox + 2, oy);
  const asm = place(g, 'assembler', ox + 4, oy);
  asm.recipe = 'craft:gear';
  FG.Map.syncRecipeSlots(asm);
  g.power.markDirty();
  ticks(g, 1);
  return { gen, pole, asm };
}

// ================= [P0] 科技门控：未研究电力时一切照常 =================
console.log('\n[P0] 科技门控：未研究电力网络，设备无需接线照常运转');
{
  const g = new FG.Game();
  g.startWithMap(FG.Maps.generate(FG.Maps.getPreset('greenfield'), 1, 'medium'), null, 'gate');
  const L = findLand(g, 2, 2);
  const fur = place(g, 'furnace', L.x, L.y);
  fur.recipe = 'smelt:iron';
  FG.Map.syncRecipeSlots(fur);
  fur.slots.inputs.ironOre.count = 10;
  ticks(g, 25);
  ok(!g.power.enabled, '电力系统未启用');
  ok(fur.slots.outputs.ironPlate.count >= 1, '无电网时熔炉照常冶炼（旧行为不变）');
  ok(fur.status === 'working', '设备状态为生产中而非缺电');
  // 未解锁时建筑不可选
  ok(!g.research.isBuildingUnlocked('coalGenerator'), '燃煤发电机未解锁');
  ok(!g.research.isBuildingUnlocked('powerPole'), '输电线路未解锁');
}

// ================= [P1] 拓扑：连通分量 + 2 格覆盖吸附 =================
console.log('\n[P1] 线路接线（曼哈顿距离 ≤2）与设备吸附；孤立设备无电');
{
  const g = newGame(11);
  const L = findLand(g, 2, 2);
  const x = L.x, y = L.y;
  const p1 = place(g, 'powerPole', x, y);
  const p2 = place(g, 'powerPole', x + 2, y);       // 距离 2：接通
  const p3 = place(g, 'powerPole', x + 5, y);       // 距 p2 为 3：断开 → 第二个电网
  ticks(g, 1);
  ok(p1.net && p1.net === p2.net, '距离 2 的线路自动接线');
  ok(p3.net && p3.net !== p1.net, '距离 3 的线路属于不同电网');
  // 设备在 p2 的 2 格覆盖内
  const asm = place(g, 'assembler', x + 4, y);
  g.power.markDirty(); ticks(g, 1);
  ok(asm.net === p2.net, '覆盖范围内的组装机电吸附到电网');
  // 孤立设备（附近无线路）
  const iso = place(g, 'assembler', x, y + 6);
  g.power.markDirty(); ticks(g, 1);
  ok(iso.net === null && iso.powered === false, '孤立用电设备无电网且断电');
}

// ================= [P2] 发电机按需发电、烧煤、负载工作 =================
console.log('\n[P2] 燃煤发电机：有煤发电，设备运转并按实际出力耗煤；无煤停机');
{
  const g = newGame(21);
  const L = findLand(g, 2, 2);
  const { gen, asm } = poweredRig(g, L.x, L.y, 20);
  ok(asm.net !== null && asm.powered, '组装机已接入电网并获供电');
  asm.slots.inputs.ironPlate.count = 200;
  ticks(g, 400);
  ok(asm.slots.outputs.gear.count >= 1, '供电下组装机完成生产');
  ok(gen.genOutput > 0, '发电机实际出力 > 0：' + Math.round(gen.genOutput) + ' kW');
  const coalAfter = gen.fuel.count;
  ok(coalAfter < 20, '发电消耗了煤炭：剩余 ' + coalAfter);
  // 不满载：单台 90kW 负载，400kW 机组按 90kW 发，400 tick 期望耗煤
  // 400*(90/400)*(1/80) = 1.125 块；给料充足下约 1 块（不满载不按满载烧煤）
  ok(coalAfter >= 17, '低负载按比例烧煤（400tick 约耗 1 块，实际 ' + (20 - coalAfter) + '）');

  // 满载耗煤速率核对：再造 3 台组装机凑满 ~360kW（均在杆 2 格覆盖内）
  const a2 = place(g, 'assembler', L.x + 3, L.y + 1); a2.recipe = 'craft:gear'; FG.Map.syncRecipeSlots(a2); a2.slots.inputs.ironPlate = { count: 200, cap: 100 };
  const a3 = place(g, 'assembler', L.x + 3, L.y - 1); a3.recipe = 'craft:gear'; FG.Map.syncRecipeSlots(a3); a3.slots.inputs.ironPlate = { count: 200, cap: 100 };
  const a4 = place(g, 'assembler', L.x + 4, L.y + 1); a4.recipe = 'craft:gear'; FG.Map.syncRecipeSlots(a4); a4.slots.inputs.ironPlate = { count: 200, cap: 100 };
  g.power.markDirty();
  const coal0 = gen.fuel.count;
  ticks(g, 400);
  ok(coal0 - gen.fuel.count >= 3, '接近满载时耗煤明显加快（400tick 耗 ' + (coal0 - gen.fuel.count) + ' 块）');

  // 燃料耗尽：发电机停摆，设备断电
  gen.fuel.count = 0; gen.fuel.type = null;
  const before = asm.slots.outputs.gear.count;
  ticks(g, 30);
  ok(asm.slots.outputs.gear.count === before, '燃料耗尽后组装机停产');
  ok(asm.status === 'unpowered', '设备状态为缺电暂停');
}

// ================= [P3] 缺电轮停：保供优先级分层 =================
console.log('\n[P3] 缺电按优先级切负荷：高 > 中 > 低 > 实验室最末');
{
  const g = newGame(31);
  const L = findLand(g, 2, 2);
  const x = L.x, y = L.y;
  // 一台发电机 400kW；电杆在 (x+2,y+1) 覆盖周围 5×5，负载围绕放置
  const gen = genSet(g, x, y + 1, 100);
  place(g, 'powerPole', x + 2, y + 1);
  const hi = place(g, 'assembler', x + 1, y + 1); hi.priority = 'high'; hi.recipe = 'craft:gear';
  const nm = place(g, 'assembler', x + 2, y + 2); nm.priority = 'normal'; nm.recipe = 'craft:gear';
  const lo = place(g, 'assembler', x + 3, y + 1); lo.priority = 'low'; lo.recipe = 'craft:gear';
  const lab1 = place(g, 'lab', x + 1, y);
  const lab2 = place(g, 'lab', x + 2, y);
  g.research.current = FG.Research.byId('electronics');   // 实验室活跃
  g.power.markDirty(); ticks(g, 1);
  // 全部活跃需求 = 90*3 + 60*2 = 390 ≤ 400：全部有电
  ok(hi.powered && nm.powered && lo.powered && lab1.powered && lab2.powered, '390kW 需求全部保供');

  // 再加两台普通组装机（180kW）→ 570kW，超出 400
  const nm2 = place(g, 'assembler', x + 3, y); nm2.priority = 'normal'; nm2.recipe = 'craft:gear';
  const nm3 = place(g, 'assembler', x + 1, y + 2); nm3.priority = 'normal'; nm3.recipe = 'craft:gear';
  g.power.markDirty(); ticks(g, 1);
  ok(hi.powered, '高优先设备始终保供');
  // 高层 90 满足后剩 310kW；普通层 3×90=270 满足，剩 40；低 90 不够 → 低层与实验室全停
  ok(nm.powered && nm2.powered && nm3.powered, '普通层三台全部保供（270≤310）');
  ok(!lo.powered, '低优先层被整体切停');
  ok(!lab1.powered && !lab2.powered, '实验室（最末档）先于低优先设备之前就已切停');

  // 再压：再加两台高优先（270）→ 普通层只剩 130kW，仅保 1 台
  const hi2 = place(g, 'assembler', x + 3, y + 2); hi2.priority = 'high'; hi2.recipe = 'craft:gear';
  const hi3 = place(g, 'assembler', x + 2, y + 3); hi3.priority = 'high'; hi3.recipe = 'craft:gear';
  g.power.markDirty();
  ticks(g, 1);
  ok(hi.powered && hi2.powered && hi3.powered, '高层三台全部保供');
  const normalOn = [nm, nm2, nm3].filter(b => b.powered).length;
  ok(normalOn === 1, '剩余电力只保 1 台普通设备（130kW 保一台 90kW）：实际 ' + normalOn);
}

// ================= [P4] 同级轮转公平 =================
console.log('\n[P4] 同层电力不足时轮转切停，不固定饿死同一台');
{
  const g = newGame(41);
  const L = findLand(g, 2, 2);
  const x = L.x, y = L.y;
  genSet(g, x, y, 100);
  place(g, 'powerPole', x + 2, y);
  // 5 台普通组装机 = 450kW > 400kW，每 tick 保 4 台；全部放在电杆 2 格覆盖内
  const spots = [[x + 1, y + 1], [x + 2, y + 1], [x + 3, y + 1], [x + 1, y - 1], [x + 2, y - 1]];
  const asms = [];
  for (const [ax, ay] of spots) {
    const a = place(g, 'assembler', ax, ay);
    a.recipe = 'craft:gear'; asms.push(a);
  }
  g.power.markDirty();
  const offCount = [0, 0, 0, 0, 0];
  for (let t = 0; t < 20; t++) {
    ticks(g, 1);
    asms.forEach((a, i) => { if (!a.powered) offCount[i]++; });
  }
  const maxOff = Math.max(...offCount), minOff = Math.min(...offCount);
  ok(maxOff - minOff <= 5, '各台停机次数接近（轮转公平）：' + offCount.join(','));
  ok(offCount.reduce((n, v) => n + v, 0) > 0, '确实发生过切负荷');
}

// ================= [P5] 断电冻结进度，恢复后续作 =================
console.log('\n[P5] 缺电暂停期间进度/节拍冻结；恢复供电后自动续作');
{
  const g = newGame(51);
  const L = findLand(g, 2, 2);
  const x = L.x, y = L.y;
  // 发电机（无燃料）+ 线路 + 熔炉
  const gen = genSet(g, x, y, 0);
  place(g, 'powerPole', x + 2, y);
  const fur = place(g, 'furnace', x + 4, y);
  fur.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(fur);
  fur.slots.inputs.ironOre.count = 20;
  g.power.markDirty(); ticks(g, 30);
  ok(fur.status === 'unpowered' && fur.progress === 0, '无电不生产');
  ok(fur.slots.inputs.ironOre.count === 20, '断电期间不消耗原料');

  // 机械臂节拍冻结（放在线路覆盖内，恢复供电后即可续作）
  const arm = place(g, 'inserter', x + 3, y + 1);
  g.power.markDirty(); ticks(g, 5);
  const timerFrozen = arm.timer;
  ticks(g, 5);
  ok(arm.timer === timerFrozen && arm.status === 'unpowered', '机械臂节拍冻结在 ' + timerFrozen);

  // 上煤恢复
  gen.fuel.type = 'coal'; gen.fuel.count = 50;
  ticks(g, 25);
  ok(fur.status === 'working' && fur.slots.outputs.ironPlate.count >= 1, '恢复供电后续作出铁');
  ok(arm.status !== 'unpowered', '机械臂恢复运转');
}

// ================= [P6] 蓄电池：富余充电、缺电放电、状态存档 =================
console.log('\n[P6] 蓄电池削峰填谷：富余充电、缺口放电、电量持久化');
{
  const g = newGame(61);
  const L = findLand(g, 2, 2);
  const x = L.x, y = L.y;
  const gen = genSet(g, x, y, 200);
  place(g, 'powerPole', x + 2, y);
  const acc = place(g, 'accumulator', x + 3, y);
  // 一台 90kW 熔炉持续冶炼：母线 400-60-90=250kW 富余用于充电
  const fur = place(g, 'furnace', x + 3, y + 1);
  fur.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(fur);
  fur.slots.inputs.ironOre.count = 500;
  g.power.markDirty(); ticks(g, 1);
  ok(acc.net === gen.net, '蓄电池接入电网');
  ticks(g, 60);
  ok(acc.accCharge > 0, '富余电力给蓄电池充电：' + Math.round(acc.accCharge) + ' kJ');
  const charged = acc.accCharge;

  // 燃料耗尽：发电机出力归零，蓄电池放电保住熔炉（60kW）
  gen.fuel.count = 0; gen.fuel.type = null;
  ticks(g, 10);
  ok(fur.powered, '蓄电池放电维持设备供电');
  ok(acc.accCharge < charged - 1, '放电后电量下降：' + Math.round(acc.accCharge) + ' kJ');
  // 电量耗尽后停机
  acc.accCharge = 1;
  ticks(g, 60);
  ok(!fur.powered && fur.status === 'unpowered', '蓄电池放空后设备断电');

  // 电量随存档保存
  acc.accCharge = 123.5;
  const data = g.serialize();
  const sb = data.buildings.find(b => b.type === 'accumulator');
  ok(Math.abs(sb.accCharge - 123.5) < 0.01, '蓄电池电量写入存档');
  const g2 = new FG.Game();
  g2.deserialize(data);
  const acc2 = g2.map.buildingAt(acc.x, acc.y);
  ok(Math.abs(acc2.accCharge - 123.5) < 0.01, '读档后蓄电池电量恢复');
  ok(g2.power.enabled, '读档后电力系统按科技状态开启');
  ticks(g2, 2);
  ok(acc2.net !== null, '读档后拓扑惰性重建，蓄电池重新入网');
}

// ================= [P7] 机械臂/传送带送煤入发电机 =================
console.log('\n[P7] 机械臂与传送带为燃煤发电机供煤（含带端直送）');
{
  const g = newGame(71);
  const L = findLand(g, 2, 2);
  const x = L.x, y = L.y;
  const gen = genSet(g, x, y, 0);
  place(g, 'powerPole', x + 1, y);
  const asm = place(g, 'assembler', x + 2, y + 1);
  asm.recipe = 'craft:gear'; FG.Map.syncRecipeSlots(asm);
  // 煤箱在发电机西侧，机械臂向东放煤（位于发电机与电杆之间，在电杆覆盖内）
  const chest = place(g, 'chest', x - 2, y);
  chest.chest[0] = { type: 'coal', count: 20, cap: FG.Config.CHEST_SLOT_CAP };
  const arm = place(g, 'inserter', x - 1, y, 1);
  g.power.markDirty(); ticks(g, 1);
  // 机械臂本身需要电：发电机没煤 → 死锁启动！给发电机预置 2 块煤打破死锁
  ok(gen.fuel.count === 0, '初始无煤');
  gen.fuel.type = 'coal'; gen.fuel.count = 2;
  ticks(g, 80);
  ok(gen.fuel.count > 2, '机械臂自动把煤补入发电机：' + gen.fuel.count);
  ok(asm.powered, '补煤后电网带动组装机');

  // 带端直送：传送带末端指向另一台发电机（传送带不耗电，可独立工作）
  const gen2 = genSet(g, x, y + 3, 0);
  const belt = place(g, 'belt', x - 1, y + 3, 1);
  belt.items.push({ type: 'coal', pos: 0.5 });
  ticks(g, 20);
  ok(gen2.fuel.count > 0 || belt.items.length === 0, '传送带把煤直送发电机燃料槽');
}

// ================= [P8] 存档：发电机燃料保存；旧档兼容 =================
console.log('\n[P8] 燃料随存档保存；无 power 字段的旧存档按旧行为运行');
{
  const g = newGame(81);
  const L = findLand(g, 2, 2);
  const x = L.x, y = L.y;
  const gen = genSet(g, x, y, 37);
  place(g, 'powerPole', x + 2, y);
  const acc = place(g, 'accumulator', x + 3, y);
  acc.accCharge = 500;
  g.power.markDirty(); ticks(g, 1);
  const data = g.serialize();
  ok(data.power && data.power.enabled, '存档含 power 字段');
  const sb = data.buildings.find(b => b.type === 'coalGenerator');
  ok(sb.fuelType === 'coal' && sb.fuelCount === 37, '发电机燃料写入存档');

  // 旧档：删除 power 字段与电力字段，且未研究电力科技
  delete data.power;
  data.research.completed = data.research.completed.filter(id => id !== 'electricity');
  for (const b of data.buildings) { delete b.fuelType; delete b.fuelCount; delete b.accCharge; }
  const g2 = new FG.Game();
  g2.deserialize(data);
  ok(!g2.power.enabled, '旧档（无电力科技）：电力系统关闭');
  const gen2 = g2.map.buildingAt(x, y);
  ok(gen2.fuel.count === 0, '旧档发电机缺省空燃料');
  const fur = place(g2, 'furnace', x + 8, y + 8);
  fur.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(fur);
  fur.slots.inputs.ironOre.count = 5;
  ticks(g2, 25);
  ok(fur.slots.outputs.ironPlate.count >= 1, '旧档中设备无需电力照常生产');
}

// ================= [P9] 拓扑重建：放置/拆除/施工落成 =================
console.log('\n[P9] 拆线路/新增设备后电网拓扑重建；拆除发电机煤落地面堆');
{
  const g = newGame(91);
  const L = findLand(g, 2, 2);
  const x = L.x, y = L.y;
  const { gen, pole, asm } = poweredRig(g, x, y, 50);
  ok(asm.powered, '初态有电');
  // 拆线路：组装机离网断电，发电机仍在（孤立）
  g.removeBuilding(pole);
  ticks(g, 1);
  ok(asm.net === null && !asm.powered, '拆除线路后用电设备离网断电');
  // 拆除发电机：燃料落地面堆
  g.removeBuilding(gen);
  ticks(g, 1);
  const pile = g.map.pileAt(x, y);
  ok(pile && pile.some(s => s.type === 'coal' && s.count > 0), '拆除发电机后煤炭落到地面堆不丢失');

  // 施工落成自动入网
  const gen3 = genSet(g, x + 6, y, 50);
  const pole3 = place(g, 'powerPole', x + 8, y);
  const plan = g.construction.addPlan({
    w: 1, h: 1, fromPreset: null,
    entries: [{ type: 'powerPole', dx: 0, dy: 0, dir: 0, recipe: null, filter: null, demandMode: false, priority: 'normal' }],
  }, x + 10, y);
  g.construction.plans[g.construction.plans.length - 1] = plan;
  // 直接给条目备齐建材并落成
  const e = plan.entries[0];
  e.stock = { ironPlate: 1 };
  ticks(g, 6);
  const newPole = g.map.buildingAt(x + 10, y);
  ok(newPole && newPole.def.powerPole && newPole.net === pole3.net, '施工落成的线路自动接入电网');
}

// ================= [P10] 传送带/箱子/管道不耗电；缺电不影响物流 =================
console.log('\n[P10] 传送带与箱子不耗电：全网断电时带面物品照常流动');
{
  const g = newGame(101);
  const L = findLand(g, 2, 2);
  const x = L.x, y = L.y;
  // 一条传送带（无任何电网）
  const b1 = place(g, 'belt', x, y, 1);
  const b2 = place(g, 'belt', x + 1, y, 1);
  const chest = place(g, 'chest', x + 2, y);
  b1.items.push({ type: 'ironOre', pos: 0 });
  ticks(g, 30);
  const moved = chest.chest.some(s => s.type === 'ironOre') || b2.items.length > 0;
  ok(moved, '无电网环境下传送带照常运输、箱子照常收货');
  // 一台未接线的机械臂断电
  const arm = place(g, 'inserter', x + 4, y);
  ticks(g, 2);
  ok(arm.status === 'unpowered', '孤立机械臂缺电暂停');
}

console.log('\n结果：' + pass + ' 通过, ' + fail + ' 失败');
if (fail) process.exit(1);
