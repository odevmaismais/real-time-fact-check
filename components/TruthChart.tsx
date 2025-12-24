import React from 'react';
import { AnalysisResult, VerdictType } from '../types';

interface TruthChartProps {
  history: AnalysisResult[];
}

export const TruthChart: React.FC<TruthChartProps> = ({ history }) => {
  const stats = {
    true: history.filter(h => h.verdict === VerdictType.TRUE).length,
    false: history.filter(h => h.verdict === VerdictType.FALSE).length,
    misleading: history.filter(h => h.verdict === VerdictType.MISLEADING).length,
    total: history.length || 1
  };

  return (
    <div className="flex h-4 w-full rounded-full overflow-hidden bg-slate-700">
      <div 
        style={{ width: `${(stats.true / stats.total) * 100}%` }} 
        className="bg-green-500 h-full transition-all duration-500" 
        title={`Verdadeiro: ${stats.true}`}
      />
      <div 
        style={{ width: `${(stats.misleading / stats.total) * 100}%` }} 
        className="bg-orange-500 h-full transition-all duration-500" 
        title={`Enganoso: ${stats.misleading}`}
      />
      <div 
        style={{ width: `${(stats.false / stats.total) * 100}%` }} 
        className="bg-red-500 h-full transition-all duration-500" 
        title={`Falso: ${stats.false}`}
      />
    </div>
  );
};