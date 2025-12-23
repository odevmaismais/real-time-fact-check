
import React, { useEffect, useRef } from 'react';

interface AudioVisualizerProps {
  active: boolean;
  analyser: AnalyserNode | null;
}

export const AudioVisualizer: React.FC<AudioVisualizerProps> = ({ active, analyser }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number>(null);

  useEffect(() => {
    // Reset if inactive
    if (!active || !analyser) {
       if (containerRef.current) {
         const bars = containerRef.current.children;
         for (let i = 0; i < bars.length; i++) {
           // Keep the "Signal Offline" overlay visible, bars flat
           (bars[i] as HTMLElement).style.height = '5%';
         }
       }
       if (animationRef.current) cancelAnimationFrame(animationRef.current);
       return;
    }

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    // We only have 24 bars, but the frequency data is much larger (usually 1024 or 2048).
    // We need to sample the data to fit 24 bars.
    // We focus on the lower-mid frequencies where voice usually resides.
    const step = Math.floor((bufferLength / 2) / 24); 

    const draw = () => {
      analyser.getByteFrequencyData(dataArray);

      if (containerRef.current) {
        const bars = containerRef.current.children;
        // The first child might be the overlay div, so we need to be careful with selection
        // We filter for the actual bar divs.
        const barElements = Array.from(bars).filter((el) => (el as Element).classList.contains('audio-bar'));

        for (let i = 0; i < barElements.length; i++) {
          const dataIndex = i * step;
          const value = dataArray[dataIndex];
          
          // Map 0-255 to 5%-100% height
          const percent = Math.max(5, (value / 255) * 100);
          
          (barElements[i] as HTMLElement).style.height = `${percent}%`;
        }
      }

      animationRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [active, analyser]);

  return (
    <div 
      ref={containerRef}
      className="h-20 w-full bg-black/60 border border-gray-800 rounded mb-4 flex items-center justify-center gap-[2px] px-2 py-2 relative overflow-hidden shadow-[inset_0_0_20px_rgba(0,0,0,0.8)]"
    >
       {/* Scanlines overlay */}
       <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] z-10 bg-[length:100%_2px,3px_100%]" />
       
       {!active && (
         <div className="absolute inset-0 flex items-center justify-center z-20 bg-black/40 backdrop-blur-[1px]">
            <span className="text-[10px] font-mono text-gray-600 animate-pulse tracking-[0.2em] uppercase border border-gray-800 px-2 py-1 rounded bg-black/50">
                Signal Offline
            </span>
         </div>
      )}
      
      {Array.from({ length: 24 }).map((_, i) => (
        <div
          key={i}
          className={`audio-bar w-1 flex-1 rounded-[1px] transition-[height] duration-75 ease-linear ${
              active 
              ? 'bg-neon-cyan shadow-[0_0_8px_rgba(0,255,255,0.6)]' 
              : 'bg-gray-900 border-t border-gray-800'
          }`}
          style={{ height: '5%' }}
        />
      ))}
    </div>
  );
};
