'use client';

import type { SourcingRecommendation } from '../../src/types/index';

interface Props { recommendations: SourcingRecommendation[]; }

const tierColors: Record<string, string> = {
  safe:     'bg-green-900/40 text-green-400',
  elevated: 'bg-yellow-900/40 text-yellow-400',
  high:     'bg-orange-900/40 text-orange-400',
  critical: 'bg-red-900/40 text-red-400',
};

function riskTier(score: number): string {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'elevated';
  return 'safe';
}

export default function SKUTable({ recommendations }: Props) {
  if (!recommendations.length) return null;

  const sorted = [...recommendations].sort((a, b) => b.annualSavingsUSD - a.annualSavingsUSD);
  const totalSavings = sorted.reduce((sum, recommendation) => sum + recommendation.annualSavingsUSD, 0);

  return (
    <div className="mt-2 sq-panel overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200 dark:border-slate-800">
        <div>
          <div className="sq-label mb-1">Recommendation Matrix</div>
          <p className="text-sm font-medium text-slate-800 dark:text-slate-100">Top sourcing switches ranked by annual savings.</p>
        </div>
        <span className="sq-chip">{new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(totalSavings)} upside</span>
      </div>
      <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-slate-100 dark:bg-slate-900 text-slate-500">
          <tr>
            <th className="px-3 py-2 text-left font-medium">SKU</th>
            <th className="px-3 py-2 text-left font-medium">Current</th>
            <th className="px-3 py-2 text-left font-medium">Recommended</th>
            <th className="px-3 py-2 text-right font-medium">Annual Savings</th>
            <th className="px-3 py-2 text-center font-medium">Risk</th>
          </tr>
        </thead>
        <tbody className="bg-white/70 dark:bg-slate-900/30 divide-y divide-slate-200 dark:divide-slate-800">
          {sorted.map(r => {
            const tier = riskTier(r.riskScore);
            return (
              <tr key={r.sku} className="hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors">
                <td className="px-3 py-2 font-mono font-medium text-slate-700 dark:text-slate-200">{r.sku}</td>
                <td className="px-3 py-2 text-slate-500 dark:text-slate-400">{r.currentCountry}</td>
                <td className="px-3 py-2 text-green-400 font-medium">{r.recommendedCountry}</td>
                <td className="px-3 py-2 text-right font-semibold text-green-400">
                  ${r.annualSavingsUSD.toLocaleString()}
                </td>
                <td className="px-3 py-2 text-center">
                  <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${tierColors[tier]}`}>
                    {r.riskScore}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}
