import React from 'react';
import { Compass, ShieldCheck, Zap, ArrowUpRight } from 'lucide-react';

export const ExploreCarousel: React.FC = () => {
  const cards = [
    {
      id: 'cyprus1',
      title: 'Quai Cyprus-1 Shard',
      desc: 'Native execution zone with zero-cross-shard latency for high-speed Safe transactions.',
      tag: 'Shard 0-0',
      icon: Zap,
      color: 'from-emerald-500/20 to-teal-500/10',
      border: 'border-emerald-500/30',
      linkText: 'Explore Shard',
      linkUrl: 'https://orchard.quaiscan.io',
    },
    {
      id: 'bdelta',
      title: 'BDelta VDF CLOB DEX',
      desc: 'Commit-reveal settlement with Wesolowski VDF MEV protection and deep liquidity.',
      tag: 'DeFi Integration',
      icon: ShieldCheck,
      color: 'from-amber-500/20 to-orange-500/10',
      border: 'border-amber-500/30',
      linkText: 'Trade on BDelta',
      linkUrl: 'https://bdelta.boltevm.com',
    },
  ];

  return (
    <div className="bg-slate-900/90 border border-slate-800/80 rounded-2xl p-5 shadow-lg">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center space-x-2">
          <Compass className="w-4 h-4 text-emerald-400" />
          <h3 className="text-sm font-bold text-slate-200">Explore Safe Apps</h3>
        </div>
        <span className="text-[11px] text-slate-500">Quai Network Ecosystem</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.id}
              className={`bg-gradient-to-br ${card.color} border ${card.border} rounded-xl p-3.5 flex flex-col justify-between hover:scale-[1.01] transition-transform`}
            >
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-300 bg-slate-950/60 px-2 py-0.5 rounded border border-white/10">
                    {card.tag}
                  </span>
                  <Icon className="w-4 h-4 text-slate-300" />
                </div>
                <h4 className="text-xs font-bold text-white mb-1">{card.title}</h4>
                <p className="text-[11px] text-slate-300 leading-relaxed">{card.desc}</p>
              </div>

              <div className="mt-3 pt-2 border-t border-white/10 flex items-center justify-between text-xs font-semibold text-white">
                <span>{card.linkText}</span>
                <ArrowUpRight className="w-3.5 h-3.5" />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
