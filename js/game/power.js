/**
 * FG.Power —— 电力系统：电网连通 × 保供优先级 × 蓄电池调峰 × 缺电联动
 *
 * 玩法：
 *  - 燃煤发电机（coalPlant）燃烧煤炭发电；电线杆（powerPole）之间在 POLE_WIRE_REACH
 *    格内以架空线互连组成电网，电线杆/发电机/蓄电池为电网节点，对 POLE_REACH 格内
 *    （Chebyshev 距离）的用电建筑供电；
 *  - 每个用电建筑可设置保供优先级（高/中/低）：每 tick 按层高到低分配电力，
 *    高优先级一层未满足前低优先级不供电，同级按轮转游标公平起步；电力不足时本 tick
 *    只得到部分能量的建筑降速运转，完全得不到电的建筑立即暂停；
 *  - 缺电联动：生产建筑（矿机/水泵/抽油机/熔炉/组装机/化工厂/炼油厂/实验室）
 *    与机械臂缺电即暂停（传送带/管道不耗电照常流动），按需物流调度不再向缺电
 *    消费者派料；恢复供电后所有建筑从原有进度/手持状态续作，不丢物料；
 *  - 蓄电池（accumulator）：电网有富余发电能力时充电，任何优先级层供电不足时
 *    放电补峰（充/放电均有功率上限），储能状态随存档保存；
 *  - 燃煤发电机可由传送带直接卸入煤炭、机械臂加煤，也会每 tick 自行从相邻
 *    （含自身格，便于拆建）箱子/地面物料堆补煤——启动期不需要另一条带电生产线。
 *
 * 单位：功率 kW，能量 kJ；每 tick = 1/TPS 秒，kJ = kW × 秒。
 *
 * 存档兼容：电网连通图不序列化（读档后首个 tick 惰性重建）；发电机燃料缓存、
 * 蓄电池储能、各建筑保供优先级随建筑存档，电力管理器状态单独序列化；
 * 无 power 字段的旧档按科技研究状态回退（未研究「电力工程」则全图免电运行，
 * 行为与旧版完全一致）。
 */
FG.Power = class Power {
  constructor(game) {
    this.game = game;
    this.enabled = false;   // 研究「电力工程」后开启；读档按研究状态恢复
    this.dirty = true;      // 电网需重建（建筑增删/读档后置脏）
    this.nodes = [];        // 电网节点（电线杆/发电机/蓄电池）
    this.grids = [];        // [{id,nodes:Set(key),gens:[b],poles:[b],accs:[b],stats:{}}]
    this.keyGrid = new Map();   // 节点 key -> grid
    this.consumerGrid = new Map(); // 用电建筑 key -> grid（未联网不在表中）
    this.tierStart = { high: 0, normal: 0, low: 0 };
    this.gridSeq = 1;
  }

  reset() {
    this.enabled = false;
    this.markDirty();
    this.tierStart = { high: 0, normal: 0, low: 0 };
    this.gridSeq = 1;
  }

  /** 研究完成时开启（读档已研究则直接置位，不产生解锁消息） */
  enable(silent) {
    if (this.enabled) return;
    this.enabled = true;
    this.markDirty();
    if (!silent) {
      this.game.logMsg('⚡ 电力系统已启用：用电线杆把燃煤发电机与工厂连成电网，'
        + '缺电时低保供优先级的生产、机械臂与科研将暂停', 'unlock');
      FG.Events.emit('power:change');
    }
  }

  markDirty() { this.dirty = true; }

  /** 该建筑是否为用电建筑（按定义表，与科技是否开启无关） */
  static isConsumer(b) { return !!(b && b.def && b.def.powerUse); }

  /** 该建筑是否为电网节点 */
  static isNode(b) {
    return !!(b && b.def && (b.def.powerPole || b.def.powerGen || b.def.accumulator));
  }

  isConsumer(b) { return FG.Power.isConsumer(b); }

  /** 用电建筑的保供优先级（旧字段缺省 → 普通） */
  static priorityOf(b) {
    return FG.Config.PRIORITIES[b.powerPriority] ? b.powerPriority : 'normal';
  }

  /** 建筑当前是否有电（电力未启用一律有电；电网状态在每 tick 初刷新） */
  isPowered(b) {
    if (!this.enabled || !FG.Power.isConsumer(b)) return true;
    return b._powered !== false;
  }

  /** 本 tick 供电比例 0..1（部分供电时建筑按此比例降速；未启用/不耗电返回 1） */
  powerRatio(b) {
    if (!this.enabled || !FG.Power.isConsumer(b)) return 1;
    return b._powerRatio === undefined ? 1 : b._powerRatio;
  }

  /** 建筑所在电网统计（UI/悬浮提示用；非节点/未联网返回 null） */
  gridAt(b) {
    if (!b || !FG.Power.isNode(b)) return null;
    return this.keyGrid.get(FG.Utils.key(b.x, b.y)) || null;
  }

  /** 用电建筑当前联网的电网（未联网返回 null） */
  gridOfConsumer(b) {
    return this.consumerGrid.get(FG.Utils.key(b.x, b.y)) || null;
  }

  // ================= 燃煤发电机供煤 =================
  /**
   * 向发电机加入 n 件煤（传送带卸入/机械臂加煤调用），返回实际接受数。
   * 燃料缓存满则拒收（物品留在带端/机械臂手中等待）。
   */
  refuel(b, type, n) {
    if (!b || !b.def || !b.def.powerGen || type !== 'coal') return 0;
    const cap = FG.Config.POWER_GEN_FUEL_CAP;
    const room = (cap - (b.fuel || 0)) / FG.Config.POWER_COAL_KJ;
    const take = Math.max(0, Math.min(n || 1, Math.floor(room + 1e-9)));
    if (take > 0) {
      b.fuel = (b.fuel || 0) + take * FG.Config.POWER_COAL_KJ;
      this.markDirty();
    }
    return take;
  }

  /** 发电机自行从相邻（含自身格）箱子/地面堆补煤（免电，保证可启动） */
  selfFeed(b) {
    if ((b.fuel || 0) >= FG.Config.POWER_COAL_KJ - 1e-9) return;
    let budget = FG.Config.POWER_GEN_SELFFEED;
    const m = this.game.map;
    const spots = [{ x: b.x, y: b.y, self: true }];
    for (const v of FG.Utils.dirs) spots.push({ x: b.x + v.x, y: b.y + v.y });
    for (const s of spots) {
      if (budget <= 0) break;
      if (!m.inBounds(s.x, s.y)) continue;
      const nb = m.buildingAt(s.x, s.y);
      // 自身格的地面煤堆（拆建回收/就地堆煤）也可取
      if (nb === b) {
        const pile = m.pileAt(s.x, s.y);
        const slot = pile && pile.find(x => x.type === 'coal' && x.count > 0);
        if (slot) {
          const take = Math.min(budget, slot.count,
            Math.floor((FG.Config.POWER_GEN_FUEL_CAP - (b.fuel || 0)) / FG.Config.POWER_COAL_KJ + 1e-9));
          if (take > 0) {
            for (let i = 0; i < take; i++) m.pileTake(s.x, s.y, 'coal');
            b.fuel = (b.fuel || 0) + take * FG.Config.POWER_COAL_KJ;
            budget -= take;
          }
        }
        continue;
      }
      if (nb && nb.def.storage) {
        for (const slot of nb.chest) {
          if (slot.type === 'coal' && slot.count > 0) {
            const take = Math.min(budget, slot.count,
              Math.floor((FG.Config.POWER_GEN_FUEL_CAP - (b.fuel || 0)) / FG.Config.POWER_COAL_KJ + 1e-9));
            if (take > 0) {
              slot.count -= take;
              b.fuel = (b.fuel || 0) + take * FG.Config.POWER_COAL_KJ;
              budget -= take;
            }
          }
        }
      } else if (!nb) {
        const pile = m.pileAt(s.x, s.y);
        if (pile) {
          const slot = pile.find(x => x.type === 'coal' && x.count > 0);
          if (slot) {
            const take = Math.min(budget, slot.count,
              Math.floor((FG.Config.POWER_GEN_FUEL_CAP - (b.fuel || 0)) / FG.Config.POWER_COAL_KJ + 1e-9));
            if (take > 0) {
              for (let i = 0; i < take; i++) m.pileTake(s.x, s.y, 'coal');
              b.fuel = (b.fuel || 0) + take * FG.Config.POWER_COAL_KJ;
              budget -= take;
            }
          }
        }
      }
    }
  }

  // ================= 电网重建（并查集） =================
  rebuild() {
    this.dirty = false;
    this.nodes = [];
    this.grids = [];
    this.keyGrid = new Map();
    this.consumerGrid = new Map();
    if (!this.enabled) return;

    const m = this.game.map;
    const index = new Map();  // key -> node
    const parent = new Map();
    const find = (k) => {
      let r = k;
      while (parent.get(r) !== r) r = parent.get(r);
      let x = k;
      while (parent.get(x) !== x) { const nx = parent.get(x); parent.set(x, r); x = nx; }
      return r;
    };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

    for (const b of m.buildings.values()) {
      if (!FG.Power.isNode(b)) continue;
      this.nodes.push(b);
      const k = FG.Utils.key(b.x, b.y);
      index.set(k, b);
      parent.set(k, k);
    }

    // 电线杆互连：POLE_WIRE_REACH 内的杆-杆（含车站式的其它节点只通过就近杆入网）
    const poles = this.nodes.filter(b => b.def.powerPole);
    for (let i = 0; i < poles.length; i++) {
      for (let j = i + 1; j < poles.length; j++) {
        if (cheb(poles[i], poles[j]) <= FG.Config.POLE_WIRE_REACH) {
          union(FG.Utils.key(poles[i].x, poles[i].y), FG.Utils.key(poles[j].x, poles[j].y));
        }
      }
    }
    // 发电机/蓄电池：接入 POLE_REACH 内最近的电线杆
    for (const b of this.nodes) {
      if (b.def.powerPole) continue;
      for (const p of poles) {
        if (cheb(b, p) <= FG.Config.POLE_REACH) {
          union(FG.Utils.key(b.x, b.y), FG.Utils.key(p.x, p.y));
          break;
        }
      }
    }

    // 根 -> 电网对象
    const byRoot = new Map();
    for (const b of this.nodes) {
      const root = find(FG.Utils.key(b.x, b.y));
      let g = byRoot.get(root);
      if (!g) {
        g = {
          id: 'PG' + (this.gridSeq++),
          nodeKeys: new Set(),
          nodes: [], gens: [], poles: [], accs: [],
          stats: PowerEmptyStats(),
        };
        byRoot.set(root, g);
        this.grids.push(g);
      }
      g.nodeKeys.add(FG.Utils.key(b.x, b.y));
      g.nodes.push(b);
      if (b.def.powerGen) g.gens.push(b);
      else if (b.def.accumulator) g.accs.push(b);
      else if (b.def.powerPole) g.poles.push(b);
    }
    for (const g of this.grids) {
      for (const b of g.nodes) this.keyGrid.set(FG.Utils.key(b.x, b.y), g);
    }

    // 用电建筑：归并到 POLE_REACH 内最近的任一节点所在电网（扫描顺序确定）
    for (const b of m.buildings.values()) {
      if (!FG.Power.isConsumer(b)) continue;
      let best = null, bestD = Infinity;
      for (const n of this.nodes) {
        const d = cheb(b, n);
        if (d <= FG.Config.POLE_REACH && d < bestD) { best = n; bestD = d; }
      }
      if (best) this.consumerGrid.set(FG.Utils.key(b.x, b.y), this.keyGrid.get(FG.Utils.key(best.x, best.y)));
    }
  }

  // ================= 主循环（须在 sim.tick 之前：先定电、后生产） =================
  tick() {
    if (!this.enabled) return;
    if (this.dirty) this.rebuild();

    const TPS = FG.Config.TPS;
    // 重置用电状态（未在下方得到分配的建筑本 tick 缺电）
    for (const b of this.game.map.buildings.values()) {
      if (FG.Power.isConsumer(b)) { b._powered = false; b._powerRatio = 0; }
    }
    this.tierStart = { high: 0, normal: 0, low: 0 };

    for (const g of this.grids) this.tickGrid(g, TPS);
  }

  tickGrid(g, TPS) {
    // 1. 发电机自行补煤（免电启动）
    for (const gen of g.gens) this.selfFeed(gen);

    // 2. 盘点本 tick 用电需求（按建筑当前物料状态判活跃/待机）
    const loads = [];
    for (const b of this.game.map.buildings.values()) {
      if (!FG.Power.isConsumer(b) || this.consumerGrid.get(FG.Utils.key(b.x, b.y)) !== g) continue;
      const active = this.intendedActive(b);
      const ratedKj = b.def.powerUse / TPS;
      loads.push({
        b,
        tier: FG.Power.priorityOf(b),
        demand: ratedKj * (active ? 1 : FG.Config.POWER_STANDBY_RATIO),
        ratedKj, active,
        alloc: 0,
      });
    }
    // 确定性顺序（同级轮转公平 + 存档/平台一致）
    loads.sort((a, c) => FG.Utils.key(a.b.x, a.b.y) < FG.Utils.key(c.b.x, c.b.y) ? -1 : 1);

    // 3. 可用能量：发电机燃料（受输出功率上限）+ 蓄电池可放电量（kJ/tick）
    let genCap = 0;
    for (const gen of g.gens) {
      gen._genLoad = 0;
      genCap += Math.min((gen.fuel || 0), FG.Config.POWER_GEN_KW / TPS);
    }
    let batteryAvail = 0;
    for (const a of g.accs) {
      batteryAvail += Math.min(a.accCharge || 0, FG.Config.ACC_DISCHARGE_KW / TPS);
    }

    // 4. 按保供优先级层高到低拨付：整层可满足时全部满足；
    //    层需求超出剩余能量时做「赤字轮转（deficit round-robin）」公平分摊——
    //    每轮按当前未满足者均分残余能量（每人至多拿到自身剩余需求），被满足者退出，
    //    多轮迭代后残余能量在所有同级消费者间按比例落位，起点每 tick 轮转防饿死。
    let budget = genCap + batteryAvail;
    for (const tier of FG.Config.POWER_TIERS) {
      const list = loads.filter(l => l.tier === tier);
      if (!list.length) continue;
      const tierDemand = list.reduce((n, l) => n + l.demand, 0);
      if (tierDemand <= budget + 1e-9) {
        for (const l of list) { l.alloc = l.demand; budget -= l.demand; }
      } else if (budget > 1e-9) {
        // 赤字轮转：每轮用「当前残余/当前未满足人数」作为均份额，
        // 需求小的先被满足并退出，下一轮在剩余者间重算均份额；
        // 同需求者趋于按比例分摊（迭代到残余耗尽或仅剩 1 人）。
        const rest = list.map(l => l);
        let guard = 0;
        while (rest.length > 1 && budget > 1e-9 && guard++ < 64) {
          const share = budget / rest.length;
          let given = 0;
          for (const l of rest) {
            const want = l.demand - l.alloc;
            const give = Math.min(want, share);
            if (give > 1e-9) { l.alloc += give; given += give; }
          }
          budget -= given;
          for (let i = rest.length - 1; i >= 0; i--) {
            if (rest[i].alloc >= rest[i].demand - 1e-9) rest.splice(i, 1);
          }
        }
        if (rest.length === 1 && budget > 1e-9) {
          const l = rest[0];
          const give = Math.min(l.demand - l.alloc, budget);
          l.alloc += give; budget -= give;
        }
        budget = Math.max(0, budget);
      }
      if (list.length) this.tierStart[tier] = (this.tierStart[tier] + 1) % list.length;
    }

    let totalLoad = 0, activeDemand = 0;
    for (const l of loads) {
      totalLoad += l.demand;
      if (l.active) activeDemand += l.ratedKj;
      if (l.alloc > 1e-9) {
        l.b._powered = true;
        l.b._powerRatio = Math.max(0, Math.min(1, l.alloc / l.demand));
      }
    }

    // 5. 能源核销：发电优先（实际可发电量），蓄电池只补发电缺口
    const genUsed0 = Math.min(genCap, totalLoad);
    const batteryUsed = Math.min(batteryAvail, Math.max(0, totalLoad - genUsed0));
    const served = Math.min(totalLoad, genUsed0 + batteryUsed);
    let genUsed = genUsed0;

    // 6. 富余发电能力给蓄电池充电（只有负荷已被覆盖、且发电机还有燃料余量时才充）
    let charge = 0;
    const accChargeCap = FG.Config.ACC_CHARGE_KW / TPS;
    const chargeRooms = g.accs.map(a => {
      a._accW = 0;
      return {
        a, room: Math.min(accChargeCap, Math.max(0, FG.Config.ACC_CAP_KJ - (a.accCharge || 0))),
      };
    }).filter(x => x.room > 1e-9);
    let genSurplus = Math.max(0, genCap - genUsed);
    if (genSurplus > 1e-9 && chargeRooms.length) {
      // 轮转均摊，避免同电网中部分电池长期充不上
      let i = 0, guard = 0;
      while (genSurplus > 1e-9 && guard++ < 64) {
        const x = chargeRooms[i % chargeRooms.length];
        const take = Math.min(genSurplus, x.room, 0.5);
        if (take > 1e-9) {
          x.a.accCharge = (x.a.accCharge || 0) + take;
          x.a._accW = (x.a._accW || 0) + take;
          x.room -= take;
          genSurplus -= take;
          charge += take;
        }
        if (chargeRooms.every(c => c.room <= 1e-9)) break;
        i++;
      }
      genUsed += charge;
    }

    // 7. 燃料核销：负荷+充电均摊到各发电机（轮转，受单机 tick 输出上限与燃料约束）
    let genRemaining = genUsed;
    const gens = g.gens.slice().sort((a, c) =>
      FG.Utils.key(a.x, a.y) < FG.Utils.key(c.x, c.y) ? -1 : 1);
    let guard = 0;
    while (genRemaining > 1e-9 && guard++ < 64) {
      let progressed = false;
      for (const gen of gens) {
        const cap = Math.min((gen.fuel || 0), FG.Config.POWER_GEN_KW / TPS) - gen._genLoad;
        const take = Math.min(genRemaining, cap, 0.5);
        if (take > 1e-9) {
          gen.fuel = Math.max(0, (gen.fuel || 0) - take);
          gen._genLoad += take;
          genRemaining -= take;
          progressed = true;
        }
      }
      if (!progressed) break;
    }

    // 8. 蓄电池放电核销（按可用容量比例分摊）
    if (batteryUsed > 1e-9) {
      for (const a of g.accs) {
        const avail = Math.min(a.accCharge || 0, FG.Config.ACC_DISCHARGE_KW / TPS);
        const share = batteryAvail > 1e-9 ? avail / batteryAvail : 0;
        const d = Math.min(avail, batteryUsed * share + 1e-6);
        a.accCharge = Math.max(0, (a.accCharge || 0) - Math.min(d, avail));
        a._accW = -Math.min(d, avail) * TPS;
      }
    }

    // 9. 状态与统计
    for (const gen of g.gens) {
      gen.status = gen._genLoad > 1e-9 ? 'working'
        : ((gen.fuel || 0) <= 1e-9 && totalLoad > 1e-9 ? 'starving' : 'idle');
    }
    for (const a of g.accs) {
      a.status = (a._accW || 0) !== 0 ? 'working' : 'idle';
    }
    g.stats = {
      demandKw: totalLoad * TPS,
      activeDemandKw: activeDemand * TPS,
      genKw: Math.min(genUsed, genCap) * TPS,
      genCapKw: g.gens.reduce((n, gen) => n + ((gen.fuel || 0) > 1e-9 ? FG.Config.POWER_GEN_KW : 0), 0),
      chargeKw: charge * TPS,
      dischargeKw: batteryUsed * TPS,
      satisfaction: totalLoad > 1e-9 ? Math.max(0, Math.min(1, served / totalLoad)) : 1,
      unpowered: loads.filter(l => l.alloc <= 1e-9).length,
      consumers: loads.length,
    };
  }

  /**
   * 判定建筑本 tick 是否「打算运转」（决定满负荷还是待机功率）：
   * 与 sim 的缺料/堵塞判定同口径，不修改建筑任何状态。
   * 故障停机的建筑不参与；机械臂始终维持满额定（待机也持续待命，功率很小）。
   */
  intendedActive(b) {
    if (b.broken) return false;
    const m = this.game.map;
    if (b.def.inserterTier !== undefined) return true;
    if (b.type === 'miner') {
      const ore = m.ores[b.y] && m.ores[b.y][b.x];
      if (!ore || ore.amount <= 0) return false;
      const out = b.slots.outputs[ore.type];
      return !out || out.count < out.cap;
    }
    if (b.type === 'pump') return true;   // 水域不枯竭
    if (b.type === 'pumpjack') return m.isOil(b.x, b.y);
    if (b.type === 'lab') {
      const tech = this.game.research.current;
      if (!tech) return false;
      return Object.keys(tech.cost).every(pack => {
        const s = b.slots.inputs[pack];
        return s && s.count >= 1;
      });
    }
    if (b.def.recipeBuilding) {
      const recipe = b.recipe ? FG.Recipes.byId(b.recipe) : null;
      if (!recipe || !this.game.research.isRecipeUnlocked(recipe.id)) return false;
      for (const ing of recipe.ingredients) {
        if (FG.Items.isFluid(ing.item)) {
          if ((b.fluidTanks[ing.item] || 0) < ing.count) return false;
        } else {
          const s = b.slots.inputs[ing.item];
          if (!s || s.count < ing.count) return false;
        }
      }
      for (const r of recipe.results) {
        if (FG.Items.isFluid(r.item)) {
          if ((b.fluidTanks[r.item] || 0) >= FG.Config.FLUID_TANK_CAP * 0.9) return false;
        } else {
          const s = b.slots.outputs[r.item];
          if (s && s.count >= s.cap) return false;
        }
      }
      return true;
    }
    return false;
  }

  // ================= 存档 =================
  /** 电网连通图不序列化；燃料/储能随建筑存档；此处仅保存开关与游标 */
  serialize() {
    return {
      enabled: !!this.enabled,
      seq: this.gridSeq,
    };
  }

  deserialize(data) {
    this.reset();
    // 启用状态以科技研究为准（旧档无 power 字段：研究过「电力工程」则启用）
    this.enabled = !!(data && data.enabled)
      || !!(this.game.research && this.game.research.completed.has('electricPower'));
    if (data && data.seq) this.gridSeq = data.seq | 0;
    this.markDirty();   // 首个 tick 惰性重建电网
  }
};

function PowerEmptyStats() {
  return {
    demandKw: 0, activeDemandKw: 0, genKw: 0, genCapKw: 0,
    chargeKw: 0, dischargeKw: 0, satisfaction: 1, unpowered: 0, consumers: 0,
  };
}
