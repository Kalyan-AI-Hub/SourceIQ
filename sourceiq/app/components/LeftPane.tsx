'use client';
// LeftPane — always-visible chat panel

import ChatInterface from './ChatInterface';

export default function LeftPane() {
  return (
    <div className="flex flex-col h-full min-w-0 bg-[#0d1117]">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center gap-2.5 px-4 py-2.5
                      border-b border-slate-800">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-400 shrink-0" aria-hidden="true">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
        <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">
          Intelligence Assistant
        </span>
        <span className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
          <span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-[9px] font-semibold text-emerald-400">ONLINE</span>
        </span>
      </div>

      {/* Chat fills the rest */}
      <div className="flex-1 overflow-hidden">
        <ChatInterface />
      </div>

      {/* Responsible AI disclosure */}
      <div className="flex-shrink-0 px-3 py-2 border-t border-slate-800 bg-slate-900/60">
        <div className="flex items-start gap-1.5">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-slate-500 mt-0.5 shrink-0" aria-hidden="true">
            <circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>
          </svg>
          <p className="text-[9px] leading-relaxed text-slate-600">
            AI-generated content may be inaccurate. All inference runs locally on-device via phi-4-mini — no data leaves your machine. Verify critical sourcing decisions with domain experts.
          </p>
        </div>
      </div>
    </div>
  );
}
