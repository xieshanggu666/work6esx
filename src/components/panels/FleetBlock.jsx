/**
 * 车站按需运输配置：需求清单（库存下限/上限）+ 供货清单（可供物品/优先级）+ 总开关
 */
import { useState } from 'react';
import { FG } from '../../engine';
import { useEventVersion } from '../../hooks';
import { Section, PRIO_OPTS } from './ui.jsx';

export default function FleetBlock({ game, b }) {
  useEventVersion(['fleet:change']);
  const fleet = game.fleet;
  const solids = FG.Items.list().filter(i => !i.fluid);
  const demands = fleet.demandsOf(b);
  const supplies = fleet.suppliesOf(b);

  return (
    <Section title="🚆 按需铁路运输">
      <label className="cfg-row">
        <input
          type="checkbox"
          checked={fleet.enabled}
          onChange={(e) => fleet.setEnabled(e.target.checked)}
        />
        <span>启用自动派车：空闲列车按全图站点上下限自动装货/卸货</span>
      </label>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5, margin: '4px 0 6px' }}>
        在途 {fleet.jobs.length} 趟 · 本站预留 {reserveText(fleet, b)}
      </div>

      <RuleEditor
        title="需求清单（库存低于下限即派车补到上限）"
        addLabel="＋ 添加需求"
        items={demands}
        solids={solids}
        onAdd={(item, min, max, prio) => fleet.addDemand(b, item, min, max, prio)}
        onUpdate={(id, patch) => fleet.updateDemand(b, id, patch)}
        onRemove={(id) => fleet.removeDemand(b, id)}
        isDemand
      />

      <RuleEditor
        title="供货清单（本站可供货物品）"
        addLabel="＋ 添加供货"
        items={supplies}
        solids={solids}
        onAdd={(item, min, max, prio) => fleet.addSupply(b, item, prio)}
        onUpdate={(id, patch) => fleet.updateSupply(b, id, patch)}
        onRemove={(id) => fleet.removeSupply(b, id)}
      />
    </Section>
  );
}

function reserveText(fleet, b) {
  const m = fleet.reserve.get(fleet.stationKey(b));
  if (!m || !m.size) return '0 件';
  let n = 0;
  for (const v of m.values()) n += v;
  return n + ' 件';
}

function RuleEditor({ title, addLabel, items, solids, onAdd, onUpdate, onRemove, isDemand }) {
  const [item, setItem] = useState(solids[0] ? solids[0].id : '');
  const [min, setMin] = useState(20);
  const [max, setMax] = useState(60);
  const [prio, setPrio] = useState('normal');

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 11, color: 'var(--accent2)', marginBottom: 4 }}>{title}</div>
      {items.length === 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>（未配置）</div>
      )}
      {items.map((d) => (
        <RuleRow key={d.id} rule={d} isDemand={isDemand} onUpdate={onUpdate} onRemove={onRemove} />
      ))}
      <div className="stop-cfg" style={{ marginTop: 4, flexWrap: 'wrap' }}>
        <select value={item} onChange={(e) => setItem(e.target.value)}>
          {solids.map(it => <option key={it.id} value={it.id}>{it.name}</option>)}
        </select>
        {isDemand && (
          <>
            <input type="number" className="num-input" min="1" value={min}
              onChange={(e) => setMin(parseInt(e.target.value, 10) || 0)} title="库存下限" />
            <input type="number" className="num-input" min="1" value={max}
              onChange={(e) => setMax(parseInt(e.target.value, 10) || 0)} title="库存上限" />
          </>
        )}
        <select value={prio} onChange={(e) => setPrio(e.target.value)}>
          {PRIO_OPTS.map(([id, name]) => <option key={id} value={id}>{name}优先</option>)}
        </select>
        <button onClick={() => onAdd(item, isNaN(min) ? 20 : min, isNaN(max) ? 60 : max, prio)}>
          {addLabel}
        </button>
      </div>
    </div>
  );
}

function RuleRow({ rule, isDemand, onUpdate, onRemove }) {
  const item = FG.Items.byId(rule.item);
  return (
    <div className="bp-plan" style={{ marginBottom: 4 }}>
      <div className="bp-head">
        <span>{item ? item.name : rule.item}
          {isDemand ? ` · 下限 ${rule.min} / 上限 ${rule.max}` : ' · 可供'}
        </span>
        <span className={'plan-st ' + (rule.enabled ? 'st-active' : 'st-waiting')}>
          {rule.enabled ? '启用' : '停用'}
        </span>
      </div>
      <div className="action-row" style={{ marginTop: 2 }}>
        <select
          value={rule.priority}
          onChange={(e) => onUpdate(rule.id, { priority: e.target.value })}
        >
          {PRIO_OPTS.map(([id, name]) => <option key={id} value={id}>{name}优先</option>)}
        </select>
        {isDemand && (
          <>
            <input type="number" className="num-input" min="1" value={rule.min}
              onChange={(e) => onUpdate(rule.id, { min: parseInt(e.target.value, 10) || 1 })} />
            <input type="number" className="num-input" min="1" value={rule.max}
              onChange={(e) => onUpdate(rule.id, { max: parseInt(e.target.value, 10) || 1 })} />
          </>
        )}
        <button onClick={() => onUpdate(rule.id, { enabled: !rule.enabled })}>
          {rule.enabled ? '停用' : '启用'}
        </button>
        <button className="danger" onClick={() => onRemove(rule.id)}>删除</button>
      </div>
    </div>
  );
}
