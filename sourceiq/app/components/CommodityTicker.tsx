'use client';

// app/components/CommodityTicker.tsx — live commodity price ticker bar
// Polls /api/commodities every 5 minutes (matches Stooq 1h cache)
// Shows: WTI oil, Brent oil, Baltic Dry Index, Cotton, Copper

import { useEffect, useState, useCallback } from 'react';

interface CommodityPrice {
  symbol:    string;
  name:      string;
  price:     number;
  date:      string;
  unit:      string;
  change1d?: number;
}

interface TickerData {
  oil?: {
    wti:           CommodityPrice;
    brent:         CommodityPrice;
    freightImpact: string;
  } | null;
  shipping?: {
    bdi:           CommodityPrice;
    freightImpact: string;
  } | null;
  commodities?: {
    cotton: CommodityPrice;
    copper: CommodityPrice;
  } | null;
  /** USD FX rates — 1 USD = N units of currency */
  forex?: Record<string, number> | null;
  fetchedAt?: number;
}

interface TickerItem {
  label:           string;
  value:           string;
  change?:         number;
  tooltip:         string;
  alert?:          boolean; // highlight red when price signals risk
  isSeparator?:    boolean; // visual group divider within the scroll strip
  separatorLabel?: string;
}

function formatChange(change?: number): string {
  if (change === undefined) return '';
  return `${change > 0 ? '+' : ''}${change.toFixed(2)}%`;
}

function changeColor(change?: number, invert = false): string {
  if (change === undefined) return 'text-slate-400';
  const isUp = change > 0;
  // For commodities: up = bad for sourcing (higher costs) → red. invert for safe-haven.
  const bad = invert ? !isUp : isUp;
  return bad ? 'text-red-400' : 'text-emerald-400';
}

// Key sourcing currencies to show — maps code → sourcing context tooltip
const FX_DISPLAY: Record<string, string> = {
  CNY: 'Chinese Yuan — electronics, toys sourcing',
  EUR: 'Euro — Turkey, Morocco sourcing',
  INR: 'Indian Rupee — home goods, apparel sourcing',
  VND: 'Vietnamese Dong — electronics, apparel sourcing',
  MXN: 'Mexican Peso — USMCA 0% tariff sourcing',
  BDT: 'Bangladeshi Taka — apparel sourcing',
  IDR: 'Indonesian Rupiah — home goods sourcing',
};

function buildItems(data: TickerData): TickerItem[] {
  const items: TickerItem[] = [];

  if (data.oil?.wti) {
    const { wti, brent, freightImpact } = data.oil;
    items.push({
      label: 'WTI',
      value: `$${wti.price.toFixed(2)}`,
      change: wti.change1d,
      tooltip: `WTI Crude Oil — ${freightImpact}`,
      alert: wti.price > 100,
    });
    items.push({
      label: 'Brent',
      value: `$${brent.price.toFixed(2)}`,
      change: brent.change1d,
      tooltip: `Brent Crude Oil — ${freightImpact}`,
      alert: brent.price > 100,
    });
  }

  if (data.shipping?.bdi) {
    const { bdi, freightImpact } = data.shipping;
    items.push({
      label: 'BDI',
      value: bdi.price.toLocaleString(),
      change: bdi.change1d,
      tooltip: `Baltic Dry Index — ${freightImpact}`,
      alert: bdi.price > 3000,
    });
  }

  if (data.commodities) {
    const { cotton, copper } = data.commodities;
    items.push({
      label: 'Cotton',
      value: `$${cotton.price.toFixed(2)}/lb`,
      change: cotton.change1d,
      tooltip: 'Cotton futures — affects apparel/textile sourcing (Bangladesh, India, Vietnam)',
      alert: cotton.price > 1.2,
    });
    items.push({
      label: 'Copper',
      value: `$${copper.price.toFixed(2)}/lb`,
      change: copper.change1d,
      tooltip: 'Copper futures — affects electronics manufacturing costs (China, Taiwan)',
      alert: copper.price > 5,
    });
  }

  // Group divider before FX so viewers can distinguish market vs currency data
  if (data.forex && items.length > 0) {
    items.push({ label: '', value: '', tooltip: '', isSeparator: true, separatorLabel: 'FX RATES' });
  }

  // Forex rates — show key sourcing currencies (1 USD = N units)
  if (data.forex) {
    for (const [code, tooltip] of Object.entries(FX_DISPLAY)) {
      const rate = data.forex[code];
      if (rate === undefined) continue;
      items.push({
        label: `USD/${code}`,
        value: rate >= 100 ? rate.toFixed(0) : rate.toFixed(4),
        tooltip: `${tooltip} · Live rate: 1 USD = ${rate} ${code}`,
      });
    }
  }

  return items;
}

interface CommodityTickerProps {
  onAlertsChange?: (count: number) => void;
}

export default function CommodityTicker({ onAlertsChange }: CommodityTickerProps) {
  const [data, setData]       = useState<TickerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [hovered, setHovered] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/commodities');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as TickerData;
      setData(json);
      setError(false);
      setLastUpdated(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
    // Refresh every 5 minutes — Stooq data updates during market hours
    const id = setInterval(() => void fetchData(), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [fetchData]);

  // Notify parent when alert-level commodity prices are detected
  useEffect(() => {
    if (!onAlertsChange || !data) return;
    const count = buildItems(data).filter(i => i.alert).length;
    onAlertsChange(count);
  }, [data, onAlertsChange]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-100 dark:bg-slate-900 border-b border-slate-300 dark:border-slate-700 text-xs text-slate-500 transition-colors">
        <span className="animate-pulse">Loading commodity prices…</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-100 dark:bg-slate-900 border-b border-slate-300 dark:border-slate-700 text-xs text-slate-500 dark:text-slate-600 transition-colors">
        <span>Market data unavailable</span>
      </div>
    );
  }

  const items = buildItems(data);
  if (items.length === 0) return null;

  const alertCount = items.filter(i => i.alert).length;
  // Duplicate items so the marquee seamlessly loops
  const tickerItems = [...items, ...items];

  return (
    <div className="relative flex items-center bg-slate-100 dark:bg-slate-900 border-b border-slate-300 dark:border-slate-700 overflow-hidden shrink-0 transition-colors"
         role="region" aria-label="Live commodity prices">
      {/* LIVE badge — pinned left */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-r border-slate-300 dark:border-slate-700 shrink-0 z-10 bg-slate-100 dark:bg-slate-900">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
        <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">Live</span>
      </div>

      {/* Commodity alert badge — shown when prices signal supply chain risk */}
      {alertCount > 0 && (
        <div className="flex items-center gap-1 px-2.5 py-1.5 border-r border-red-300 dark:border-red-800/60 shrink-0 z-10 bg-red-50 dark:bg-red-950/40">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-red-500 dark:text-red-400 flex-shrink-0" aria-hidden="true">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <span className="text-[10px] font-bold text-red-500 dark:text-red-400 uppercase tracking-wider whitespace-nowrap">
            {alertCount} alert{alertCount !== 1 ? 's' : ''}
          </span>
        </div>
      )}

      {/* Scrolling marquee — pause on hover so users can read values */}
      <div
        className="overflow-hidden flex-1"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div
          className="flex items-center gap-0 animate-marquee whitespace-nowrap w-max"
          style={{ animationPlayState: hovered ? 'paused' : 'running' }}
        >
          {tickerItems.map((item, idx) => {
            if (item.isSeparator) {
              return (
                <div key={`sep-${idx}`}
                     className="flex items-center px-3 py-1.5 border-r border-slate-300 dark:border-slate-700 shrink-0">
                  <span className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">
                    {item.separatorLabel}
                  </span>
                </div>
              );
            }
            return (
              <div
                key={`${item.label}-${idx}`}
                title={item.tooltip}
                className={`flex items-center gap-1.5 px-3 py-1.5 border-r border-slate-300 dark:border-slate-700 shrink-0 cursor-help
                  ${item.alert ? 'bg-red-50 dark:bg-red-950/30' : ''}`}
              >
                <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">{item.label}</span>
                <span className={`text-xs font-semibold tabular-nums ${item.alert ? 'text-red-600 dark:text-red-300' : 'text-slate-700 dark:text-slate-200'}`}>
                  {item.value}
                </span>
                {item.change !== undefined && (
                  <span className={`text-xs tabular-nums ${changeColor(item.change)}`}>
                    {formatChange(item.change)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Last updated — pinned right */}
      <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 shrink-0 z-10 bg-slate-100 dark:bg-slate-900">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-slate-400" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
        <span className="text-xs text-slate-500 dark:text-slate-600 tabular-nums">{lastUpdated}</span>
      </div>
    </div>
  );
}
