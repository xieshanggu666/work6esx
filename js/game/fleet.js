/**
 * FG.Fleet —— 按需铁路运输调度器
 *
 * 玩法：玩家给火车站配置「需求清单」（物品 × 库存下限/上限）与「供货清单」
 * （可供物品 × 供货优先级）；调度器周期性扫描全图缺口，把空闲列车（无手动
 * 运输计划、当前待命）自动编组为「供货站装货 → 需求站卸货」的循环运输任务，
 * 缺口补足或条件消失后自动撤任务、列车回待命。交付站的在执行合同自动成为
 * 高优先虚拟需求（合同缺口联动），无需玩家重复配置。
 *
 * 料权模型（与合同/施工预留同一套语义：预留即移出物流）：
 *  - 派车瞬间按「可供量」从供货站台账预留 reserve（站 → 物品 → 件数），
 *    预留件对按需调度 Scheduler 不可见（freeAt 盘点车站货位时统一扣除），
 *    不会在列车赶到前被机械臂/其他运输抢光；预留是台账下限而非物理锁，
 *    列车实际装货仍按车站当时货位搬运（装不够自动少装，离站时按实载核销）；
 *  - 在途货量统一扣除：缺口 = 上限 − 到站库存 − 在途。在途 = 已派任务的
 *    在站预留（装货前）+ 任务列车车载（装货后、离开需求站前），同一批货
 *    不会被两列空闲车重复派单，也不会因车站已有大量在途而过量补车；
 *  - 列车装货离站后该任务的预留按车上实载核销（货已上车，由车载计入在途），
 *    少装的预留量当场恢复为自由货物；车载货物在全局 inventory 中始终可见，
 *    但不会被任何预算池重复发放；
 *  - 多需求争料：需求按优先级分层（高优先未补足前低优先不派车），同级
 *    轮转公平；供货站按供货优先级 + 轮转选择；空闲列车轮转公平起步。
 *
 * 任务生命周期（job）：
 *  - toLoad：列车驶向/停靠供货站装货（预留挂在供货站）；离站瞬间按实载核销；
 *  - toDest：已装货离站，驶向/停靠需求站卸货（在途按车载计）；循环任务
 *    卸完离站后自动返回供货站继续装货（回到 toLoad），直到缺口补足；
 *  - 收尾：缺口消失（库存+在途 ≥ 上限）/ 需求或规则撤销 / 合同完成或逾期 /
 *    供货站拆除 / 列车停运或被玩家接管 → 在当前停靠站卸完后撤任务回待命，
 *    预留同步释放；需求站拆除时在途货物释放回供货站货位（供货站也没了则
 *    落到列车所在格地面堆），绝不丢货；连续两趟零交付（站库满/源头断料）
 *    自动撤任务，等库存条件变化后由下一轮扫描重新派车。
 *
 * 断路：断路是列车运行层状态（FG.Train 'noroute'），任务不撤销；补轨后
 * 列车自动重新寻路，任务继续履约。
 *
 * 与旧运输计划/存档兼容：
 *  - 只有「无计划且待命」的列车才会被自动派车；玩家手动编辑列车计划
 *    （增删停靠站/停运/解编）即视为接管，任务在当前站收尾撤销，手动计划
 *    永远不被调度器改写；
 *  - 自动任务生成的停靠站带 fleetJobId 标记，随列车存档；fleet.jobs /
 *    reserve / 规则 / 轮转游标全部序列化；旧存档无 fleet 字段 → 空规则、
 *    无任务，旧运输计划（停靠站无 fleetJobId）一律视为手动计划，行为不变。
 */
FG.Fleet = class Fleet {
  constructor(game) {
    this.game = game;
    this.enabled = true;          // 按需运输总开关
    this.jobs = [];               // 进行中的自动任务（见 assign 的结构）
    this.reserve = new Map();     // stationKey -> Map(item -> n) 供货站在站预留
    this.seq = 1;
    this.demandCursor = 0;        // 同级需求轮转游标
    this.supplyCursor = 0;        // 同级供货轮转游标
    this.trainCursor = 0;         // 空闲列车轮转游标
  }

  reset() {
    this.enabled = true;
    this.jobs = [];
    this.reserve.clear();
    this.seq = 1;
    this.demandCursor = 0;
    this.supplyCursor = 0;
    this.trainCursor = 0;
  }

  setEnabled(v) {
    this.enabled = !!v;
    if (!this.enabled) {
      // 关闭自动派车：撤销全部任务（列车在当前站收尾回待命），预留释放
      for (const job of this.jobs.slice()) {
        const tr = this.game.railway.trainById(job.trainId);
        if (tr) this.cancelJob(job, tr, 'disabled');
      }
    }
    FG.Events.emit('fleet:change');
  }

  stationKey(st) { return FG.Utils.key(st.x, st.y); }

  // ================= 站点规则 =================
  /** 站点需求清单（顺序固定）：{id,item,min,max,priority,enabled} */
  demandsOf(st) {
    if (!st || !st.def || !st.def.railStation) return [];
    if (!st.fleetDemands) st.fleetDemands = [];
    return st.fleetDemands;
  }
  /** 站点供货清单：{id,item,priority,enabled} */
  suppliesOf(st) {
    if (!st || !st.def || !st.def.railStation) return [];
    if (!st.fleetSupplies) st.fleetSupplies = [];
    return st.fleetSupplies;
  }

  addDemand(st, item, min, max, priority) {
    if (!item || !st.def.railStation) return null;
    const list = this.demandsOf(st);
    const d = {
      id: 'D' + (this.seq++), item,
      min: clampLimit(min, 1), max: clampLimit(max, min + 1),
      priority: FG.Config.PRIORITIES[priority] ? priority : 'normal',
      enabled: true,
    };
    list.push(d);
    FG.Events.emit('fleet:change');
    return d;
  }

  updateDemand(st, id, patch) {
    const d = this.demandsOf(st).find(x => x.id === id);
    if (!d) return;
    if ('item' in patch && patch.item) d.item = patch.item;
    if (patch.min !== undefined) d.min = clampLimit(patch.min, 1);
    if (patch.max !== undefined) d.max = Math.max(d.min + 1, clampLimit(patch.max, d.min + 1));
    if (patch.priority && FG.Config.PRIORITIES[patch.priority]) d.priority = patch.priority;
    if (patch.enabled !== undefined) d.enabled = !!patch.enabled;
    FG.Events.emit('fleet:change');
  }

  removeDemand(st, id) {
    const list = this.demandsOf(st);
    const i = list.findIndex(x => x.id === id);
    if (i < 0) return;
    list.splice(i, 1);
    // 规则删除：在途任务在下次离站时收尾（不半路急停），预留继续保留至装货核销
    FG.Events.emit('fleet:change');
  }

  addSupply(st, item, priority) {
    if (!item || !st.def.railStation) return null;
    const list = this.suppliesOf(st);
    if (list.some(x => x.item === item)) return null;
    const s = { id: 'P' + (this.seq++), item, priority: FG.Config.PRIORITIES[priority] ? priority : 'normal', enabled: true };
    list.push(s);
    FG.Events.emit('fleet:change');
    return s;
  }

  updateSupply(st, id, patch) {
    const s = this.suppliesOf(st).find(x => x.id === id);
    if (!s) return;
    if (patch.priority && FG.Config.PRIORITIES[patch.priority]) s.priority = patch.priority;
    if (patch.enabled !== undefined) s.enabled = !!patch.enabled;
    FG.Events.emit('fleet:change');
  }

  removeSupply(st, id) {
    const list = this.suppliesOf(st);
    const i = list.findIndex(x => x.id === id);
    if (i < 0) return;
    const removed = list.splice(i, 1)[0];
    // 供货规则撤销：以该站为供货站的任务立即撤销（车上的货保留，回待命后优先消化）
    for (const job of this.jobs.slice()) {
      if (job.srcKey === this.stationKey(st) && job.item === removed.item) {
        const tr = this.game.railway.trainById(job.trainId);
        if (tr) this.cancelJob(job, tr, 'supply-removed');
      }
    }
    FG.Events.emit('fleet:change');
  }

  /** 需求规则是否仍有效（站点存在且规则启用） */
  demandAlive(ry, job) {
    const st = ry.stationById(job.destId) || this.stationByKey(job.destKey);
    if (!st) return false;
    if (job.kind === 'contract') {
      const c = this.game.contracts && this.game.contracts.contractAt(st);
      return !!(c && c.id === job.contractId);
    }
    return !!this.demandsOf(st).find(x => x.id === job.ruleId && x.enabled);
  }

  // ================= 在站预留（供 Scheduler 盘点时统一扣除） =================
  reservedAt(st, item) {
    const m = this.reserve.get(this.stationKey(st));
    return m ? (m.get(item) || 0) : 0;
  }

  addReserve(st, item, n) {
    if (n <= 0) return;
    const k = this.stationKey(st);
    let m = this.reserve.get(k);
    if (!m) { m = new Map(); this.reserve.set(k, m); }
    m.set(item, (m.get(item) || 0) + n);
  }

  releaseReserve(st, item, n) {
    const k = this.stationKey(st);
    const m = this.reserve.get(k);
    if (!m) return;
    const v = (m.get(item) || 0) - n;
    if (v <= 0) m.delete(item); else m.set(item, v);
    if (!m.size) this.reserve.delete(k);
  }

  // ================= 库存 / 缺口 / 在途 =================
  /** 车站货位某物品的实物库存 */
  stockOf(st, item) {
    if (!st) return 0;
    let n = 0;
    for (const s of st.chest) if (s.count > 0 && s.type === item) n += s.count;
    return n;
  }

  /**
   * 某需求（站 × 物品）当前在途货量：
   *  - toLoad 任务：仍挂在供货站的预留件 + 任务列车车载（含停靠装货中已上车的件，
   *    以及回程车未卸净的余量）——预留随装货逐 tick 核销转入车载，两者合计不重不漏；
   *  - toDest 任务（含正在需求站停靠卸货）：任务列车车上的该物品。
   */
  enRoute(destKey, item) {
    let n = 0;
    for (const job of this.jobs) {
      if (job.released || job.destKey !== destKey || job.item !== item) continue;
      if (job.phase === 'toLoad') {
        n += job.reserved || 0;
        const tr = this.game.railway.trainById(job.trainId);
        if (tr) n += tr.cargoCount(item);
      } else {
        const tr = this.game.railway.trainById(job.trainId);
        if (tr) n += tr.cargoCount(item);
      }
    }
    return n;
  }

  /** 需求缺口（≥0）：max − 到站库存 − 在途。合同需求以未锁付缺口为上限。 */
  deficit(dest, item, max, isContract) {
    const have = (isContract ? 0 : this.stockOf(dest, item)) + this.enRoute(this.stationKey(dest), item);
    return Math.max(0, max - have);
  }

  /** 供货站可供量：实物库存 − 在站预留（其他派车已预留件） */
  available(src, item) {
    return Math.max(0, this.stockOf(src, item) - this.reservedAt(src, item));
  }

  // ================= 主循环 =================
  /** 列车动作前（railway.tick 之前）：钳制在站装卸上限；周期扫描派车 */
  preTick() {
    if (!this.game.railway) return;
    this.clampLoadStops();
    if (this.enabled && this.game.tickCount % FG.Config.FLEET_SCAN_TICKS === 0) this.scan();
  }

  /** 列车动作后（railway.tick 之后）：任务位置边沿推进 / 预留核销 / 收尾撤单 */
  postTick() {
    if (!this.game.railway) return;
    this.reconcile();
  }

  /** 兼容旧调用：等价于完整一拍（pre + 调用方自行 railway.tick + post；测试直接 tick 时使用） */
  tick() {
    this.preTick();
    this.game.railway.tick();
    this.postTick();
    this.game.contracts && this.game.contracts.tick && this.game.contracts.tick();
  }

  /**
   * 钳制自动任务列车在供/需站的装卸量（railway.tick 前调用）：
   *  - 供货站装货：本趟车载总量不超过「停靠起点车载 + 派车预留」；
   *  - 需求站卸货：只卸到需求上限（库存+本车在途），超缺口部分留车上带回归还/下趟。
   */
  clampLoadStops() {
    const ry = this.game.railway;
    for (const job of this.jobs) {
      if (job.released) continue;
      const tr = ry.trainById(job.trainId);
      const src = ry.stationById(job.srcId) || (job.srcKey ? this.stationByKey(job.srcKey) : null);
      const dest = ry.stationById(job.destId) || this.stationByKey(job.destKey);
      if (!tr || !dest) continue;

      if (job.phase === 'toLoad' && src && tr.x === src.x && tr.y === src.y) {
        if (tr.state === 'docked' && !job.dockSnap) {
          const rem = tr.work && typeof tr.work.rem === 'number' ? tr.work.rem : 0;
          job.dockSnap = { base: tr.cargoCount(job.item), start: Math.max(rem, job.reserved || 0) };
        }
        const loadStop = tr.plan.stops[tr.stopIdx] || tr.plan.stops.find(s => s.stationId === job.srcId);
        if (tr.state === 'docked' && job.dockSnap && loadStop
            && loadStop.action === 'load' && loadStop.fleetJobId === job.id) {
          const targetQty = Math.min(FG.Config.TRAIN_CARGO_CAP, job.dockSnap.base + job.dockSnap.start);
          if (targetQty > 0 && loadStop.count !== targetQty) {
            loadStop.count = targetQty;
            if (tr.work && typeof tr.work.rem === 'number') {
              tr.work.rem = Math.max(0, targetQty - tr.cargoTotal());
            }
          }
        }
      } else if (job.phase === 'toDest' && tr.x === dest.x && tr.y === dest.y) {
        // 停靠/到达需求站的每一拍（含铁路本拍卸货之前）都钳制卸货量：
        // 只卸缺口量，超缺口部分留车上带回（在途不重复计入本站库存）
        if (tr.state === 'docked') {
          let room;
          if (job.kind === 'contract') {
            const c = this.game.contracts && this.game.contracts.contractAt(dest);
            room = c && c.item === job.item ? Math.max(0, c.qty - c.delivered) : 0;
          } else {
            const d = this.demandsOf(dest).find(x => x.id === job.ruleId);
            const max = d ? d.max : 0;
            room = Math.max(0, max - this.stockOf(dest, job.item));
          }
          // 只钳制本次停靠「最多可卸」：缺口为 0 时 rem=0，铁路本拍即结束停靠，
          // 车上余货原样带回（beginDock 的 work 已按 60 初始化，必须在卸货前收紧）
          const targetUnload = Math.min(tr.cargoCount(job.item), room);
          if (tr.work && typeof tr.work.rem === 'number' && tr.work.rem > targetUnload) {
            tr.work.rem = targetUnload;
          }
        }
      }
    }
  }

  /**
   * 任务收尾与状态推进（每 tick，在 railway.tick 之后调用：列车本 tick 的
   * 离站/到站已经落定）。以任务列车相对供/需两站的位置边沿驱动：
   *   离开供货站 → 按实载核销预留，转入 toDest；
   *   离开需求站 → 判定继续循环或撤任务；
   *   到达需求站 → 记录上趟离站时的车载（零交付检测用）。
   */
  reconcile() {
    const ry = this.game.railway;
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      const job = this.jobs[i];
      const tr = ry.trainById(job.trainId);
      const src = ry.stationById(job.srcId) || (job.srcKey ? this.stationByKey(job.srcKey) : null);
      const dest = ry.stationById(job.destId) || this.stationByKey(job.destKey);

      // 列车已不存在（解编）：台账直接出清（车载货物已由解编流程落到地面堆）
      if (!tr || tr._dead) { this.dropJob(job, null); continue; }

      // 玩家接管（计划被手动编辑）或停运：在当前停靠站收尾撤离
      if (tr.plan.paused || !tr._fleetOwned || !tr.plan.stops.some(s => s.fleetJobId === job.id)) {
        this.cancelJob(job, tr, tr.plan.paused ? 'paused' : 'manual');
        continue;
      }
      // 兜底：任务台账已标记 released（cancelJob 已执行过但列车状态没跟上的异常路径），
      // 确保列车回收到空闲态
      if (job.released) {
        tr._fleetOwned = false;
        tr._fleetJobId = null;
        if (tr.plan.stops.some(s => s.fleetJobId === job.id)) {
          tr.plan.stops.length = 0;
          tr.work = null;
          tr.stopIdx = 0;
          if (tr.state === 'docked') {
            tr.clearing = true; tr.leaveCooldown = 2; tr.state = 'idle'; tr.path = null;
            this.game.railway.releaseReservations(tr);
          } else {
            tr.invalidateRoute();
            tr.state = 'idle';
          }
        }
        this.finishJob(job, tr);
        continue;
      }

      // 安全网：异常任务到 TTL 强制清理（货物按需求站拆除流程释放，绝不丢失）
      if (this.game.tickCount - (job.t0 || 0) > FG.Config.FLEET_JOB_TTL) {
        if (!dest) this.releaseJobCargo(job, tr, src);
        this.cancelJob(job, tr, 'ttl');
        continue;
      }

      const wasSrc = job.wasAtSrc || false;
      const wasDest = job.wasAtDest || false;

      // 需求站拆除：在途货物释放（回供货站；供货站也没了落到列车所在格地面堆），列车收队
      if (!dest) {
        this.releaseJobCargo(job, tr, src);
        this.cancelJob(job, tr, 'dest-removed');
        continue;
      }

      // 供货站拆除兜底（onStationRemoved 在行驶状态转换中可能未收干净）：车货保留，收队
      if (!src) {
        this.cancelJob(job, tr, 'source-removed');
        continue;
      }

      const atSrc = tr.x === src.x && tr.y === src.y;
      const atDest = tr.x === dest.x && tr.y === dest.y;

      if (job.phase === 'toLoad') {
        if (atSrc && tr.state === 'docked' && job.dockSnap) {
          // 停靠装货中（锚点由 preTick 的 clampLoadStops 建立）：已装上车的件逐 tick
          // 从在站预留迁入车载（两边都计入在途，合计恒等）
          const loaded = Math.max(0, tr.cargoCount(job.item) - job.dockSnap.base);
          const wantReserve = Math.max(0, job.dockSnap.start - loaded);
          if (wantReserve < (job.reserved || 0)) {
            this.releaseReserve(src, job.item, (job.reserved || 0) - wantReserve);
            job.reserved = wantReserve;
          }
          // 停站动作完成（work.rem 归零：装够/站空/车满，且已到最短停站）即转入在途阶段
          if ((!tr.work || tr.work.rem <= 0) && tr.dwell >= FG.Config.TRAIN_DWELL_MIN) {
            this.finalizeLoad(job, tr, src);
          }
        } else if (atSrc && tr.state === 'docked') {
          // clampLoadStops 未建锚（停靠站不是装货站等罕见情形）：以当前状态为锚迁移
          job.dockSnap = { base: tr.cargoCount(job.item), start: job.reserved || 0 };
        } else if (wasSrc && !atSrc && job.phase === 'toLoad') {
          // 兜底：最长停站超时强制离站等情况下未走停靠完成路径——离站时按实载核销
          this.finalizeLoad(job, tr, src);
        }
      } else {
        // toDest
        if (!wasDest && atDest) {
          // 到达需求站：记录到站车载（零交付检测用）
          job.arrivedWith = tr.cargoCount(job.item);
        }
        if (wasDest && !atDest) {
          // 离开需求站：按交付结果决定回供货站续跑或收尾
          this.onLeftDest(job, tr, src, dest);
        }
        // 到达/停靠供货站（无论离需求站边沿是否抓到）：phase 仍为 toDest 说明
        // 尚未做过续跑/收尾判定，此时按当前缺口重判——缺口已足即收队，避免列车按
        // 循环计划在供货站再次开停装货后才被取消（会多占站台）
        if (job.phase === 'toDest' && atSrc) {
          this.onReachSrcAfterTrip(job, tr, src, dest);
        }
      }

      job.wasAtSrc = atSrc;
      job.wasAtDest = atDest;
    }
  }

  /** 供货站装货落定：释放剩余在站预留（已逐 tick 迁入车载的部分除外），转入在途阶段 */
  finalizeLoad(job, tr, src) {
    const startReserve = job.dockSnap ? job.dockSnap.start : (job.reserved || 0);
    const base = job.dockSnap ? job.dockSnap.base : 0;
    const remaining = job.reserved || 0;
    if (remaining > 0 && src) this.releaseReserve(src, job.item, remaining);
    job.reserved = 0;
    const loaded = tr.cargoCount(job.item) - base;
    if (loaded < startReserve) {
      this.game.logMsg('🚆 ' + tr.id + '：供货站库存不足/被拉走，实装 '
        + loaded + '/' + startReserve + ' 件，余预留已释放', 'info');
    }
    job.dockSnap = null;
    job.phase = 'toDest';
  }

  /** 列车离开需求站后回到供货站（离站边沿丢拍的兜底）：与 onLeftDest 同样的续跑/收尾判定 */
  onReachSrcAfterTrip(job, tr, src, dest) {
    // 不把本车车载计入对该需求站的在途（本车已在供货站，车载是交不出去的余量/待判定），
    // 否则「库存已满 + 整车余量」会被算作覆盖缺口而误续跑
    const delivered = Math.max(0, (job.arrivedWith || 0) - tr.cargoCount(job.item));
    const need = this.netNeed(job, dest);
    if (need > 0 && this.canReload(job, src, delivered)) {
      job.phase = 'toLoad';
      job.arrivedWith = 0;
      job.dockSnap = null;
      const room = FG.Config.TRAIN_CARGO_CAP - tr.cargoTotal();
      const avail = src ? this.available(src, job.item) : 0;
      const n = Math.max(0, Math.min(room, need - tr.cargoCount(job.item), avail));
      if (n >= FG.Config.FLEET_MIN_BATCH && src) {
        this.addReserve(src, job.item, n);
        job.reserved = n;
      }
    } else {
      this.cancelJob(job, tr, 'satisfied');
    }
  }

  /** 剩余净缺口：不统计本任务列车自身的车载（用于回到供货站后的续跑判定） */
  netNeed(job, dest) {
    const others = this.jobs.reduce((n, j2) => {
      if (j2 === job || j2.released || j2.destKey !== job.destKey || j2.item !== job.item) return n;
      if (j2.phase === 'toLoad') return n + (j2.reserved || 0);
      const t2 = this.game.railway.trainById(j2.trainId);
      return n + (t2 ? t2.cargoCount(job.item) : 0);
    }, 0);
    if (job.kind === 'contract') {
      const c = this.game.contracts && this.game.contracts.contractAt(dest);
      return c ? Math.max(0, c.qty - c.delivered - others) : 0;
    }
    const d = this.demandsOf(dest).find(x => x.id === job.ruleId);
    return d ? Math.max(0, d.max - this.stockOf(dest, job.item) - others) : 0;
  }

  /** 列车离开需求站：决定回供货站续跑，还是撤销任务回待命 */
  onLeftDest(job, tr, src, dest) {
    const onboard = tr.cargoCount(job.item);
    const arrivedWith = job.arrivedWith || 0;
    const delivered = Math.max(0, arrivedWith - onboard);
    // 净缺口不含本车车载（已离需求站，余量不应再算本站在途）
    if (this.netNeed(job, dest) > 0 && this.canReload(job, src, delivered)) {
      job.phase = 'toLoad';
      job.arrivedWith = 0;
      job.dockSnap = null;
      // 回程在站预留只登记「车容还能新装的件数」（车上已有余量不重复占站库预留）：
      // min(车容缺口, 可供, 剩余净缺口−本车余量)，避免回程空窗被别的车超派
      const room = FG.Config.TRAIN_CARGO_CAP - tr.cargoTotal();
      const need = Math.max(0, this.netNeed(job, dest) - tr.cargoCount(job.item));
      const avail = this.available(src, job.item);
      const n = Math.min(room, need, avail);
      if (n >= FG.Config.FLEET_MIN_BATCH) {
        this.addReserve(src, job.item, n);
        job.reserved = n;
      }
      return;
    }
    // 缺口已补足 / 需求消失 / 合同结束 / 供货规则撤销 / 源头无料且本趟零交付
    this.cancelJob(job, tr, 'satisfied');
  }

  /** 需求是否仍未满足（返回 false 即收尾） */
  shouldContinue(job, dest) {
    if (job.kind === 'contract') {
      const c = this.game.contracts && this.game.contracts.contractAt(dest);
      if (!c || c.item !== job.item) return false;
      return (c.qty - c.delivered - this.enRoute(job.destKey, job.item)) > 0;
    }
    if (!this.demandAlive(this.game.railway, job)) return false;
    return this.deficit(dest, job.item, this.ruleMax(job, dest), false) > 0;
  }

  /** 回程是否可能再装到货：供货站与供货规则仍在；上趟零交付且源头已无现货则收队空转 */
  canReload(job, src, delivered) {
    if (!src) return false;
    if (!this.suppliesOf(src).some(s => s.enabled && s.item === job.item)) return false;
    if (delivered === 0 && (job.arrivedWith || 0) > 0
        && this.available(src, job.item) < FG.Config.FLEET_MIN_BATCH) {
      return false;
    }
    return true;
  }

  ruleMax(job, dest) {
    const d = this.demandsOf(dest).find(x => x.id === job.ruleId);
    return d ? d.max : 0;
  }

  currentNeed(job, dest) {
    if (job.kind === 'contract') {
      const c = this.game.contracts.contractAt(dest);
      return c ? Math.max(0, c.qty - c.delivered - this.enRoute(job.destKey, job.item)) : 0;
    }
    return this.deficit(dest, job.item, this.ruleMax(job, dest), false);
  }

  /**
   * 撤销任务：释放未上车的在站预留；默认清掉列车的自动计划并回待命。
   * 正停靠站时先驶离站台一格（让出站台），车上余货保留（下次派同类任务优先消化）。
   * opts.keepPlan=true：玩家正在手动编辑计划（detachFleet），只剥离归属/释放预留，
   *   不动列车计划与运行状态——计划已转为手动，列车按玩家编辑后的站点继续行驶。
   */
  cancelJob(job, tr, reason, opts) {
    if (job.released) return; // 已释放：台账清理交给首次调用（finishJob 已在尾部执行）
    job.released = true;
    const ry = this.game.railway;
    const src = ry.stationById(job.srcId) || (job.srcKey ? this.stationByKey(job.srcKey) : null);
    if ((job.reserved || 0) > 0 && src) {
      this.releaseReserve(src, job.item, job.reserved);
      job.reserved = 0;
    }
    const keepPlan = !!(opts && opts.keepPlan);
    // 调用方未传列车（罕见路径）时按 trainId 现查，保证列车状态一定被回收
    if (!tr) tr = this.game.railway.trainById(job.trainId);
    const wasDocked = !!(tr && tr.state === 'docked');
    if (tr && tr._fleetJobId === job.id) tr._fleetJobId = null;
    // 在供货站停靠装货期间被撤销（停运/关闭/接管/TTL）：已从该站装上的货退回站货位，
    // 恢复为自由货物（放不下落到站格地面堆）——任务终止时供需要约一并解除，不把供货站的货带走。
    // 其他时刻撤销（在途/已在需求站卸完离站）：车上余货保留，下次派同类任务优先消化。
    if (tr && !keepPlan && src && tr.x === src.x && tr.y === src.y && job.phase === 'toLoad') {
      const n = tr.cargoCount(job.item);
      if (n > 0) {
        tr.pullFromTrain(job.item, n);
        let left = this.game.tryChestAdd(src, job.item, n);
        if (left > 0) this.game.map.pileAdd(src.x, src.y, job.item, left);
      }
    }
    if (tr && !keepPlan) {
      tr._fleetOwned = false;
      tr.plan.stops.length = 0;
      tr.plan.loop = true;
      tr.work = null;
      tr.dwell = 0;
      tr.stopIdx = 0;
      // 作废旧路径与区间预留（不清 path 的话跨格中的车会按旧路径开到下一站再停靠）
      if (tr.state !== 'docked') tr.invalidateRoute();
      else ry.releaseReservations(tr);
      if (wasDocked) {
        // 占着站台（供/需任意一站）：进入「清道中待命」，下一拍 Train.tick 的清道分支
        // claimToward 驶离本站一格，commitArrival 后转真正待命（docked 早返回不会拦）
        tr.clearing = true;
        tr.leaveCooldown = 2;
        tr.state = 'idle';
      } else {
        tr.clearing = false;
        tr.leaveCooldown = 0;
        tr.state = 'idle';
      }
    } else if (tr) {
      tr._fleetOwned = false; // 手动接管：保留计划/状态，列车按手动计划继续跑
    }
    this.finishJob(job, null);
    if (reason !== 'satisfied') {
      this.game.logMsg('🚆 自动运输任务撤销（' + reasonLabel(reason) + '）：列车 '
        + (tr ? tr.id : job.trainId)
        + (keepPlan ? ' 转为手动计划' : ' 回待命，车上余货保留'), 'info');
    }
  }

  /** 台账出列（不改编列车；调用方负责列车状态） */
  finishJob(job, tr) {
    const i = this.jobs.indexOf(job);
    if (i >= 0) this.jobs.splice(i, 1);
    if (tr && tr._fleetJobId === job.id) { tr._fleetOwned = false; tr._fleetJobId = null; }
    FG.Events.emit('fleet:change');
  }

  /** 在途货物释放（需求站拆除时）：优先送回供货站货位，放不下/供货站已无则落到地面堆 */
  releaseJobCargo(job, tr, src) {
    const n = tr.cargoCount(job.item);
    if (n <= 0) return;
    tr.pullFromTrain(job.item, n);
    let left = n;
    if (src) left = this.game.tryChestAdd(src, job.item, left);
    if (left > 0) this.game.map.pileAdd(tr.x, tr.y, job.item, left);
    if ((job.reserved || 0) > 0 && src) {
      this.releaseReserve(src, job.item, job.reserved);
      job.reserved = 0;
    }
    this.game.logMsg('🚆 需求站已拆除：列车 ' + tr.id + ' 上 ' + n + ' 件'
      + FG.Items.byId(job.item).name + (src ? '已退回供货站货位' : '落到地面堆'), 'info');
  }

  /** 玩家/外部撤销某列车的自动任务（「改为手动」按钮） */
  cancelTrainJob(tr) {
    const job = this.jobOfTrain(tr.id);
    if (job) this.cancelJob(job, tr, 'manual');
  }

  jobOfTrain(trainId) { return this.jobs.find(j => j.trainId === trainId && !j.released) || null; }

  // ================= 派车扫描 =================
  scan() {
    const ry = this.game.railway;
    if (ry.graphDirty) ry.rebuildGraph();

    // ---- 1. 汇总全部有效需求（玩家规则 + 合同虚拟需求） ----
    const demands = [];
    for (const st of ry.stationList()) {
      for (const d of this.demandsOf(st)) {
        if (!d.enabled || !FG.Items.byId(d.item) || FG.Items.isFluid(d.item)) continue;
        const gap = this.deficit(st, d.item, d.max, false);
        if (gap <= 0) continue;
        demands.push({
          kind: 'rule', dest: st, item: d.item, need: gap,
          priority: FG.Config.PRIORITIES[d.priority] || FG.Config.PRIORITIES.normal,
          ruleId: d.id, sortKey: 0,
        });
      }
      // 交付站在执行合同：未锁付缺口自动成为虚拟需求（同站同品的手动规则不重复开单）
      if (st.def.delivery && this.game.contracts) {
        const c = this.game.contracts.contractAt(st);
        if (c) {
          const gap = Math.max(0, c.qty - c.delivered - this.enRoute(this.stationKey(st), c.item));
          if (gap > 0 && !demands.some(x => x.dest === st && x.item === c.item)) {
            // 玩家给该站配了同品需求规则则沿用其优先级，否则按高优先（期限越紧排序越前）
            const rule = this.demandsOf(st).find(d => d.enabled && d.item === c.item);
            const urgency = Math.max(0, 1 - this.game.contracts.remainSec(c) / FG.Config.CONTRACT_MAX_DEADLINE);
            demands.push({
              kind: 'contract', contractId: c.id, dest: st, item: c.item, need: gap,
              priority: rule ? (FG.Config.PRIORITIES[rule.priority] || FG.Config.PRIORITIES.high)
                             : FG.Config.PRIORITIES.high,
              ruleId: rule ? rule.id : null, sortKey: urgency,
            });
          }
        }
      }
    }
    if (!demands.length) return;

    // ---- 2. 优先级分层（高优先一层本扫描派过车，低一层本轮不分配），同级轮转公平 ----
    demands.sort((a, b) => (b.priority - a.priority) || (b.sortKey - a.sortKey));
    const tiers = [3, 2, 1].map(p => demands.filter(d => d.priority === p)).filter(t => t.length);
    let assignedOnTier = false;
    for (const tier of tiers) {
      if (assignedOnTier) break;
      const start = this.demandCursor % tier.length;
      for (let k = 0; k < tier.length; k++) {
        const d = tier[(start + k) % tier.length];
        // 派车前重算缺口（本轮前面的派单可能已补上）
        d.need = d.kind === 'contract'
          ? (() => {
              const c = this.game.contracts.contractAt(d.dest);
              return c ? Math.max(0, c.qty - c.delivered - this.enRoute(this.stationKey(d.dest), c.item)) : 0;
            })()
          : this.deficit(d.dest, d.item, this.ruleMaxOf(d), false);
        if (d.need <= 0) continue;
        if (this.assign(d)) { assignedOnTier = true; this.demandCursor = (start + k + 1) % tier.length; }
      }
    }
  }

  ruleMaxOf(d) {
    const rule = this.demandsOf(d.dest).find(x => x.id === d.ruleId);
    return rule ? rule.max : d.need;
  }

  /**
   * 为一个需求尝试派车：
   *  A) 先消化空闲列车上已有的同品余货（整车且达最小批量）；
   *  B) 否则按供货优先级 + 轮转选「有可供量」的供货站，轮转选空闲空车，
   *     做 列车→供货站→需求站 的双向可达校验（断路未通不派，补轨后下轮自动派）；
   *  登记在站预留并写入两站循环计划（stops 带 fleetJobId），列车下 tick 自动发车。
   */
  assign(d) {
    const cap = FG.Config.TRAIN_CARGO_CAP;
    const idleAll = this.idleTrains();

    // ---- A. 空闲整车上的同品余货：直接派去需求站卸货 ----
    if (idleAll.length) {
      const start = this.trainCursor % idleAll.length;
      for (let k = 0; k < idleAll.length; k++) {
        const tr = idleAll[(start + k) % idleAll.length];
        const onboard = tr.cargoCount(d.item);
        if (onboard < FG.Config.FLEET_MIN_BATCH || tr.cargoTotal() < cap) continue;
        if (!this.reachable(tr.x, tr.y, d.dest.x, d.dest.y, tr.id)) continue;
        this.createJob(tr, null, d, Math.min(onboard, d.need), true);
        this.trainCursor = (start + k + 1) % idleAll.length;
        return true;
      }
    }

    // ---- B. 供货站选择：同品启用、可供量 ≥ 最小批量 ----
    const providers = [];
    for (const st of this.game.railway.stationList()) {
      const sup = this.suppliesOf(st).find(s => s.enabled && s.item === d.item);
      if (!sup || st === d.dest) continue;
      const avail = this.available(st, d.item);
      if (avail < FG.Config.FLEET_MIN_BATCH) continue;
      providers.push({ st, avail, priority: FG.Config.PRIORITIES[sup.priority] || 2 });
    }
    if (!providers.length) return false;
    providers.sort((a, b) => (b.priority - a.priority) || (b.avail - a.avail));
    const pTiers = [3, 2, 1].map(p => providers.filter(x => x.priority === p)).filter(t => t.length);

    const trains = idleAll.filter(tr => {
      // 装货任务：空车可派；车上已有同品余货的空闲车也可派（到供货站补足车容，
      // 余货不浪费、也不占着待命）；载有其他物品的混装车不派
      const other = tr.cargoTotal() - tr.cargoCount(d.item);
      return other === 0;
    });
    if (!trains.length) return false;
    const tStart = this.trainCursor % trains.length;

    for (const tier of pTiers) {
      const pStart = this.supplyCursor % tier.length;
      for (let pk = 0; pk < tier.length; pk++) {
        const prov = tier[(pStart + pk) % tier.length];
        for (let tk = 0; tk < trains.length; tk++) {
          const tr = trains[(tStart + tk) % trains.length];
          if (!this.reachable(tr.x, tr.y, prov.st.x, prov.st.y, tr.id)) continue;
          if (!this.reachable(prov.st.x, prov.st.y, d.dest.x, d.dest.y, tr.id)) continue;
          // 需求量与车容缺口：车上已有同品余量时只需补到车容
          // 整车容量缺口（混装余量也占车容，用 cargoTotal）：车上已有同品余货时只补新车
          const onboardItem = tr.cargoCount(d.item);
          const room = cap - tr.cargoTotal();
          const newQty = Math.min(room, prov.avail, d.need);
          const qty = newQty + onboardItem;
          if (newQty < FG.Config.FLEET_MIN_BATCH && onboardItem === 0) continue;
          if (qty < FG.Config.FLEET_MIN_BATCH) continue;
          // 在站预留只登记本趟将新装上的件数（车上余货已在途，不重复扣站库）
          this.createJob(tr, prov.st, d, qty, false, newQty);
          if (newQty > 0) this.addReserve(prov.st, d.item, newQty);
          this.trainCursor = (tStart + tk + 1) % trains.length;
          this.supplyCursor = (pStart + pk + 1) % tier.length;
          return true;
        }
      }
    }
    return false;
  }

  /** 可被自动派车的列车：无手动计划、未停运、未承载任务（待命或无计划行驶中） */
  idleTrains() {
    return this.game.railway.trains.filter(tr =>
      !tr._dead && !tr.plan.paused && !tr._fleetOwned
      && (!tr.plan.stops || tr.plan.stops.length === 0)
      && tr.state !== 'paused' && tr.state !== 'docked');
  }

  reachable(sx, sy, tx, ty, selfId) {
    if (sx === tx && sy === ty) return true;
    return !!this.game.railway.findRoute(sx, sy, tx, ty, selfId);
  }

  /** 建立任务并把两站循环计划写入列车（stops 带 fleetJobId 标记，随列车存档）。
   *  reserveN：本趟在供货站新登记的在站预留（车上已有同品余货时可小于 qty）。 */
  createJob(tr, src, d, qty, directOnly, reserveN) {
    const reserved = directOnly ? 0 : (reserveN !== undefined ? reserveN : qty);
    const job = {
      id: 'J' + (this.seq++),
      trainId: tr.id,
      kind: d.kind,                       // 'rule' | 'contract'
      ruleId: d.ruleId || null,
      contractId: d.contractId || null,
      item: d.item,
      srcId: src ? src.stationId : null,
      srcKey: src ? this.stationKey(src) : null,
      srcName: src ? src.stationName : null,
      destId: d.dest.stationId,
      destKey: this.stationKey(d.dest),
      destName: d.dest.stationName,
      phase: directOnly ? 'toDest' : 'toLoad',
      reserved,
      qty,
      t0: this.game.tickCount,
      released: false,
      wasAtSrc: false, wasAtDest: false, arrivedWith: 0, dockSnap: null,
    };
    this.jobs.push(job);
    tr._fleetOwned = true;
    tr._fleetJobId = job.id;
    tr.plan.stops.length = 0;
    tr.plan.loop = true;
    tr.stopIdx = 0;
    if (src) {
      tr.plan.stops.push({
        stationId: src.stationId, action: 'load', item: d.item,
        count: FG.Config.TRAIN_CARGO_CAP, fleetJobId: job.id,
      });
    }
    tr.plan.stops.push({
      stationId: d.dest.stationId, action: 'unload', item: d.item,
      count: FG.Config.TRAIN_CARGO_CAP, fleetJobId: job.id,
    });
    tr.clearing = false;
    tr.leaveCooldown = 0;
    tr.work = null;
    tr.dwell = 0;
    // 已停在供货站格则下 tick 直接开停；否则作废待命路径，按新计划寻路
    if (tr.state !== 'docked') tr.invalidateRoute();
    if (tr.state === 'idle') tr.state = 'moving';
    const srcTxt = src
      ? '「' + src.stationName + '」装 ' + FG.Items.byId(d.item).name + '×' + qty + ' → '
      : '车上余货 ' + FG.Items.byId(d.item).name + '×' + qty + ' → ';
    this.game.logMsg('🚆 自动派车：' + tr.id + ' ' + srcTxt + '「' + d.dest.stationName + '」'
      + (d.kind === 'contract' ? '（合同缺口）' : '（库存低于下限）'), 'info');
    FG.Events.emit('fleet:change');
  }

  // ================= 拆站联动 =================
  /**
   * 车站被拆除（在 game.removeBuilding 物料落地流程之前调用）：
   *  - 删除其全部需求/供货规则；
   *  - 以其为需求站的任务：下一次 reconcile 按 dest 缺失把在途货退回供货站；
   *  - 以其为供货站的任务：在站预留核销（实物随车站 chest 拆除统一落地，不重复），
   *    已上车的货留在车上，列车撤任务回待命（车不可能占用被拆格）；
   *  - 清掉本站的在站预留台账。
   */
  onStationRemoved(st) {
    if (!st || !st.def || !st.def.railStation) return;
    const k = this.stationKey(st);
    if (st.fleetDemands) st.fleetDemands.length = 0;
    if (st.fleetSupplies) st.fleetSupplies.length = 0;
    for (const job of this.jobs.slice()) {
      if (job.srcKey !== k) continue;
      const tr = this.game.railway.trainById(job.trainId);
      job.reserved = 0; // 预留对应的实物随 chest 物料落地，台账只核销
      if (tr && tr._fleetJobId === job.id) {
        tr._fleetOwned = false;
        tr._fleetJobId = null;
        tr.plan.stops.length = 0;
        tr.plan.loop = true;
        tr.work = null;
        tr.stopIdx = 0;
        if (tr.state === 'docked') {
          tr.clearing = true;
          tr.leaveCooldown = 2;
          tr.state = 'idle';
          tr.path = null;
          this.game.railway.releaseReservations(tr);
        } else {
          tr.state = 'idle';
          tr.path = null;
          this.game.railway.releaseReservations(tr);
        }
        this.game.logMsg('🚆 供货站已拆除：列车 ' + tr.id + ' 撤任务回待命，车上货物保留', 'info');
      }
      this.finishJob(job, tr);
    }
    this.reserve.delete(k);
    FG.Events.emit('fleet:change');
  }

  stationByKey(k) {
    const [x, y] = k.split(',').map(Number);
    const b = this.game.map.buildingAt(x, y);
    return b && b.def.railStation ? b : null;
  }

  // ================= 存档 =================
  serialize() {
    return {
      enabled: this.enabled,
      seq: this.seq,
      demandCursor: this.demandCursor,
      supplyCursor: this.supplyCursor,
      trainCursor: this.trainCursor,
      reserve: Array.from(this.reserve.entries()).map(([k, m]) => [k, Array.from(m.entries())]),
      jobs: this.jobs.map(j => ({
        id: j.id, trainId: j.trainId, kind: j.kind,
        ruleId: j.ruleId || null, contractId: j.contractId || null,
        item: j.item,
        srcId: j.srcId || null, srcKey: j.srcKey || null, srcName: j.srcName || null,
        destId: j.destId, destKey: j.destKey, destName: j.destName || null,
        phase: j.phase, reserved: j.reserved || 0, qty: j.qty || 0,
        t0: j.t0 || 0, arrivedWith: j.arrivedWith || 0,
      })),
    };
  }

  deserialize(data) {
    this.reset();
    if (!data) return;
    this.enabled = data.enabled !== false;
    this.seq = data.seq || 1;
    this.demandCursor = data.demandCursor || 0;
    this.supplyCursor = data.supplyCursor || 0;
    this.trainCursor = data.trainCursor || 0;
    for (const [k, entries] of (data.reserve || [])) {
      const m = new Map();
      for (const [item, n] of entries) if (FG.Items.byId(item) && n > 0) m.set(item, n);
      if (m.size) this.reserve.set(k, m);
    }
    const ry = this.game.railway;
    for (const sj of (data.jobs || [])) {
      if (!FG.Items.byId(sj.item) || !sj.trainId) continue;
      const tr = ry.trainById(sj.trainId);
      // 列车已不存在：台账丢弃（其在站预留下方按恢复任务统一核账，无主预留释放为可见货）
      if (!tr) continue;
      // 仅当列车计划里确实带着本任务的停靠站时才追认归属（旧手动计划不追认）
      const owned = tr.plan.stops.some(s => s.fleetJobId === sj.id);
      if (!owned) continue;
      const atSrc = !!(sj.srcKey && FG.Utils.key(tr.x, tr.y) === sj.srcKey);
      const atDest = FG.Utils.key(tr.x, tr.y) === sj.destKey;
      this.jobs.push({
        id: sj.id || ('J' + (this.seq++)), trainId: sj.trainId,
        kind: sj.kind === 'contract' ? 'contract' : 'rule',
        ruleId: sj.ruleId || null, contractId: sj.contractId || null,
        item: sj.item,
        srcId: sj.srcId || null, srcKey: sj.srcKey || null, srcName: sj.srcName || null,
        destId: sj.destId, destKey: sj.destKey, destName: sj.destName || null,
        phase: sj.phase === 'toLoad' ? 'toLoad' : 'toDest',
        reserved: sj.reserved || 0, qty: sj.qty || 0,
        t0: sj.t0 || 0, released: false,
        // 边沿标志从「不在任何一站」起步：读档首 tick 列车若已在供/需站，
        // 会先走一次到达边沿、离站时再正确触发离站边沿（否则停靠中的车离站
        // 事件会被旧标志吞掉，导致任务永远等不到阶段推进）
        wasAtSrc: false, wasAtDest: false,
        arrivedWith: sj.phase === 'toDest' && atDest ? (sj.arrivedWith || 0) : 0,
      });
      tr._fleetOwned = true;
      tr._fleetJobId = sj.id;
    }
    // 核账在站预留：仅保留恢复任务 toLoad 引用、且不超过站库实物的部分，其余释放（可见性恢复）
    for (const [k, m] of Array.from(this.reserve)) {
      const st = this.stationByKey(k);
      for (const [item, n] of Array.from(m)) {
        let want = 0;
        for (const job of this.jobs) {
          if (job.phase === 'toLoad' && job.srcKey === k && job.item === item) want += job.reserved || 0;
        }
        const keep = Math.max(0, Math.min(want, n, this.stockOf(st, item)));
        if (keep <= 0) m.delete(item);
        else if (keep !== n) m.set(item, keep);
      }
      if (!m.size) this.reserve.delete(k);
    }
    // 任务预留与核账后保留值对齐（异常档保守收缩）
    for (const job of this.jobs) {
      if (job.phase !== 'toLoad' || !(job.reserved > 0)) continue;
      const kept = this.stationByKey(job.srcKey) ? this.reserve.get(job.srcKey) : null;
      if (!kept) job.reserved = 0;
    }
    if (!this.enabled) {
      for (const job of this.jobs.slice()) {
        const tr = ry.trainById(job.trainId);
        if (tr) this.cancelJob(job, tr, 'disabled');
      }
    }
  }
};

// ================= 辅助 =================
function clampLimit(v, min) {
  const max = FG.Config.STATION_SLOTS * FG.Config.STATION_SLOT_CAP;
  return Math.max(min | 0, Math.min(max, v | 0));
}

function reasonLabel(r) {
  return ({
    disabled: '已关闭按需运输', manual: '玩家接管列车', paused: '列车停运',
    'supply-removed': '供货规则撤销', ttl: '任务超时', satisfied: '缺口已补足',
    'dest-full': '需求站库满', 'dest-removed': '需求站拆除', 'source-removed': '供货站拆除',
  })[r] || r;
}
