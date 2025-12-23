import React from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine
} from 'recharts';

interface TruthChartProps {
  data: { time: string; score: number }[];
}

export const TruthChart: React.FC<TruthChartProps> = ({ data }) => {
  return (
    <div className="h-full w-full p-2">
      <h3 className="text-toxic-green font-mono text-sm mb-2 flex items-center gap-2">
        <span className="w-2 h-2 bg-toxic-green animate-pulse rounded-full"></span>
        TRUTH_OSCILLATOR_V.1
      </h3>
      <div className="h-[150px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#0a141f" />
            <XAxis 
              dataKey="time" 
              hide 
            />
            <YAxis 
              domain={[-1, 1]} 
              hide 
            />
            <Tooltip 
              contentStyle={{ backgroundColor: '#050a10', borderColor: '#00ff88', color: '#fff' }}
              itemStyle={{ color: '#00ff88' }}
            />
            <ReferenceLine y={0} stroke="#444" strokeDasharray="3 3" />
            <Line
              type="monotone"
              dataKey="score"
              stroke="#00ff88"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false} // Performance for real-time
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};
