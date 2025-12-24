import React from 'react';
import { CheckCircle, AlertTriangle, XCircle, HelpCircle, ExternalLink } from 'lucide-react';
import { AnalysisResult, VerdictType } from '../types';

interface AnalysisCardProps {
  result: AnalysisResult;
}

export const AnalysisCard: React.FC<AnalysisCardProps> = ({ result }) => {
  const getVerdictConfig = (verdict: VerdictType) => {
    switch (verdict) {
      case VerdictType.TRUE:
        return { color: 'bg-green-500/20 border-green-500/30 text-green-400', icon: CheckCircle, label: 'Verdadeiro' };
      case VerdictType.FALSE:
        return { color: 'bg-red-500/20 border-red-500/30 text-red-400', icon: XCircle, label: 'Falso' };
      case VerdictType.MISLEADING:
        return { color: 'bg-orange-500/20 border-orange-500/30 text-orange-400', icon: AlertTriangle, label: 'Enganoso' };
      default:
        return { color: 'bg-slate-700/50 border-slate-600 text-slate-400', icon: HelpCircle, label: 'Inconclusivo' };
    }
  };

  const config = getVerdictConfig(result.verdict);
  const Icon = config.icon;

  return (
    <div className={`p-4 rounded-xl border ${config.color} transition-all duration-300 hover:scale-[1.01]`}>
      <div className="flex justify-between items-start mb-3">
        <div className="flex items-center gap-2">
          <Icon className="w-5 h-5" />
          <span className="font-bold uppercase tracking-wider text-sm">{config.label}</span>
        </div>
        <span className="text-xs font-mono opacity-50">{result.segmentId.slice(0, 4)}</span>
      </div>
      
      <p className="text-slate-300 mb-3 italic">"{result.context?.[0] || '...'}"</p>
      <p className="text-sm leading-relaxed text-slate-100">{result.explanation}</p>
      
      {result.sources.length > 0 && (
        <div className="mt-3 pt-3 border-t border-white/5">
          <p className="text-xs text-slate-500 mb-1">Fontes:</p>
          <div className="flex flex-wrap gap-2">
            {result.sources.slice(0, 2).map((source: any, i: number) => (
              <a 
                key={i} 
                href={source.uri} 
                target="_blank" 
                rel="noreferrer"
                className="text-xs flex items-center gap-1 text-blue-400 hover:underline"
              >
                <ExternalLink className="w-3 h-3" />
                {source.title || 'Referência'}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};