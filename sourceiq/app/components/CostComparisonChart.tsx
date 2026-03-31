'use client';

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from 'recharts';
import type { ChartData } from '../../src/types/index';

interface Props { chartData: ChartData; }

export default function CostComparisonChart({ chartData }: Props) {
  if (chartData.type !== 'bar' || !chartData.data.length) return null;

  const maxCost = Math.max(
    ...chartData.data.flatMap(d => [Number(d['currentCost'] ?? 0), Number(d['recommendedCost'] ?? 0)]),
  );

  return (
    <div className="sq-panel p-3 mt-2 transition-colors">
      <div className="flex items-center justify-between mb-2">
        <h3 className="sq-label">Cost Comparison</h3>
        <span className="sq-chip">Live landed cost model</span>
      </div>
      <p className="text-sm font-medium text-slate-800 dark:text-slate-100 mb-3">{chartData.title}</p>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={chartData.data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#334155" opacity={0.35} />
          <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#94a3b8' }} />
          <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} domain={[0, maxCost * 1.1]} tickFormatter={v => `$${v}`} />
          <Tooltip
            contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
            formatter={(value: number, name: string) => [`$${value.toFixed(2)}`, name]}
          />
          <Legend wrapperStyle={{ fontSize: 10, color: '#94a3b8' }} />
          <Bar dataKey="currentCost" name="Current Cost" fill="#3b82f6" radius={[2, 2, 0, 0]} />
          <Bar dataKey="recommendedCost" name="Recommended Cost" fill="#22c55e" radius={[2, 2, 0, 0]} />
          <ReferenceLine y={maxCost} stroke="#475569" strokeDasharray="4 2" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
