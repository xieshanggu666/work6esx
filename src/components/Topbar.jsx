/**
 * 顶栏：时间 / 速度 / 暂停 / 研究进度 / 蓝图·升级·流水线入口
 */
import { FG } from '../engine';
import { useEventVersion, useTickThrottle } from '../hooks';
import { useModal } from './ModalContext.jsx';

export default function Topbar({ game, onOpenTech }) {
  const modal = useModal();
  // 200ms 节流刷新时间与研究进度条
  useTickThrottle(200);
  useEventVersion(['speed:change', 'pause:change', 'game:start',
    'research:start', 'research:complete', 'research:cancel',
    'blueprint:mode', 'upgrade:mode']);

  const mgr = game.research;
  const current = mgr && mgr.current;
  const powerOn = !!(game.power && game.power.enabled);
  let powerSummary = null;
  if (powerOn) {
    let demand = 0, gen = 0, charge = 0, discharge = 0, unpowered = 0, consumers = 0;
    for (const g of game.power.grids) {
      demand += g.stats.demandKw; gen += g.stats.genKw;
      charge += g.stats.chargeKw; discharge += g.stats.dischargeKw;
      unpowered += g.stats.unpowered; consumers += g.stats.consumers;
    }
    powerSummary = { demand, gen, charge, discharge, unpowered, consumers };
  }
  const fmtK = (kw) => kw >= 1000 ? (kw / 1000).toFixed(1) + 'MW' : Math.round(kw) + 'kW';

  return (
    <header className="topbar">
      <div className="tb-left">
        <span className="logo">⚙ 自动工厂</span>
        <span className="tb-item">⏱ {FG.Utils.fmtTime(game.playTime || 0)}</span>
        {powerSummary && (
          <span
            className={'tb-item power-chip' + (powerSummary.unpowered > 0 ? ' warn' : '')}
            title={powerSummary.unpowered > 0
              ? `有 ${powerSummary.unpowered} 栋建筑缺电暂停（查看电线杆详情可了解电网供需）`
              : '电网：发电 / 负荷（蓄电池充+ / 放-）'}
          >
            ⚡ {fmtK(powerSummary.gen)}/{fmtK(powerSummary.demand)}
            {powerSummary.charge > 5 ? ` +${fmtK(powerSummary.charge)}` : ''}
            {powerSummary.discharge > 5 ? ` -${fmtK(powerSummary.discharge)}` : ''}
            {powerSummary.unpowered > 0 ? ` ⚠${powerSummary.unpowered}` : ''}
          </span>
        )}
      </div>

      <div className="tb-center">
        <div className="speed-btns">
          {FG.Config.SPEEDS.map((s) => (
            <button
              key={s}
              className={game.speed === s ? 'active' : ''}
              onClick={() => game.setSpeed(s)}
            >{s}×</button>
          ))}
        </div>
        <button className="btn-plain" title="暂停 (空格)" onClick={() => game.togglePause()}>
          {game.paused ? '▶ 继续' : '⏸ 暂停'}
        </button>
      </div>

      <div className="tb-right">
        {game.state === 'playing' && (
          <div className="research-bar" title="当前研究">
            <span className="rb-label">
              {current ? `研究: ${current.name}` : '研究: 未选择'}
            </span>
            <div className="rb-track">
              <div className="rb-fill" style={{
                width: current ? (mgr.progress() * 100).toFixed(1) + '%' : '0%',
                background: current ? 'linear-gradient(90deg,#4da3ff,#7cc0ff)' : '#3a4150',
              }} />
            </div>
          </div>
        )}
        <button
          className={'btn-plain' + (game.bpMode ? ' active' : '')}
          title="蓝图：框选产线生成施工计划 (B)"
          onClick={() => game.toggleBlueprintMode()}
        >📐 蓝图</button>
        <button
          className={'btn-plain' + (game.upMode ? ' active' : '')}
          title="原地升级：框选产线批量替换为已解锁的高级建筑 (U)"
          onClick={() => game.toggleUpgradeMode()}
        >⬆ 升级</button>
        <button
          className={'btn-plain' + (game.pipelineId ? ' active' : '')}
          title="一键流水线：选择预设产线直接铺在地图上 (P)"
          onClick={() => { if (game.state === 'playing') modal.pipelines(); }}
        >⚡ 流水线</button>
        <button className="btn-plain" title="科技树 (T)" onClick={onOpenTech}>🔬 科技</button>
        <button className="btn-plain" title="菜单" onClick={() => modal.menu()}>☰</button>
      </div>
    </header>
  );
}
