
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Mic, 
  MicOff, 
  Activity, 
  Radio, 
  Send, 
  Cpu, 
  Database,
  MonitorPlay,
  StopCircle,
  DollarSign,
  Sliders,
  Zap,
  ArrowDownCircle,
  PauseCircle,
  Loader2,
  Scissors,
  Layers
} from 'lucide-react';
import { DebateSegment, AnalysisResult, VerdictType, SpeechRecognition, SpeechRecognitionEvent } from './types';
import { analyzeStatement, connectToLiveDebate, LiveStatus, LiveConnectionController } from './services/geminiService';
import { loggingService } from './services/loggingService';
import { AnalysisCard } from './components/AnalysisCard';
import { TruthChart } from './components/TruthChart';
import { AudioVisualizer } from './components/AudioVisualizer';
import { v4 as uuidv4 } from 'uuid';

const App: React.FC = () => {
  const [isListening, setIsListening] = useState(false);
  const [inputMode, setInputMode] = useState<'mic' | 'tab' | 'none'>('none');
  const [inputText, setInputText] = useState('');
  
  // HISTORY: Displayed in the feed
  const [segments, setSegments] = useState<DebateSegment[]>([]);
  // QUEUE: Waiting for analysis (Producer-Consumer pattern)
  const [analysisQueue, setAnalysisQueue] = useState<DebateSegment[]>([]);
  
  // State for the current sentence being spoken (Streaming)
  const [currentStreamingText, setCurrentStreamingText] = useState('');
  
  const [analyses, setAnalyses] = useState<Record<string, AnalysisResult>>({});
  const [truthData, setTruthData] = useState<{ time: string; score: number }[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null);
  
  const [autoScroll, setAutoScroll] = useState(true);
  
  // Cost Monitoring
  const [totalInputTokens, setTotalInputTokens] = useState(0);
  const [totalOutputTokens, setTotalOutputTokens] = useState(0);
  const [liveAudioSeconds, setLiveAudioSeconds] = useState(0);
  
  const liveTimerRef = useRef<number | null>(null);
  const feedEndRef = useRef<HTMLDivElement>(null);
  const analysisEndRef = useRef<HTMLDivElement>(null);
  const liveControlRef = useRef<LiveConnectionController | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const visualizerStreamRef = useRef<MediaStream | null>(null);
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null);

  // Logging
  const sessionIdRef = useRef<string | null>(null);

  // Scroll to bottom effect
  useEffect(() => {
    if (autoScroll) {
        feedEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [segments, currentStreamingText, autoScroll]);

  useEffect(() => {
    if (autoScroll) {
        analysisEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [analyses, autoScroll]);

  const calculateCost = () => {
    const textCost = (totalInputTokens / 1_000_000 * 0.075) + (totalOutputTokens / 1_000_000 * 0.30);
    const audioCost = liveAudioSeconds * 0.0001; 
    return (textCost + audioCost).toFixed(5);
  };

  // --- CONSUMER: PROCESS QUEUE ---
  useEffect(() => {
    const processQueue = async () => {
        // If busy or empty, do nothing
        if (isProcessing || analysisQueue.length === 0) return;

        setIsProcessing(true);
        const segment = analysisQueue[0]; // Peek

        try {
            // FILTER: Strict Gating (Only analyze substantial segments)
            const trimmedText = segment.text.trim();
            const wordCount = trimmedText.split(/\s+/).length;
            const charCount = trimmedText.length;
            const endsWithPunctuation = /[.?!]$/.test(trimmedText);
            const isSubstantial = charCount > 60 && wordCount >= 8;
            const isComplete = endsWithPunctuation || charCount > 120;

            if (isSubstantial && isComplete) {
                const analysis = await analyzeStatement(segment.text, segment.id);
                
                if (analysis.tokenUsage) {
                    setTotalInputTokens(prev => prev + analysis.tokenUsage!.promptTokens);
                    setTotalOutputTokens(prev => prev + analysis.tokenUsage!.candidatesTokens);
                }

                setAnalyses(prev => ({ ...prev, [segment.id]: analysis }));
                
                // LOGGING: Save to Database
                if (sessionIdRef.current) {
                    loggingService.logAnalysis(sessionIdRef.current, segment, analysis);
                }
                
                let score = 0;
                if (analysis.verdict === VerdictType.TRUE) score = 1;
                else if (analysis.verdict === VerdictType.FALSE) score = -1;
                else if (analysis.verdict === VerdictType.MISLEADING) score = -0.5;
                else if (analysis.verdict === VerdictType.OPINION) score = 0.2;
                
                setTruthData(prev => {
                    const newData = [...prev, { time: new Date().toLocaleTimeString(), score }];
                    if (newData.length > 20) return newData.slice(newData.length - 20);
                    return newData;
                });
            } else {
                console.log("Skipping analysis (too short/incomplete):", segment.id);
            }
        } catch (err) {
            console.error("Processing error", err);
        } finally {
            // Remove from queue regardless of success/failure
            setAnalysisQueue(prev => prev.slice(1));
            setIsProcessing(false);
        }
    };

    processQueue();
  }, [analysisQueue, isProcessing]);


  // --- PRODUCER: HANDLE INCOMING TRANSCRIPTS ---
  // This function must be fast and lightweight.
  const handleTranscriptData = useCallback((data: { text: string; speaker: string; isFinal: boolean }) => {
     if (!data.isFinal) {
         // Update ghost text
         setCurrentStreamingText(data.text);
     } else {
         // Finalize segment
         const newSegment: DebateSegment = {
            id: uuidv4(),
            speaker: data.speaker,
            text: data.text,
            timestamp: Date.now()
         };
         
         // 1. Update UI Feed immediately
         setSegments(prev => [...prev, newSegment]);
         setCurrentStreamingText(''); // Clear ghost text

         // 2. Add to Analysis Queue (Background Processing)
         setAnalysisQueue(prev => [...prev, newSegment]);
     }
  }, []);

  // MANUAL CUT FUNCTION
  const forceCutSegment = () => {
      if (!currentStreamingText.trim()) return;
      
      // 1. Commit current text via handler
      handleTranscriptData({ 
          text: currentStreamingText, 
          speaker: "DEBATER", 
          isFinal: true 
      });
      
      // 2. Flush Service Buffer
      if (liveControlRef.current) {
          liveControlRef.current.flush();
      }
  };

  const startListening = async () => {
    if (inputMode === 'none') return;
    
    // Start Logging Session
    const sid = await loggingService.startSession(inputMode);
    if (sid) sessionIdRef.current = sid;

    setIsListening(true);
    setLiveAudioSeconds(0);
    
    liveTimerRef.current = window.setInterval(() => {
        setLiveAudioSeconds(prev => prev + 1);
    }, 1000);

    try {
        let stream: MediaStream;
        
        if (inputMode === 'mic') {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
            stream = await navigator.mediaDevices.getDisplayMedia({ 
                video: { displaySurface: "browser" }, 
                audio: true,
                preferCurrentTab: false,
            } as any);
        }

        const audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 64; 
        source.connect(analyser);
        
        audioContextRef.current = audioContext;
        analyserRef.current = analyser;
        setAnalyserNode(analyser);
        visualizerStreamRef.current = stream;

        const controller = await connectToLiveDebate(
            stream,
            handleTranscriptData,
            (err) => {
                console.error("Live Error", err);
                stopListening();
                setLiveStatus({ type: 'error', message: "Connection lost. Please retry." });
            },
            (status) => {
                setLiveStatus(status);
            }
        );
        
        liveControlRef.current = controller;

    } catch (err) {
        console.error("Failed to start listening", err);
        setIsListening(false);
        setLiveStatus({ type: 'error', message: "Failed to access audio source." });
        if (liveTimerRef.current) clearInterval(liveTimerRef.current);
    }
  };

  const stopListening = async () => {
      setIsListening(false);
      
      // End Logging Session
      if (sessionIdRef.current) {
          await loggingService.endSession(sessionIdRef.current, calculateCost(), liveAudioSeconds);
          sessionIdRef.current = null;
      }

      if (liveTimerRef.current) clearInterval(liveTimerRef.current);
      
      if (liveControlRef.current) {
          await liveControlRef.current.disconnect();
          liveControlRef.current = null;
      }
      
      if (visualizerStreamRef.current) {
          visualizerStreamRef.current.getTracks().forEach(track => track.stop());
          visualizerStreamRef.current = null;
      }
      
      if (audioContextRef.current) {
          await audioContextRef.current.close();
          audioContextRef.current = null;
      }
      
      setAnalyserNode(null);
      setLiveStatus(null);
      setCurrentStreamingText('');
  };

  const handleManualSubmit = (e: React.FormEvent) => {
      e.preventDefault();
      if (!inputText.trim()) return;
      handleTranscriptData({ text: inputText, speaker: "MANUAL_INPUT", isFinal: true });
      setInputText('');
  };

  const toggleListening = () => {
      if (isListening) {
          stopListening();
      } else {
          startListening();
      }
  };

  return (
    <div className="min-h-screen bg-[#050a10] text-gray-200 font-sans selection:bg-toxic-green selection:text-black overflow-hidden flex flex-col">
      {/* Header */}
      <header className="border-b border-gray-800 bg-[#0a141f]/80 backdrop-blur-md px-6 py-3 flex items-center justify-between z-50">
        <div className="flex items-center gap-3">
          <Activity className="w-6 h-6 text-toxic-green animate-pulse" />
          <h1 className="text-xl font-mono font-bold tracking-wider text-transparent bg-clip-text bg-gradient-to-r from-toxic-green to-neon-cyan">
            DOSSIÊ_OCULTO
            <span className="text-xs ml-2 text-gray-500 font-normal">REAL-TIME FACT CHECKING</span>
          </h1>
        </div>
        
        <div className="flex items-center gap-6">
            {analysisQueue.length > 0 && (
                <div className="flex items-center gap-2 text-xs font-mono text-neon-cyan animate-pulse bg-neon-cyan/10 px-2 py-1 rounded">
                    <Layers className="w-3 h-3" />
                    <span>QUEUE: {analysisQueue.length} PENDING</span>
                </div>
            )}
            
            <div className="flex items-center gap-2 text-xs font-mono text-gray-400 bg-black/30 px-3 py-1 rounded border border-gray-800">
                <DollarSign className="w-3 h-3 text-toxic-green" />
                <span>SESSION_COST: ${calculateCost()}</span>
            </div>
            <div className="flex items-center gap-2 text-xs font-mono text-gray-400">
                <div className={`w-2 h-2 rounded-full ${liveStatus?.type === 'error' ? 'bg-alert-red' : liveStatus ? 'bg-yellow-500' : isListening ? 'bg-toxic-green' : 'bg-gray-600'} ${isListening && 'animate-pulse'}`} />
                <span>{liveStatus?.message || (isListening ? "SYSTEM_ACTIVE" : "SYSTEM_IDLE")}</span>
            </div>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        {/* Left Panel: Controls & Visualizer */}
        <div className="w-80 border-r border-gray-800 bg-[#0a141f]/50 flex flex-col p-4 gap-4">
            {/* Input Source Selector */}
            <div className="bg-black/40 border border-gray-800 rounded p-4">
                <h3 className="text-xs font-mono text-gray-500 mb-3 uppercase tracking-widest flex items-center gap-2">
                    <Sliders className="w-3 h-3" /> Input Source
                </h3>
                <div className="space-y-2">
                    <button 
                        onClick={() => {
                            if(isListening) stopListening();
                            setInputMode('mic');
                        }}
                        className={`w-full flex items-center gap-3 px-3 py-2 rounded text-sm transition-all ${inputMode === 'mic' ? 'bg-toxic-green/10 text-toxic-green border border-toxic-green/50' : 'bg-gray-900 text-gray-400 border border-transparent hover:bg-gray-800'}`}
                    >
                        <Mic className="w-4 h-4" />
                        <span>Microphone</span>
                    </button>
                    <button 
                        onClick={() => {
                            if(isListening) stopListening();
                            setInputMode('tab');
                        }}
                        className={`w-full flex items-center gap-3 px-3 py-2 rounded text-sm transition-all ${inputMode === 'tab' ? 'bg-neon-cyan/10 text-neon-cyan border border-neon-cyan/50' : 'bg-gray-900 text-gray-400 border border-transparent hover:bg-gray-800'}`}
                    >
                        <MonitorPlay className="w-4 h-4" />
                        <span>System/Tab Audio</span>
                    </button>
                </div>

                {inputMode !== 'none' && (
                    <button 
                        onClick={toggleListening}
                        className={`mt-4 w-full flex items-center justify-center gap-2 py-3 rounded font-bold uppercase tracking-wide text-xs transition-all ${isListening ? 'bg-alert-red hover:bg-red-600 text-white shadow-[0_0_15px_rgba(255,0,0,0.4)]' : 'bg-toxic-green hover:bg-green-400 text-black shadow-[0_0_15px_rgba(0,255,136,0.4)]'}`}
                    >
                        {isListening ? (
                            <>
                                <StopCircle className="w-4 h-4" /> Terminate Link
                            </>
                        ) : (
                            <>
                                <Zap className="w-4 h-4" /> Initialize
                            </>
                        )}
                    </button>
                )}
            </div>

            {/* Visualizer */}
            <AudioVisualizer active={isListening} analyser={analyserNode} />

            {/* Truth Chart */}
            <div className="flex-1 bg-black/40 border border-gray-800 rounded relative overflow-hidden">
                <TruthChart data={truthData} />
            </div>
        </div>

        {/* Center: Live Feed */}
        <div className="flex-1 flex flex-col bg-[#050a10] relative">
            <div className="absolute top-0 left-0 right-0 h-16 bg-gradient-to-b from-[#050a10] to-transparent z-10 pointer-events-none" />
            
            <div className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-thin scrollbar-thumb-gray-800 scrollbar-track-transparent">
                {segments.length === 0 && !currentStreamingText && (
                    <div className="h-full flex flex-col items-center justify-center text-gray-600 opacity-50">
                        <Radio className="w-16 h-16 mb-4 animate-pulse" />
                        <p className="font-mono text-sm tracking-widest">AWAITING SIGNAL INPUT...</p>
                    </div>
                )}
                
                {segments.map(segment => (
                    <div key={segment.id} className="group relative pl-4 border-l border-gray-800 hover:border-gray-600 transition-colors">
                        <div className="absolute -left-[5px] top-0 w-2 h-2 rounded-full bg-gray-800 group-hover:bg-toxic-green transition-colors" />
                        <div className="flex items-center gap-2 mb-1">
                            <span className="text-[10px] font-mono text-gray-500">{new Date(segment.timestamp).toLocaleTimeString()}</span>
                            <span className={`text-xs font-bold uppercase tracking-wide ${segment.speaker.includes('1') || segment.speaker.includes('A') ? 'text-neon-cyan' : 'text-toxic-green'}`}>
                                {segment.speaker}
                            </span>
                        </div>
                        <p className="text-lg text-gray-200 font-light leading-relaxed">{segment.text}</p>
                        
                        {!analyses[segment.id] && 
                             (segment.text.length > 60 && segment.text.split(/\s+/).length >= 8 && (/[.?!]$/.test(segment.text.trim()) || segment.text.length > 120)) && (
                            <div className="mt-2 flex items-center gap-2 text-neon-cyan text-xs font-mono animate-pulse">
                                <Cpu className="w-3 h-3" />
                                {analysisQueue.some(s => s.id === segment.id) || isProcessing ? "QUEUED FOR ANALYSIS..." : "ANALYZING PATTERNS..."}
                            </div>
                        )}
                    </div>
                ))}
                
                {/* GHOST TEXT (Streaming) */}
                {currentStreamingText && (
                    <div className="group relative pl-4 border-l border-toxic-green/50">
                         <div className="absolute -left-[5px] top-0 w-2 h-2 rounded-full bg-toxic-green animate-pulse" />
                         <div className="flex items-center gap-2 mb-1">
                             <span className="text-xs font-bold uppercase tracking-wide text-toxic-green flex items-center gap-2 animate-pulse [text-shadow:0_0_10px_#00ff88]">
                                DEBATER
                                <span className="ml-1 text-[10px] bg-toxic-green/20 px-1 rounded text-toxic-green border border-toxic-green/30">LIVE</span>
                             </span>
                             {/* FORCE CUT BUTTON */}
                             <button 
                                onClick={forceCutSegment}
                                className="ml-4 flex items-center gap-1 bg-gray-800 hover:bg-gray-700 text-xs px-2 py-1 rounded text-white border border-gray-600 transition-colors"
                             >
                                <Scissors className="w-3 h-3" />
                                CUT NOW
                             </button>
                         </div>
                         <p className="text-lg text-toxic-green/70 font-light leading-relaxed font-mono">
                            {currentStreamingText}
                            <span className="inline-block w-2 h-4 bg-toxic-green ml-1 animate-pulse" />
                         </p>
                    </div>
                )}
                
                <div ref={feedEndRef} />
            </div>

            {/* Manual Input Area */}
            <div className="p-4 border-t border-gray-800 bg-[#0a141f]">
                <form onSubmit={handleManualSubmit} className="flex gap-2">
                    <input 
                        type="text" 
                        value={inputText}
                        onChange={e => setInputText(e.target.value)}
                        placeholder="Manual override injection..."
                        className="flex-1 bg-black/50 border border-gray-700 rounded px-4 py-2 text-sm text-white focus:outline-none focus:border-toxic-green transition-colors font-mono"
                    />
                    <button 
                        type="submit"
                        disabled={!inputText.trim()}
                        className="bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white p-2 rounded transition-colors"
                    >
                        <Send className="w-4 h-4" />
                    </button>
                </form>
            </div>
        </div>

        {/* Right Panel: Analysis Stream */}
        <div className="w-96 border-l border-gray-800 bg-[#0a141f]/30 flex flex-col">
            <div className="p-4 border-b border-gray-800 flex items-center justify-between">
                <h2 className="font-mono text-sm font-bold text-gray-400 uppercase tracking-widest flex items-center gap-2">
                    <Database className="w-4 h-4" /> Analysis Log
                </h2>
                <div className="flex items-center gap-2">
                    <label className="text-[10px] text-gray-500 uppercase cursor-pointer flex items-center gap-1">
                        <input 
                            type="checkbox" 
                            checked={autoScroll} 
                            onChange={e => setAutoScroll(e.target.checked)}
                            className="accent-toxic-green"
                        />
                        Auto-Scroll
                    </label>
                </div>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 scrollbar-thin scrollbar-thumb-gray-800 scrollbar-track-transparent">
                 {Object.values(analyses).length === 0 ? (
                     <div className="mt-20 text-center">
                         <p className="text-gray-600 font-mono text-xs">NO ANOMALIES DETECTED</p>
                     </div>
                 ) : (
                     Object.values(analyses).map((analysis: AnalysisResult, idx) => (
                         <AnalysisCard 
                            key={idx} 
                            analysis={analysis} 
                            segmentText={segments.find(s => s.id === analysis.segmentId)?.text || "Unknown Segment"}
                         />
                     ))
                 )}
                 <div ref={analysisEndRef} />
            </div>
        </div>
      </main>
    </div>
  );
};

export default App;
