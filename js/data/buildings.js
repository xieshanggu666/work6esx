/**
 * FG.Buildings —— 建筑定义注册表
 * 扩展方式：添加新条目即可；渲染图标在 renderer.js 的 drawBuilding 中按 type 分支
 */
FG.Buildings = (() => {
  const DEFS = {
    // ================= 采集 =================
    miner: {
      id: 'miner', name: '矿机', cat: 'extraction',
      desc: '放置在矿石矿脉上，自动采集对应矿石。需要机械臂取走产出。需要电力。',
      cost: { ironPlate: 3, gear: 1 },   // 蓝图施工建材
      unlockedBy: null, onTerrain: 'ore', powerUse: 300,
    },
    pump: {
      id: 'pump', name: '水泵', cat: 'extraction',
      desc: '放置在水域旁，将水抽入管道网络。需要电力。',
      cost: { ironPlate: 2, gear: 1 },   // 蓝图施工建材
      unlockedBy: null, onTerrain: 'water', fluid: true, fluidRate: 6, powerUse: 200,
    },
    pumpjack: {
      id: 'pumpjack', name: '抽油机', cat: 'extraction',
      desc: '放置在油田上，抽取原油到管道网络。需要电力。',
      cost: { steelPlate: 4, gear: 2, ironBeam: 2 },   // 蓝图施工建材
      unlockedBy: 'oilProcessing', onTerrain: 'oil', fluid: true, fluidRate: 4, powerUse: 450,
    },

    // ================= 生产 =================
    furnace: {
      id: 'furnace', name: '石炉', cat: 'production',
      desc: '冶炼矿石为金属板。可切换配方。需要电力。',
      cost: { stone: 5 },   // 蓝图施工建材
      unlockedBy: null, recipeBuilding: true, craftSpeed: 1, powerUse: 180,
    },
    steelFurnace: {
      id: 'steelFurnace', name: '钢炉', cat: 'production',
      desc: '冶炼速度 2 倍的高级电炉。',
      cost: { stone: 6, steelPlate: 4 },   // 蓝图施工建材
      unlockedBy: 'steelSmelting', recipeBuilding: true, recipeGroup: 'furnace', craftSpeed: 2, powerUse: 320,
    },
    assembler: {
      id: 'assembler', name: '组装机', cat: 'production',
      desc: '将零件组装为更高级的物品。可切换配方。需要电力。',
      cost: { ironPlate: 4, gear: 2 },   // 蓝图施工建材
      unlockedBy: null, recipeBuilding: true, craftSpeed: 1, powerUse: 250,
    },
    assembler2: {
      id: 'assembler2', name: '二级组装机', cat: 'production',
      desc: '组装速度 2 倍。',
      cost: { steelPlate: 3, gear: 2, circuit: 2 },   // 蓝图施工建材
      unlockedBy: 'advancedElectronics', recipeBuilding: true, recipeGroup: 'assembler', craftSpeed: 2, powerUse: 450,
    },
    chemPlant: {
      id: 'chemPlant', name: '化工厂', cat: 'production',
      desc: '处理含流体的复杂配方（固体+流体）。需要电力。',
      cost: { steelPlate: 3, circuit: 2, ironBeam: 2 },   // 蓝图施工建材
      unlockedBy: 'chemicalScience', recipeBuilding: true, craftSpeed: 1, fluid: true, powerUse: 400,
    },
    refinery: {
      id: 'refinery', name: '炼油厂', cat: 'production',
      desc: '将原油+水裂解为石油气与润滑油。需要电力。',
      cost: { steelPlate: 5, ironBeam: 3 },   // 蓝图施工建材
      unlockedBy: 'oilProcessing', recipeBuilding: true, craftSpeed: 1, fluid: true, powerUse: 550,
    },

    // ================= 科研 =================
    lab: {
      id: 'lab', name: '实验室', cat: 'science',
      desc: '消耗科学包为当前研究提供点数。需要电力。',
      cost: { ironPlate: 4, circuit: 1 },   // 蓝图施工建材
      unlockedBy: null, science: true, powerUse: 200,
    },

    // ================= 物流 =================
    belt: {
      id: 'belt', name: '传送带', cat: 'logistics',
      desc: '沿箭头方向运输物品。按住拖动可拉出直线并自动定向。',
      cost: { ironPlate: 1 },   // 蓝图施工建材
      unlockedBy: null, beltTier: 0, beltSpeed: 0.125,
    },
    fastBelt: {
      id: 'fastBelt', name: '快速传送带', cat: 'logistics',
      desc: '速度 2 倍的传送带。',
      cost: { ironPlate: 1, gear: 1 },   // 蓝图施工建材
      unlockedBy: 'logistics2', beltTier: 1, beltSpeed: 0.25,
    },
    expressBelt: {
      id: 'expressBelt', name: '极速传送带', cat: 'logistics',
      desc: '速度 3 倍的传送带。',
      cost: { steelPlate: 1, gear: 1 },   // 蓝图施工建材
      unlockedBy: 'logistics3', beltTier: 2, beltSpeed: 0.375,
    },
    inserter: {
      id: 'inserter', name: '机械臂', cat: 'logistics',
      desc: '从身后一格抓取物品放入前方一格。R 旋转。需要电力。',
      cost: { ironPlate: 1, gear: 1 },   // 蓝图施工建材
      unlockedBy: null, inserterTier: 0, swingTime: 10, range: 1, powerUse: 50,
    },
    fastInserter: {
      id: 'fastInserter', name: '快速机械臂', cat: 'logistics',
      desc: '动作更快的机械臂。',
      cost: { ironPlate: 1, circuit: 1 },   // 蓝图施工建材
      unlockedBy: 'logistics2', inserterTier: 1, swingTime: 6, range: 1, powerUse: 70,
    },
    longInserter: {
      id: 'longInserter', name: '长臂机械臂', cat: 'logistics',
      desc: '可从 2 格外抓取/放置物品。',
      cost: { ironPlate: 2, gear: 1 },   // 蓝图施工建材
      unlockedBy: 'logistics2', inserterTier: 2, swingTime: 10, range: 2, powerUse: 60,
    },
    pipe: {
      id: 'pipe', name: '管道', cat: 'logistics',
      desc: '输送流体。连接产液与用液建筑。',
      cost: { ironPlate: 1 },   // 蓝图施工建材
      unlockedBy: null, fluid: true,
    },
    chest: {
      id: 'chest', name: '箱子', cat: 'logistics',
      desc: '4 格存储，每格 1000。缓冲与终端存储。',
      cost: { ironPlate: 2 },   // 蓝图施工建材
      unlockedBy: null, storage: true,
    },

    // ================= 铁路 =================
    rail: {
      id: 'rail', name: '轨道', cat: 'logistics',
      desc: '列车行驶的轨道。按住左键拖拽可连续铺设；线路可交叉，列车按区间占用依次通过。',
      cost: { ironPlate: 1 },   // 蓝图施工建材
      unlockedBy: 'railTransport', railTier: 0,
    },
    station: {
      id: 'station', name: '火车站', cat: 'logistics',
      desc: '建在轨道旁（至少一侧接轨）：列车按运输计划停靠装卸。货位与箱子相同，机械臂可直接与周围产线/传送带转运。',
      cost: { ironPlate: 6, gear: 4 },   // 蓝图施工建材
      unlockedBy: 'railTransport', storage: true, railStation: true,
    },
    trainDepot: {
      id: 'trainDepot', name: '机务段', cat: 'logistics',
      desc: '建在轨道旁，用于编组与派遣列车。选中后可向相邻轨道发车，并编辑该车的运输计划（站点与装卸规则）。',
      cost: { ironPlate: 8, gear: 4, ironBeam: 2 },   // 蓝图施工建材
      unlockedBy: 'railTransport', railDepot: true,
    },
    deliveryStation: {
      id: 'deliveryStation', name: '交付站', cat: 'logistics',
      desc: '建在轨道旁（至少一侧接轨）：承接对外供货合同。列车卸入的合同货物被锁付并独立记账（生产/施工不可动用），分批交齐后发放科研物资；逾期或取消合同时释放全部锁付货物。',
      cost: { ironPlate: 10, gear: 6, circuit: 4 },   // 蓝图施工建材
      unlockedBy: 'supplyContract', storage: true, railStation: true, delivery: true,
    },

    // ================= 电力 =================
    coalPlant: {
      id: 'coalPlant', name: '燃煤发电机', cat: 'power',
      desc: '燃烧煤炭发电（1500kW，每件煤发电 1500kJ）。相邻箱子/地面堆的煤炭可自动补入；传送带可直接卸入，机械臂也可加煤。',
      cost: { ironPlate: 6, gear: 3 },   // 蓝图施工建材
      unlockedBy: 'electricPower', powerGen: true,
    },
    powerPole: {
      id: 'powerPole', name: '电线杆', cat: 'power',
      desc: '架空输电线：5 格内的电线杆互连组成电网，并为周围 2 格内的建筑供电。',
      cost: { ironPlate: 1 },   // 蓝图施工建材
      unlockedBy: 'electricPower', powerPole: true,
    },
    accumulator: {
      id: 'accumulator', name: '蓄电池', cat: 'power',
      desc: '电网富余电力时充电（300kW，容量 3000kJ），缺电时放电补峰。充能状态随存档保存。',
      cost: { ironPlate: 2, circuit: 2 },   // 蓝图施工建材
      unlockedBy: 'electricPower', accumulator: true,
    },
  };

  const byId = (id) => DEFS[id];
  // 建筑施工耗材（蓝图施工计划从物流预留并消耗）
  const costOf = (id) => (DEFS[id] && DEFS[id].cost) || {};
  const list = () => Object.values(DEFS);
  const byCat = (cat) => Object.values(DEFS).filter(b => b.cat === cat);

  /**
   * 原地升级链：低级建筑 → 可替换的高级建筑（同格替换，保留配方/库存/在途物料）。
   * 仅收录「同格同向、功能直线增强」的型号；长臂机械臂（range 2）属旁系不在链上。
   */
  const UPGRADE_CHAIN = {
    furnace: ['steelFurnace'],
    assembler: ['assembler2'],
    belt: ['fastBelt', 'expressBelt'],
    fastBelt: ['expressBelt'],
    inserter: ['fastInserter'],
  };

  /** 该建筑已解锁的最高级替换型号（无链或高级型号未解锁时返回 null） */
  const upgradeTarget = (id, isUnlocked) => {
    const chain = UPGRADE_CHAIN[id];
    if (!chain) return null;
    let best = null;
    for (const t of chain) if (isUnlocked(t)) best = t;
    return best;
  };

  const CATS = [
    { id: 'extraction', name: '采集' },
    { id: 'production', name: '生产' },
    { id: 'logistics',  name: '物流' },
    { id: 'power',      name: '电力' },
    { id: 'science',    name: '科研' },
  ];

  return { DEFS, byId, costOf, list, byCat, CATS, UPGRADE_CHAIN, upgradeTarget };
})();
