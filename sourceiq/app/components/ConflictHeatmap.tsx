'use client';
// CRITICAL: this file must ONLY be loaded via dynamic(() => import(...), { ssr: false })
// Leaflet accesses `window` on import — crashes in Next.js SSR.

import { useEffect, useState } from 'react';
import { MapContainer, GeoJSON } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import type { SourcingRiskIndex } from '../../src/types/index';

const TIER_COLOR: Record<string, string> = {
  safe:     '#22c55e',
  elevated: '#eab308',
  high:     '#f97316',
  critical: '#ef4444',
};

const TIER_LABEL: Record<string, string> = {
  safe:     'text-emerald-400',
  elevated: 'text-yellow-400',
  high:     'text-orange-400',
  critical: 'text-red-400',
};

interface ClickedInfo {
  country: string;
  sri: SourcingRiskIndex | null;
}

interface GeoFeature {
  type: string;
  properties: { ADMIN?: string; name?: string; NAME?: string; [k: string]: unknown };
  geometry: object;
}

function countryName(p: GeoFeature['properties']): string {
  return p.ADMIN ?? p.name ?? p.NAME ?? '';
}

export default function ConflictHeatmap() {
  const [sriData, setSriData] = useState<SourcingRiskIndex[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [geoJson, setGeoJson] = useState<any>(null);
  const [streamConnected, setStreamConnected] = useState(false);
  const [clickedInfo, setClickedInfo] = useState<ClickedInfo | null>(null);

  useEffect(() => {
    // Real-time streaming via SSE — no polling needed
    const es = new EventSource('/api/risk-stream');

    const applyData = (raw: string) => {
      try {
        const d = JSON.parse(raw) as SourcingRiskIndex[];
        if (Array.isArray(d)) setSriData(d);
      } catch { /* ignore parse errors */ }
    };

    es.addEventListener('snapshot', (e: MessageEvent) => { setStreamConnected(true); applyData(e.data); });
    es.addEventListener('update',   (e: MessageEvent) => applyData(e.data));
    es.onerror = () => setStreamConnected(false);

    fetch('/world.geojson')
      .then(r => r.json())
      .then(setGeoJson)
      .catch(() => console.warn('world.geojson not found — add to /public to enable map colors'));

    return () => es.close();
  }, []);

  const sriMap = new Map(sriData.map(s => [s.country, s]));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function style(feature: any) {
    const name = countryName(feature.properties as GeoFeature['properties']);
    const sri = sriMap.get(name);
    if (sri) {
      const color = TIER_COLOR[sri.tier];
      return {
        fillColor: color,
        fillOpacity: 0.70,
        color: color,
        weight: 0.8,
        className: sri.tier === 'critical' ? 'critical-pulse' : '',
      };
    }
    // Untracked countries: subtle slate fill so geography is always visible
    return {
      fillColor: '#1e293b',   // slate-800 — matches UI card surface
      fillOpacity: 1,
      color: '#334155',       // slate-700 border
      weight: 0.5,
      className: '',
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function onEachFeature(feature: any, layer: any) {
    const name = countryName(feature.properties as GeoFeature['properties']);
    const sri = sriMap.get(name);
    if (sri) {
      // Permanent label showing country name on tracked/colored countries
      layer.bindTooltip(name, {
        permanent: true,
        direction: 'center',
        className: 'map-country-label',
      });
      // Separate hover tooltip with full detail (replaces permanent on hover)
      layer.on('mouseover', function (this: any) {
        layer.unbindTooltip();
        layer.bindTooltip(
          `${name}\nSRI: ${sri.score}/100 (${sri.tier})\nTrend: ${sri.trend}`,
          { sticky: true, className: 'text-xs' },
        ).openTooltip();
      });
      layer.on('mouseout', function () {
        layer.unbindTooltip();
        layer.bindTooltip(name, {
          permanent: true,
          direction: 'center',
          className: 'map-country-label',
        });
      });
    } else {
      layer.bindTooltip(name, { sticky: true, className: 'text-xs' });
    }
    layer.on('click', () => {
      setClickedInfo({ country: name, sri: sriMap.get(name) ?? null });
    });
  }

  return (
    <div className="h-full w-full relative">
      {/* SSE connection status badge */}
      <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[1000] pointer-events-none">
        {streamConnected ? (
          <div className="flex items-center gap-1.5 bg-slate-900/90 border border-green-700 text-green-400 text-xs px-3 py-1 rounded-full shadow backdrop-blur-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            LIVE
          </div>
        ) : (
          <div className="flex items-center gap-1.5 bg-slate-900/90 border border-slate-600 text-slate-400 text-xs px-3 py-1 rounded-full shadow backdrop-blur-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-pulse" />
            {sriData.length === 0 ? 'Connecting…' : 'Reconnecting…'}
          </div>
        )}
      </div>

      <MapContainer
        center={[20, 10]}
        zoom={2}
        style={{ height: '100%', width: '100%', background: '#0f172a' }}
        zoomControl={true}
        attributionControl={false}
      >
        {/* No tile layer — pure GeoJSON on navy base.
            Untracked countries render as slate-800 so world geography is always visible.
            Risk countries pop with their tier color against the dark background. */}
        {geoJson && (
          <GeoJSON
            key={sriData.map(s => s.score).join(',')}
            data={geoJson}
            style={style}
            onEachFeature={onEachFeature}
          />
        )}
      </MapContainer>

      {/* Legend — bottom-left, below zoom controls */}
      <div className="absolute bottom-4 left-4 z-[1000] bg-slate-900/95 backdrop-blur-sm rounded-xl border border-slate-700/60 p-2.5 text-xs shadow-[var(--sq-shadow-panel)]">
        {/* Header */}
        <div className="sq-label mb-2">Risk Tiers</div>
        {Object.entries(TIER_COLOR).map(([tier, color]) => (
          <div key={tier} className="flex items-center gap-1.5 mb-1">
            <span
              className={`w-2.5 h-2.5 rounded-sm inline-block ${tier === 'critical' ? 'animate-pulse' : ''}`}
              style={{ background: color }}
            />
            <span className="capitalize text-slate-300 flex-1">{tier}</span>
            {tier !== 'safe' && (
              <span className="text-slate-600 tabular-nums text-[9px]">
                {sriData.filter(s => s.tier === tier).length}
              </span>
            )}
          </div>
        ))}
        <div className="flex items-center gap-1.5 mt-1.5 pt-1.5 border-t border-slate-700/60">
          <span className="w-2.5 h-2.5 rounded-sm inline-block border border-slate-600/60" style={{ background: '#1e293b' }} />
          <span className="text-slate-500 flex-1">Untracked</span>
        </div>
        {/* Provenance */}
        {sriData.length > 0 && (
          <div className="mt-2 pt-1.5 border-t border-slate-700/60">
            <div className="text-[9px] text-slate-600">{sriData.length} countries tracked</div>
            {sriData[0]?.updatedAt && (
              <div className="text-[9px] text-slate-700 mt-0.5">
                Updated {new Date(sriData[0].updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Country action panel — appears on map click */}
      {clickedInfo && (
        <div className="absolute top-2 right-2 z-[1001] bg-slate-900/95 backdrop-blur-sm border border-slate-600 rounded-xl p-3 w-[calc(100%-1rem)] sm:w-52 max-w-[240px] shadow-2xl">
          {/* Header */}
          <div className="flex items-start justify-between gap-2 mb-2.5">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-100 truncate">{clickedInfo.country}</div>
              {clickedInfo.sri ? (
                <div className={`text-xs mt-0.5 ${TIER_LABEL[clickedInfo.sri.tier] ?? 'text-slate-400'}`}>
                  SRI {clickedInfo.sri.score}/100 · {clickedInfo.sri.tier}
                  {clickedInfo.sri.trend === 'escalating' && (
                    <span className="ml-1 text-red-400">▲ escalating</span>
                  )}
                  {clickedInfo.sri.trend === 'de-escalating' && (
                    <span className="ml-1 text-emerald-400">▼ improving</span>
                  )}
                </div>
              ) : (
                <div className="text-xs text-slate-500 mt-0.5">No risk data available</div>
              )}
            </div>
            <button
              onClick={() => setClickedInfo(null)}
              className="text-slate-500 hover:text-slate-300 text-base leading-none shrink-0 transition-colors focus:outline-none"
              aria-label="Close"
            >
              ×
            </button>
          </div>

          {/* Action buttons */}
          <div className="flex flex-col gap-1.5">
            <button
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent('sourceiq:whatif-country', { detail: clickedInfo.country }),
                );
                setClickedInfo(null);
              }}
              className="w-full text-[11px] font-semibold bg-blue-600 hover:bg-blue-500 text-white px-2.5 py-1.5 rounded-lg transition-colors text-left focus:outline-none focus:ring-2 focus:ring-blue-400"
            >
              Simulate Reroute →
            </button>
            <button
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent('sourceiq:analyze-country', {
                    detail: `Analyze sourcing risk for ${clickedInfo.country}`,
                  }),
                );
                setClickedInfo(null);
              }}
              className="w-full text-[11px] text-slate-400 hover:text-slate-200 underline transition-colors text-left focus:outline-none focus:ring-1 focus:ring-blue-500 rounded px-0.5 py-0.5"
            >
              Deep analysis →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
