/**
 * FG.Power —— 电力网络管理（研究「电力网络」后启用）
 *
 * 组成：
 *  - 燃煤发电机（coalGenerator）：烧煤发电，发电量随电网实际需求调节，不满载不耗煤；
 *  - 输电线路（powerPole）：曼哈顿距离 ≤ POLE_REACH 的线路自动接线，同时为同范围内的
 *    发电机/用电设备/蓄电池提供接入点；不连续的线路属于不同电网（互相不供电）；
 *  - 蓄电池（accumulator）：电量富余时充电、缺电时放电，电量随存档保存。
 *
 * 保供优先级（缺电轮停）：
 *  - 每个电网每 tick 先盘点需求（正在运转的设备按 POWER_USE 计），发电机满发 + 蓄电池
 *    放电仍不足时按层级切负荷：高优先级（b.priority='high'）→ 普通 → 低 → 科研实验室
 *    （固定最末档，即便设了高优先也在生产之后）；高层未全部保住前，低一层一律断电；
 *    同层需求仍超出可用电力时按轮转游标均匀切停，避免每次都是同一批设备停电。
 *  - 被切停的设备：生产建筑/矿机/水泵/实验室冻结进度（不耗料、不积累磨损），机械臂
 *    停在原节拍（手持物保留）；供电恢复的下一 tick 自动续作，生产进度与储能状态不丢。
 *
 * 拓扑：
 *  - 建筑放置/拆除（含蓝图施工落成、升级替换、读档注册）后标记 dirty，下一 tick 惰性
 *    重建连通分量（节点=线路，发电机/设备/蓄电池吸附到范围内最近的线路）。
 *
 * 存档兼容：
 *  - 仅蓄电池电量需要持久化（b.accCharge，随建筑序列化）；网络拓扑与供电状态不序列化，
 *    读档后首个 tick 惰性重建。无 power 字段 / 无「电力网络」科技的旧档：系统关闭，
 *    所有设备视为有电（b.powered=true），行为与旧版完全一致。
 */
FG.Power = class Power {
  constructor(game) {
    this.game = game;
    this.enabled = false;     // 研究「电力网络」后开启（读档按研究状态恢复）
    this.nets = [];           // 电网列表 {id, nodes:Set(b), gens:[], loads:[], accs:[]}
    this.netSeq = 1;
    this.dirty = true;        // 拓扑脏标记（放置/拆除/读档后重建）
    this.alerted = false;     // 本 tick 是否有电网缺电（顶栏告警 / 日志节流用）
    this.alertTick = -999;
  }

  reset() {
    this.nets = [];
    this.netSeq = 1;
    this.dirty = true;
    this.alerted = false;
    this.alertTick = -999;
    if (!this.game.map) return;
    for (const b of this.game.map.buildings.values()) { b.net = null; b.powered = true; }
  }

  /** 研究完成时开启：全图设备标记待重算 */
  enable() {
    if (this.enabled) return;
    this.enabled = true;
    // 研究前放置的设备补电力字段缺省值（重建前先按有电对待，避免一 tick 误停）
    for (const b of this.game.map.buildings.values()) {
      if (b.powered === undefined) b.powered = true;
      if (b.net === undefined) b.net = null;
    }
    this.markDirty();
    this.game.logMsg('⚡ 电力网络已启用：燃煤发电机烧煤发电，线路 2 格内自动接线，'
      + '用电设备须接入电网；缺电时按保供优先级轮停，供电恢复后自动续作', 'unlock');
    FG.Events.emit('power:change');
  }

  /** 该建筑是否接入电网后才需要电力（传送带/管道/箱子/线路/铁路不耗电） */
  static isLoad(b) {
    return !!b && !!b.def && FG.Config.POWER_USE[b.type] !== undefined;
  }

  isLoad(b) { return FG.Power.isLoad(b); }

  /** 该建筑能否接入电网（发电机/用电设备/蓄电池，需由范围内线路连接） */
  static isConnectable(b) {
    return !!b && !!b.def && (b.def.powerGen || b.def.powerPole || b.def.powerStorage
      || FG.Config.POWER_USE[b.type] !== undefined);
  }

  /** 需求层级：实验室固定最末档（科研保供优先级最低）；其余按建筑保供优先级 */
  static tierOf(b) {
    if (b.type === 'lab') return 0;
    if (b.priority === 'high') return 3;
    if (b.priority === 'low') return 1;
    return 2;
  }

  markDirty() { this.dirty = true; }

  /** 建筑（x,y）是否在某条线路的供电范围内 */
  poleNear(x, y) {
    const R = FG.Config.POLE_REACH;
    for (const p of this.game.map.buildings.values()) {
      if (p.def.powerPole && Math.abs(p.x - x) + Math.abs(p.y - y) <= R) return p;
    }
    return null;
  }

  // ================= 拓扑重建 =================
  rebuild() {
    this.nets = [];
    this.dirty = false;
    const map = this.game.map;
    for (const b of map.buildings.values()) b.net = null;
    if (!this.enabled) {
      for (const b of map.buildings.values()) b.powered = true;
      return;
    }

    // 1) 线路连通分量（曼哈顿距离 ≤ R 的线路相互接线）
    const poles = [];
    for (const b of map.buildings.values()) if (b.def.powerPole) poles.push(b);
    const parent = new Map();
    const find = (b) => {
      let r = b;
      while (parent.get(r) !== r) r = parent.get(r);
      let x = b;
      while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; }
      return r;
    };
    const union = (a, c) => { const ra = find(a), rc = find(c); if (ra !== rc) parent.set(ra, rc); };
    for (const p of poles) parent.set(p, p);
    // 按 y,x 排序，只需检查向后 R 行内的邻居（规模通常不大；R=2）
    poles.sort((a, c) => (a.y - c.y) || (a.x - c.x));
    const R = FG.Config.POLE_REACH;
    for (let i = 0; i < poles.length; i++) {
      for (let j = i + 1; j < poles.length; j++) {
        if (poles[j].y - poles[i].y > R) break;
        if (Math.abs(poles[j].x - poles[i].x) + Math.abs(poles[j].y - poles[i].y) <= R) {
          union(poles[i], poles[j]);
        }
      }
    }
    const rootToNet = new Map();
    const netOfPole = (p) => {
      const root = find(p);
      let net = rootToNet.get(root);
      if (!net) {
        net = {
          id: 'N' + (this.netSeq++),
          poles: new Set(), gens: [], loads: [], accs: [],
          demand: 0, supplied: 0, genKw: 0, accChargeKw: 0, accDischargeKw: 0,
          deficit: 0, satisfied: true,
          rr: { 3: 0, 2: 0, 1: 0, 0: 0 },
        };
        rootToNet.set(root, net);
        this.nets.push(net);
      }
      return net;
    };
    for (const p of poles) { const net = netOfPole(p); net.poles.add(p); p.net = net; }

    // 2) 非线路建筑吸附到范围内线路（多个可达时任选其一——可达线路必然同属一个分量）
    for (const b of map.buildings.values()) {
      if (b.def.powerPole) continue;
      if (!FG.Power.isConnectable(b)) { b.powered = true; continue; }
      const p = this.poleNear(b.x, b.y);
      if (p) b.net = p.net;
    }
    for (const b of map.buildings.values()) {
      if (!b.net) continue;
      if (b.def.powerGen) b.net.gens.push(b);
      else if (b.def.powerStorage) b.net.accs.push(b);
      else if (FG.Config.POWER_USE[b.type] !== undefined) b.net.loads.push(b);
    }
  }

  /** 设备是否处于「正在运转、需要电力」的状态由 settleNet 内联判定（忽略上一 tick
   *  的 unpowered 状态，保证供电恢复的同一 tick 即可续作）。 */

  /** 当前电网总发电能力（kW，不计燃料限制——燃料在结算时逐机扣减） */
  static genCapacity(net) {
    return net.gens.reduce((n, g) => n + (g.fuel && g.fuel.count > 0 ? FG.Config.GEN_POWER_KW : 0), 0);
  }

  // ================= 每 tick 结算（sim.tick 最前面调用） =================
  tick() {
    if (this.dirty) this.rebuild();
    this.alerted = false;
    if (!this.enabled) {
      for (const b of this.game.map.buildings.values()) b.powered = true;
      return;
    }
    const researchActive = !!this.game.research.current;
    for (const net of this.nets) this.settleNet(net, researchActive);

    // 没有接入任何电网的用电设备：一律断电（线路/发电机本身不需要保供标记）
    for (const b of this.game.map.buildings.values()) {
      if (FG.Config.POWER_USE[b.type] !== undefined && !b.net) b.powered = false;
    }
    if (this.alerted && this.game.tickCount - this.alertTick > FG.Config.TPS * 3) {
      this.alertTick = this.game.tickCount;
      this.game.logMsg('⚠ 电网供电不足：已按保供优先级暂停部分设备（科研最末），'
        + '请增建燃煤发电机或等待蓄电池回充', 'error');
    }
  }

  /** 单个电网：需求分层 → 发电机按需发电 → 蓄电池削峰填谷 → 分层切负荷 */
  settleNet(net, researchActive) {
    const C = FG.Config;
    // 1) 分层收集活跃需求（忽略上一 tick 的 unpowered 状态，恢复供电当 tick 即可续作）
    const tiers = { 3: [], 2: [], 1: [], 0: [] };
    for (const b of net.loads) {
      const active = b.def.inserterTier !== undefined ? true
        : (b.type === 'lab' ? researchActive
          : b.type === 'miner' ? this.game.map.oreAt(b.x, b.y) !== null && b.status !== 'blocked'
            : (b.type === 'pump' || b.type === 'pumpjack') ? b.status !== 'blocked'
              : !!b.recipe);
      if (active) tiers[FG.Power.tierOf(b)].push(b);
    }
    let demand = 0;
    for (const t of [3, 2, 1, 0]) for (const b of tiers[t]) demand += C.POWER_USE[b.type] || 0;

    // 2) 可用电力：发电机（燃料受限）+ 蓄电池放电
    const genCap = FG.Power.genCapacity(net);
    const accAvailKw = net.accs.reduce((n, a) =>
      n + Math.min(C.ACC_RATE_KW, a.accCharge * C.TPS), 0);   // kJ → kW（1 tick=1/TPS 秒）
    const supply = genCap + accAvailKw;

    // 3) 分层保供：高层未满足前低层全部断电；同层不足按轮转均匀切停
    const powered = new Set();
    let remaining = supply;
    for (const t of [3, 2, 1, 0]) {
      const list = tiers[t];
      const need = list.reduce((n, b) => n + (C.POWER_USE[b.type] || 0), 0);
      if (!list.length) continue;
      if (remaining + 1e-6 >= need) {
        for (const b of list) powered.add(b);
        remaining -= need;
      } else {
        // 该层内按功率贪心 + 轮转起点切停：尽量多保设备，起点轮转保证公平
        const start = net.rr[t] % list.length;
        let budget = remaining;
        const chosen = new Set();
        for (let n = 0; n < list.length; n++) {
          const b = list[(start + n) % list.length];
          const w = C.POWER_USE[b.type] || 0;
          if (w <= budget + 1e-6) { budget -= w; chosen.add(b); }
        }
        for (const b of chosen) powered.add(b);
        remaining = 0;
        net.rr[t] = (start + 1) % list.length;   // 该层发生切停：轮转起点前移
        break;   // 更低层一律断电
      }
    }

    // 4) 实际用电功率（被保住的负荷）
    let usedKw = 0;
    for (const b of powered) { usedKw += C.POWER_USE[b.type] || 0; b.powered = true; }
    for (const t of [3, 2, 1, 0]) for (const b of tiers[t]) {
      if (!powered.has(b)) b.powered = false;
    }

    // 5) 发电与蓄电池结算：先蓄电池放电补缺 → 发电机按剩余需求发 → 富余给蓄电池充电
    let needFromGen = usedKw;
    let accDischarge = 0, accCharge = 0;
    if (usedKw > genCap) {
      // 发电机满发，缺口由蓄电池补
      needFromGen = genCap;
      accDischarge = usedKw - genCap;
      let left = accDischarge / C.TPS;   // kJ
      for (const a of net.accs) {
        if (left <= 1e-6) break;
        const give = Math.min(a.accCharge, C.ACC_RATE_KW / C.TPS, left);
        a.accCharge -= give;
        left -= give;
      }
      accDischarge -= left * C.TPS;     // 蓄电池也补不上的部分（理论上切负荷后不会发生）
    } else {
      // 发电机按需求发（不满载不浪费煤）；富余电力给蓄电池充电
      const spare = genCap - usedKw;
      let left = Math.min(spare, net.accs.reduce((n, a) =>
        n + Math.min(C.ACC_RATE_KW, (C.ACC_CAPACITY_KJ - a.accCharge) * C.TPS), 0)) / C.TPS;
      accCharge = left * C.TPS;
      for (const a of net.accs) {
        if (left <= 1e-6) break;
        const take = Math.min(C.ACC_CAPACITY_KJ - a.accCharge, C.ACC_RATE_KW / C.TPS, left);
        a.accCharge += take;
        left -= take;
      }
      accCharge -= left * C.TPS;
    }

    // 6) 发电机逐机均摊发电并按实际出力耗煤（小数累计余数，避免低速时永远不耗煤）
    let genOutTotal = 0;
    const fueled = net.gens.filter(g => g.fuel && g.fuel.count > 0);
    if (needFromGen > 0) {
      // genCapacity 只计有燃料的机器，故 needFromGen ≤ fueled.length × 额定功率
      const each = Math.min(needFromGen / Math.max(1, fueled.length), C.GEN_POWER_KW);
      for (const g of fueled) {
        const out = Math.min(each, C.GEN_POWER_KW, needFromGen - genOutTotal);
        g.genOutput = out;
        genOutTotal += out;
        g._fuelAcc = (g._fuelAcc || 0) + (out / C.GEN_POWER_KW) * C.GEN_FUEL_PER_TICK;
        while (g._fuelAcc >= 1 && g.fuel.count > 0) {
          g._fuelAcc -= 1;
          g.fuel.count--;
        }
        if (g.fuel.count <= 0) { g.fuel.count = 0; g.fuel.type = null; }
      }
    }
    for (const g of net.gens) {
      if (!fueled.includes(g)) g.genOutput = 0;   // 无燃料 / 无需求：停机不耗煤
    }

    net.demand = demand;
    net.supplied = usedKw;
    net.genKw = genOutTotal;
    net.accChargeKw = accCharge;
    net.accDischargeKw = accDischarge;
    net.deficit = Math.max(0, demand - usedKw);
    net.satisfied = net.deficit <= 1e-6;
    if (!net.satisfied) this.alerted = true;
  }

  /** 建筑所在电网的概况（UI 用） */
  netOf(b) { return b.net || null; }

  /** 全图电力汇总（顶栏/概况页用） */
  summary() {
    if (!this.enabled) return null;
    let demand = 0, supplied = 0, genKw = 0, accKj = 0, accCap = 0, deficient = 0;
    for (const net of this.nets) {
      demand += net.demand; supplied += net.supplied; genKw += net.genKw;
      if (net.deficit > 1e-6) deficient++;
    }
    for (const b of this.game.map.buildings.values()) {
      if (b.def.powerStorage) { accKj += b.accCharge; accCap += FG.Config.ACC_CAPACITY_KJ; }
    }
    return { demand, supplied, genKw, accKj, accCap, deficient, nets: this.nets.length };
  }

  // ================= 存档（拓扑/供态不持久化；蓄电池电量随建筑字段存档） =================
  serialize() { return { enabled: !!this.enabled, netSeq: this.netSeq }; }

  deserialize(data) {
    this.reset();
    // 启用状态以科技研究为准（旧档无 power 字段：研究过则开启）
    this.enabled = !!(data && data.enabled)
      || !!(this.game.research && this.game.research.completed.has('electricity'));
    // 蓄电池电量已随建筑 b.accCharge 读入（旧档无字段 → 0）
    for (const b of this.game.map.buildings.values()) {
      if (b.def.powerGen && b.fuel) {
        b.fuel.count = Math.max(0, b.fuel.count | 0);
        if (b.fuel.count <= 0) b.fuel.type = null;
        b.genOutput = 0;
      }
      if (b.def.powerStorage) {
        b.accCharge = Math.max(0, Math.min(FG.Config.ACC_CAPACITY_KJ, b.accCharge || 0));
      }
    }
    this.dirty = true;   // 首个 tick 惰性重建拓扑
  }
};
