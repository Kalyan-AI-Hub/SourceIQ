'use client';
// MainLayout — fixed left chat + right tabbed sections
// Clicking a nav tab shows ONLY that section, filling the full right pane.

import { useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import LeftPane from './LeftPane';
import ThemeToggle from './ThemeToggle';
import WhatIfSimulator from './WhatIfSimulator';
import DiversificationGauge from './DiversificationGauge';
import AIInsightsPanel from './AIInsightsPanel';

const ConflictHeatmap        = dynamic(() => import('./ConflictHeatmap'),        { ssr: false });
const CommodityTicker        = dynamic(() => import('./CommodityTicker'),         { ssr: false });
const RiskRadarStrip         = dynamic(() => import('./RiskRadarStrip'),          { ssr: false });
const SignalConvergenceStrip = dynamic(() => import('./SignalConvergenceStrip'),  { ssr: false });

type Tab = 'supply-chain-health' | 'risk-map' | 'what-if-simulator' | 'intelligence';

const TABS = [
  {
    id: 'risk-map' as Tab,
    label: 'Risk Map',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
        <circle cx="12" cy="10" r="3"/>
      </svg>
    ),
  },
  {
    id: 'supply-chain-health' as Tab,
    label: 'Supply Chain Health',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polygon points="12,2 22,7.5 22,16.5 12,22 2,16.5 2,7.5"/>
        <polyline points="8,12 11,15 16,9"/>
      </svg>
    ),
  },
  {
    id: 'what-if-simulator' as Tab,
    label: 'Tariff Simulator',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M7 16V4m0 0L3 8m4-4 4 4"/><path d="M17 8v12m0 0 4-4m-4 4-4-4"/>
      </svg>
    ),
  },
  {
    id: 'intelligence' as Tab,
    label: 'Intelligence',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/>
      </svg>
    ),
  },
];

export default function MainLayout() {
  const [activeTab, setActiveTab] = useState<Tab>('risk-map');
  // Track which tabs have ever been shown — defers first render until tab is activated,
  // so components with browser APIs (Leaflet) get a real container size on mount.
  const [everShown, setEverShown] = useState<Set<Tab>>(new Set<Tab>(['risk-map']));
  const [alertCount, setAlertCount] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleTabChange = useCallback((id: Tab) => {
    setActiveTab(id);
    setEverShown(prev => (prev.has(id) ? prev : new Set<Tab>(Array.from(prev).concat(id))));
  }, []);

  const prefillChat = useCallback((text: string) => {
    window.dispatchEvent(new CustomEvent('sourceiq:analyze-country', { detail: text }));
  }, []);

  const handleAlertsChange = useCallback((count: number) => {
    setAlertCount(count);
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#0d1117] text-slate-100">

      {/* ── Brand header ── */}
      <header className="flex-shrink-0 grid grid-cols-3 items-center px-4 h-14 border-b border-slate-800/80 bg-[#0d1117]"
        style={{ backgroundImage: 'linear-gradient(180deg, rgba(30,41,59,0.35) 0%, transparent 100%)' }}>

        {/* Left — empty on desktop, can hold hamburger on mobile */}
        <div className="flex items-center">
          <button
            onClick={() => setSidebarOpen(o => !o)}
            className="md:hidden text-slate-500 hover:text-slate-300 p-1.5 rounded-lg transition-colors"
            aria-label="Open chat"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            </svg>
          </button>
        </div>

        {/* Center — brand */}
        <div className="flex flex-col items-center justify-center gap-0.5">
          <div className="flex items-center gap-2.5">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
              className="text-blue-400 drop-shadow-[0_0_6px_rgba(96,165,250,0.6)]" aria-hidden="true">
              <polygon points="12,2 22,7.5 22,16.5 12,22 2,16.5 2,7.5" stroke="currentColor" strokeWidth="1.5"/>
              <circle cx="12" cy="12" r="2" fill="currentColor"/>
              <line x1="12" y1="4.5" x2="12" y2="10" stroke="currentColor" strokeWidth="1.2"/>
              <line x1="12" y1="14" x2="12" y2="19.5" stroke="currentColor" strokeWidth="1.2"/>
              <line x1="4.8" y1="8.8" x2="10" y2="11.2" stroke="currentColor" strokeWidth="1.2"/>
              <line x1="14" y1="12.8" x2="19.2" y2="15.2" stroke="currentColor" strokeWidth="1.2"/>
            </svg>
            <span className="text-[17px] font-bold text-white tracking-tight leading-none">SourcingIntel</span>
          </div>
          <span className="text-[10px] text-slate-500 font-medium tracking-wide hidden sm:block">
            AI-Powered Retail Sourcing Intelligence
          </span>
        </div>

        {/* Right — model status + theme toggle */}
        <div className="flex items-center justify-end gap-2">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" aria-hidden="true" />
            <span className="text-[10px] font-semibold text-emerald-400 tracking-wide whitespace-nowrap">phi-4-mini · Local</span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      {/* ── Full-width commodity ticker ── */}
      <div className="flex-shrink-0">
        <CommodityTicker onAlertsChange={handleAlertsChange} />
      </div>

      {/* ── Body: left chat + right content ── */}
      <div className="flex flex-1 min-h-0 overflow-hidden relative">

        {/* Mobile sidebar toggle */}
        <button
          onClick={() => setSidebarOpen(o => !o)}
          className="md:hidden fixed bottom-4 right-4 z-50 w-12 h-12 rounded-full bg-blue-600 text-white shadow-lg flex items-center justify-center"
          aria-label={sidebarOpen ? 'Close chat' : 'Open chat'}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {sidebarOpen
              ? <path d="M18 6L6 18M6 6l12 12" />
              : <><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></>}
          </svg>
        </button>

        {/* Mobile overlay */}
        {sidebarOpen && (
          <div
            className="md:hidden fixed inset-0 bg-black/50 z-30"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Left pane — collapsible on mobile */}
        <aside
          className={`flex-shrink-0 w-[85vw] sm:w-[380px] md:w-[420px] lg:w-[520px] xl:w-[580px] h-full flex flex-col
                     border-r border-slate-800 bg-[#0d1117]
                     fixed md:static z-40 transition-transform duration-200
                     ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}
        >
          <LeftPane />
        </aside>

        {/* Right pane — tab nav + section content */}
        <div className="flex flex-1 flex-col min-h-0 min-w-0 bg-[#0d1117]">

          {/* ── Tab navigation ── */}
          <nav
            aria-label="Main sections"
            className="flex-shrink-0 flex items-end gap-0 border-b border-slate-800
                       bg-[#0d1117] px-2 sm:px-4 overflow-x-auto"
          >
            {TABS.map(({ id, label, icon }) => {
              const isActive = activeTab === id;
              const showAlertBadge = id === 'risk-map' && alertCount > 0;
              return (
                <button
                  key={id}
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => handleTabChange(id)}
                  className={`
                    relative flex items-center gap-1.5 px-2.5 sm:px-4 py-3 text-xs sm:text-sm font-medium tracking-wide transition-all whitespace-nowrap
                    ${isActive
                      ? 'text-white bg-slate-800/60'
                      : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800/30'}
                  `}
                >
                  <span className={isActive ? 'text-blue-400' : ''}>{icon}</span>
                  <span className="hidden sm:inline">{label}</span>
                  {showAlertBadge && (
                    <span className="flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-[9px] font-bold text-white leading-none">
                      {alertCount}
                    </span>
                  )}
                  {isActive && (
                    <span className="absolute bottom-0 left-0 right-0 h-[2px] rounded-t-full bg-blue-500" />
                  )}
                </button>
              );
            })}
          </nav>

          {/* ── Section content — ALL panels stay mounted; only active one is visible ── */}
          {/* Using display:flex/none instead of conditional rendering preserves component  */}
          {/* state (fetched data, chart state) when switching tabs.                        */}
          <div className="flex-1 min-h-0 overflow-hidden relative">

            {/* ════ Supply Chain Health ════ */}
            <div style={{ display: activeTab === 'supply-chain-health' ? 'flex' : 'none' }}
                 className="flex-col h-full overflow-y-auto p-4">
              <div className="min-h-0 rounded-xl border border-slate-800 bg-slate-900/60">
                <DiversificationGauge />
              </div>
            </div>

            {/* ════ Risk Map ════ */}
            {/* Only mount once the tab has been activated — Leaflet needs a visible  */}
            {/* container with real dimensions on first render, not display:none.      */}
            {everShown.has('risk-map') && (
              <div style={{ display: activeTab === 'risk-map' ? 'flex' : 'none' }}
                   className="flex-col h-full overflow-hidden">
                <div className="flex-shrink-0">
                  <RiskRadarStrip />
                </div>
                {/* Map + Convergence strip — convergence is OUTSIDE overflow-hidden so its
                    detail panel can expand upward without being clipped */}
                <div className="relative flex-1 min-h-0 mx-3 mt-2 mb-3 flex flex-col">
                  {/* The map itself clips to its rounded border */}
                  <div className="relative flex-1 min-h-0 rounded-xl overflow-hidden border border-slate-800">
                    <ConflictHeatmap />
                  </div>
                  {/* Convergence strip sits below the map, detail panel opens upward */}
                  <div className="relative">
                    <SignalConvergenceStrip />
                  </div>
                </div>
              </div>
            )}

            {/* ════ Tariff Simulator ════ */}
            <div style={{ display: activeTab === 'what-if-simulator' ? 'flex' : 'none' }}
                 className="flex-col h-full overflow-y-auto p-4">
              <div className="min-h-0 rounded-xl border border-slate-800 bg-slate-900/60 overflow-auto">
                <WhatIfSimulator />
              </div>
            </div>

            {/* ════ Intelligence ════ */}
            <div style={{ display: activeTab === 'intelligence' ? 'flex' : 'none' }}
                 className="flex-col h-full overflow-hidden">
              <div className="flex-1 min-h-0 mx-3 mb-3 rounded-xl border border-slate-800 bg-slate-900/60 overflow-auto">
                <AIInsightsPanel onAnalyze={prefillChat} />
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
