/**
 * 电力信息块（建筑详情内嵌）：
 *  - 用电建筑：供电状态 / 额定功率 / 本 tick 供电比例 / 保供优先级选择
 *  - 燃煤发电机：燃料缓存 / 出力 / 供煤方式
 *  - 蓄电池：储能 / 充放功率
 *  - 电线杆：电网汇总（需求 / 发电 / 充放电 / 未供电建筑数）
 */
import { FG } from '../../engine';
import { useEventVersion } from '../../hooks';
import { Section, InfoGrid, ProgressBar, PRIO_OPTS } from './ui.jsx';

const PRIO_TIPS = {
  high: '高优先：电网电力不足时优先保供',
  normal: '普通：同级轮转公平供电',
  low: '低优先：电力紧张时最先暂停',
};

const fmtKw = (kw) => kw >= 100 ? kw.toFixed(0) + ' kW' : kw.toFixed(1) + ' kW';

export default function PowerBlock({ game, b }) {
  // 状态随 tick 刷新（SidePanel 已节流 150ms；保供操作事件即时刷）
  useEventVersion(['power:change', 'selection:change']);
  const power = game.power;
  if (!power || !power.enabled) {
    return (
      <Section title="电力">
        <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
          尚未研究「电力工程」科技：当前全部建筑免电运行。研究后需要用电线杆把
          燃煤发电机与工厂连成电网。
        </div>
      </Section>
    );
  }
  const def = b.def;

  // ---------------- 用电建筑 ----------------
  if (power.isConsumer(b)) {
    const grid = power.gridOfConsumer(b);
    const ratio = power.powerRatio(b);
    const powered = power.isPowered(b);
    return (
      <Section title="电力">
        <InfoGrid rows={[
          ['状态', powered ? (ratio >= 0.999 ? '供电中' : `降速 ${(ratio * 100).toFixed(0)}%`) : '缺电暂停',
            powered ? 'status-working' : 'status-broken'],
          ['额定功率', fmtKw(def.powerUse)],
          ['所在电网', grid ? grid.id : '未联网（缺电）'],
        ]} />
        <div style={{ fontSize: 11, color: 'var(--text-dim)', margin: '6px 0 2px' }}>保供优先级</div>
        <div className="prio-row">
          {PRIO_OPTS.map(([id, name]) => {
            const cur = FG.Power.priorityOf(b);
            return (
              <button
                key={id}
                className={'prio-btn prio-' + id + (cur === id ? ' active' : '')}
                title={PRIO_TIPS[id]}
                onClick={() => { b.powerPriority = id; FG.Events.emit('selection:change', b); }}
              >{name}</button>
            );
          })}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4, lineHeight: 1.5 }}>
          电网缺电时按「高 → 中 → 低」逐层供电，本层未补足前低优先级暂停；同优先级轮转公平。
          停电期间生产进度与机械臂手持物保留，复电后续作。
        </div>
      </Section>
    );
  }

  // ---------------- 燃煤发电机 ----------------
  if (def.powerGen) {
    const grid = power.gridAt(b);
    const st = grid ? grid.stats : null;
    const fuelRatio = Math.min(1, (b.fuel || 0) / FG.Config.POWER_GEN_FUEL_CAP);
    return (
      <Section title="燃煤发电机">
        <InfoGrid rows={[
          ['状态', b.status === 'working' ? '发电中' : b.status === 'starving' ? '缺煤停机' : '待机',
            b.status === 'working' ? 'status-working' : b.status === 'starving' ? 'status-broken' : ''],
          ['额定出力', fmtKw(FG.Config.POWER_GEN_KW)],
          ['当前出力', st && grid ? fmtKw(st.genKw / Math.max(1, grid.gens.length)) : '0 kW'],
          ['燃料缓存', `${(b.fuel || 0).toFixed(0)}/${FG.Config.POWER_GEN_FUEL_CAP} kJ` +
            `（约 ${((b.fuel || 0) / FG.Config.POWER_COAL_KJ).toFixed(1)} 件煤）`],
          ['所在电网', grid ? grid.id : '未联网'],
        ]} />
        <ProgressBar pct={fuelRatio} color="#e8b33d" />
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6, lineHeight: 1.5 }}>
          每件煤发电 {FG.Config.POWER_COAL_KJ} kJ。传送带可直接卸入煤炭、机械臂可加煤；
          发电机也会自动从相邻箱子/地面堆补煤（每 tick 至多 {FG.Config.POWER_GEN_SELFFEED} 件，免电启动）。
        </div>
      </Section>
    );
  }

  // ---------------- 蓄电池 ----------------
  if (def.accumulator) {
    const grid = power.gridAt(b);
    const ratio = Math.min(1, (b.accCharge || 0) / FG.Config.ACC_CAP_KJ);
    const w = b._accW || 0;
    return (
      <Section title="蓄电池">
        <InfoGrid rows={[
          ['储能', `${(b.accCharge || 0).toFixed(0)}/${FG.Config.ACC_CAP_KJ} kJ`],
          ['充/放电', w > 0.5 ? `充电 ${fmtKw(w)}` : w < -0.5 ? `放电 ${fmtKw(-w)}` : '静置'],
          ['功率上限', `${fmtKw(FG.Config.ACC_CHARGE_KW)} 充 / ${fmtKw(FG.Config.ACC_DISCHARGE_KW)} 放`],
          ['所在电网', grid ? grid.id : '未联网（不参与调峰）'],
        ]} />
        <ProgressBar pct={ratio} color="#5fc8e8" />
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6, lineHeight: 1.5 }}>
          电网富余发电能力时充电；任何保供层供电不足时放电补峰。储能状态随存档保存。
        </div>
      </Section>
    );
  }

  // ---------------- 电线杆 ----------------
  if (def.powerPole) {
    const grid = power.gridAt(b);
    const st = grid ? grid.stats : null;
    if (!grid) {
      return (
        <Section title="电线杆">
          <InfoGrid rows={[['电网', '孤立（未与其他杆/发电机连接）']]} />
        </Section>
      );
    }
    return (
      <Section title={`电网 ${grid.id}`}>
        <InfoGrid rows={[
          ['当前负荷', fmtKw(st.demandKw)],
          ['满负荷需求', fmtKw(st.activeDemandKw)],
          ['发电出力', fmtKw(st.genKw)],
          ['可用装机', fmtKw(st.genCapKw)],
          ['蓄电池充电', fmtKw(st.chargeKw)],
          ['蓄电池放电', fmtKw(st.dischargeKw)],
          ['供电建筑', `${st.consumers - st.unpowered}/${st.consumers}`],
        ]} />
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6, lineHeight: 1.5 }}>
          电线杆 {FG.Config.POLE_WIRE_REACH} 格内互连，供电半径 {FG.Config.POLE_REACH} 格。
          {st.unpowered > 0 && <b style={{ color: '#e07a7a' }}> 当前有 {st.unpowered} 栋建筑缺电暂停。</b>}
        </div>
      </Section>
    );
  }

  return null;
}
