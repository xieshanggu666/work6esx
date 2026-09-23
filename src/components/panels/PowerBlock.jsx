/**
 * 电力区块（建筑详情内嵌）：
 *  - 燃煤发电机：发电功率、燃料槽、燃料投入提示
 *  - 蓄电池：电量/容量、充放状态
 *  - 用电设备：接入电网、功率、当前供/断电状态、保供优先级（科研实验室固定最末）
 *  - 输电线路：所在电网概览
 */
import { FG } from '../../engine';
import { Section, InfoGrid, ProgressBar, SlotRow } from './ui.jsx';

function fmtKw(kw) {
  if (kw >= 1000) return (kw / 1000).toFixed(2) + ' MW';
  return Math.round(kw) + ' kW';
}

export default function PowerBlock({ game, b }) {
  const pw = game.power;
  if (!pw || !pw.enabled) return null;
  const def = b.def;

  // ---- 燃煤发电机 ----
  if (def.powerGen) {
    const net = b.net;
    return (
      <Section title="⚡ 燃煤发电机">
        <InfoGrid rows={[
          ['额定功率', fmtKw(FG.Config.GEN_POWER_KW)],
          ['当前发电', <b style={{ color: b.genOutput > 0.01 ? '#e8c84f' : 'var(--text-dim)' }}>
            {fmtKw(b.genOutput || 0)}
          </b>],
          ['燃料', b.fuel && b.fuel.count > 0 ? `煤炭 ×${b.fuel.count}/${b.fuel.cap}` : '无（停机）'],
          ['电网', net ? `已接入（${net.id}）` : '未接线'],
        ]} />
        {b.fuel && <SlotRow name="燃料槽 煤炭" count={b.fuel.count} cap={b.fuel.cap} />}
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6, lineHeight: 1.5 }}>
          用机械臂或传送带把煤炭送入本机（带端直送）；发电量随电网需求调节，不满载不浪费煤。
          {!net && ' ⚠ 附近 2 格内没有输电线路，无法向电网供电。'}
        </div>
      </Section>
    );
  }

  // ---- 输电线路 ----
  if (def.powerPole) {
    const net = b.net;
    return (
      <Section title="⚡ 输电线路">
        <InfoGrid rows={[
          ['接线距离', `${FG.Config.POLE_REACH} 格（自动接线）`],
          ['电网', net ? net.id : '孤立线路'],
        ]} />
        {net && <NetGrid net={net} />}
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6, lineHeight: 1.5 }}>
          同范围内的发电机、用电设备与蓄电池自动并入本电网；线路不连续即为不同电网。
        </div>
      </Section>
    );
  }

  // ---- 蓄电池 ----
  if (def.powerStorage) {
    const net = b.net;
    const ratio = (b.accCharge || 0) / FG.Config.ACC_CAPACITY_KJ;
    return (
      <Section title="⚡ 蓄电池">
        <ProgressBar pct={ratio} color={ratio > 0.3 ? '#5fd98a' : '#e8a33d'} />
        <InfoGrid rows={[
          ['电量', `${Math.round(b.accCharge || 0)} / ${FG.Config.ACC_CAPACITY_KJ} kJ`],
          ['充放功率', fmtKw(FG.Config.ACC_RATE_KW)],
          ['电网', net ? `已接入（${net.id}）` : '未接线（不充放）'],
        ]} />
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6, lineHeight: 1.5 }}>
          电力富余时充电，缺电时优先于切负荷放电；电量随存档保存，读档后续用。
        </div>
      </Section>
    );
  }

  // ---- 用电设备 ----
  const kw = FG.Config.POWER_USE[b.type];
  if (kw === undefined) return null;
  const net = b.net;
  const isLab = b.type === 'lab';
  return (
    <Section title="⚡ 用电">
      <InfoGrid rows={[
        ['功率', fmtKw(kw)],
        ['电网', net ? `已接入（${net.id}）` : '未接线'],
        ['供电', b.powered
          ? <span style={{ color: '#58c26f' }}>正常</span>
          : <span style={{ color: '#e8a33d' }}>{net ? '缺电轮停（保供优先级不足）' : '未接电网'}</span>],
        ...(isLab ? [['保供层级', '科研（最末档）']] : []),
      ]} />
      {net && <NetGrid net={net} compact />}
    </Section>
  );
}

function NetGrid({ net, compact }) {
  return (
    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6, lineHeight: 1.7 }}>
      <div>本网用电 <b style={{ color: 'var(--text)' }}>{Math.round(net.supplied)}</b>
        / {Math.round(net.demand)} kW · 发电 {Math.round(net.genKw)} kW
        {net.accDischargeKw > 0.1 ? ` · 电池放 ${Math.round(net.accDischargeKw)} kW` : ''}
        {net.accChargeKw > 0.1 ? ` · 电池充 ${Math.round(net.accChargeKw)} kW` : ''}
      </div>
      {net.deficit > 0.1 && (
        <div style={{ color: '#e8a33d' }}>⚠ 缺口 {Math.round(net.deficit)} kW：已按优先级轮停低层级设备</div>
      )}
      {!compact && (
        <div>发电机 {net.gens.length} · 用电设备 {net.loads.length} · 蓄电池 {net.accs.length}</div>
      )}
    </div>
  );
}
