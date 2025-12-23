
import React from 'react';
import { AnalysisResult, VerdictType } from '../types';
import { AlertTriangle, CheckCircle, HelpCircle, XCircle, Info, ExternalLink } from 'lucide-react';

interface AnalysisCardProps {
  analysis: AnalysisResult; 
  segmentText: string;
}

const getVerdictStyles = (verdict: VerdictType) => {
  switch (verdict) {
    case VerdictType.TRUE:
      return { color: 'text-toxic-green', border: 'border-toxic-green', icon: CheckCircle, label: 'VERIFIED' };
    case VerdictType.FALSE:
      return { color: 'text-alert-red', border: 'border-alert-red', icon: XCircle, label: 'FALSEHOOD DETECTED' };
    case VerdictType.MISLEADING:
      return { color: 'text-yellow-500', border: 'border-yellow-500', icon: AlertTriangle, label: 'CONTEXT MISSING' };
    case VerdictType.OPINION:
      return { color: 'text-blue-400', border: 'border-blue-400', icon: Info, label: 'SUBJECTIVE' };
    default:
      return { color: 'text-gray-500', border: 'border-gray-500', icon: HelpCircle, label: 'UNVERIFIABLE' };
  }
};

export const AnalysisCard: React.FC<AnalysisCardProps> = ({ analysis, segmentText }) => {
  const style = getVerdictStyles(analysis.verdict);
  const Icon = style.icon;

  return (
    <div className={`mb-4 p-4 glass-panel border-l-4 ${style.border} relative overflow-hidden group`}>
        {/* Background Glitch Effect on Hover */}
      <div className="absolute inset-0 bg-gradient-to-r from-transparent to-white/5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

      <div className="flex items-start justify-between mb-2">
        <div className={`flex items-center gap-2 font-mono font-bold ${style.color}`}>
          <Icon className="w-5 h-5" />
          <span>{style.label}</span>
          <span className="text-xs opacity-60">CONFIDENCE: {analysis.confidence}%</span>
        </div>
      </div>

      <div className="mb-3">
        <p className="text-gray-400 text-sm italic border-l-2 border-gray-700 pl-2 mb-2 line-clamp-2">
          "{segmentText}"
        </p>
        <p className="text-gray-200 text-sm leading-relaxed">
          {analysis.explanation}
        </p>
      </div>

      {/* Sentiment/Tone Indicator */}
      <div className="mb-4 bg-black/20 p-2 rounded border border-gray-800/50">
        <div className="flex items-center justify-between text-[10px] uppercase font-mono text-gray-500 mb-1">
           <span>Hostile (-1)</span>
           <span>Neutral</span>
           <span>Constructive (+1)</span>
        </div>
        <div className="relative h-1.5 bg-gray-900 rounded-full w-full overflow-hidden">
           {/* Center Line */}
           <div className="absolute left-1/2 top-0 bottom-0 w-[1px] bg-gray-600 z-10" />
           
           {/* Bar */}
           <div 
             className={`absolute top-0 bottom-0 transition-all duration-500 ${analysis.sentimentScore < 0 ? 'bg-alert-red shadow-[0_0_10px_rgba(255,0,0,0.5)]' : 'bg-toxic-green shadow-[0_0_10px_rgba(0,255,136,0.5)]'}`}
             style={{
                left: analysis.sentimentScore < 0 ? `${(1 + analysis.sentimentScore) * 50}%` : '50%',
                width: `${Math.abs(analysis.sentimentScore) * 50}%`
             }}
           />
        </div>
        <div className="flex justify-between items-center mt-1">
             <span className="text-[10px] text-gray-600 font-mono">TONE ANALYSIS</span>
             <span className={`text-[10px] font-mono font-bold ${analysis.sentimentScore < 0 ? 'text-alert-red' : 'text-toxic-green'}`}>
                {analysis.sentimentScore > 0 ? 'POSITIVE' : analysis.sentimentScore < 0 ? 'NEGATIVE' : 'NEUTRAL'} ({analysis.sentimentScore > 0 ? '+' : ''}{analysis.sentimentScore.toFixed(2)})
             </span>
        </div>
      </div>

      {analysis.counterEvidence && (
        <div className="bg-alert-red/10 border border-alert-red/30 p-2 rounded mb-2">
          <p className="text-alert-red text-xs font-bold mb-1">REALITY CHECK:</p>
          <p className="text-gray-300 text-xs">{analysis.counterEvidence}</p>
        </div>
      )}

      {analysis.logicalFallacies && analysis.logicalFallacies.length > 0 && (
         <div className="flex flex-col gap-2 mb-2">
            {analysis.logicalFallacies.map((fallacy, idx) => (
                <div key={idx} className="bg-haze-purple/10 border border-haze-purple/30 rounded p-2">
                    <p className="text-haze-purple text-[10px] font-bold uppercase font-mono mb-1">{fallacy.name}</p>
                    <p className="text-gray-400 text-xs">{fallacy.description}</p>
                </div>
            ))}
         </div>
      )}

      {analysis.sources.length > 0 && (
        <div className="mt-3 pt-2 border-t border-gray-800">
          <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Sources</p>
          <ul className="space-y-1">
            {analysis.sources.map((source, i) => (
              <li key={i}>
                <a 
                  href={source.uri} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-neon-cyan hover:underline truncate"
                >
                  <ExternalLink className="w-3 h-3" />
                  {source.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
