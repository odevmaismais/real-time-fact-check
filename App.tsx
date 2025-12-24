import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Mic, 
  Activity,  
  Radio, 
  Send, 
  Cpu, 
  Database,
  MonitorPlay,
  StopCircle,
  Zap,
  Scissors,
  AlertOctagon,
  Loader2
} from 'lucide-react';
import { DebateSegment, AnalysisResult, VerdictType } from './types';
import { analyzeStatement, connectToLiveDebate, LiveStatus, LiveConnectionController } from './services/geminiService';
import { AnalysisCard } from './components/AnalysisCard';
import { TruthChart } from './components/TruthChart';
import { AudioVisualizer } from './components/AudioVisualizer';
import { v4 as uuidv4 } from 'uuid';

const App: React.FC = () => {
  const [isListening, setIsListening] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [inputMode, setInputMode] = useState<'mic' | 'tab' | 'none'>('none');
  const [inputText, setInputText] = useState('');
  
  const [segments, setSegments] = useState<DebateSegment[]>([]);
  const [analysisQueue, setAnalysisQueue] = useState<DebateSegment[]>([]);
  const pendingMergeBufferRef = useRef<string>("");
  const [currentStreamingText, setCurrentStreamingText] = useState('');
  const [analyses, setAnalyses] = useState<Record<string, AnalysisResult>>({});
  const [truthData, setTruthData] = useState<{ time: string; score: number }[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null);
  const [isMounted, setIsMounted] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  
  const [totalInputTokens, setTotalInputTokens] = useState(0);
  const [totalOutputTokens, setTotalOutputTokens] = useState(0);
  const [liveAudioSeconds, setLiveAudioSeconds] = useState(0);
  
  const liveTimerRef = useRef<number | null>(null);
  const feedEndRef = useRef<HTMLDivElement>(null);
  const analysisEndRef = useRef<HTMLDivElement>(null);
  
  // Persistência do Serviço
  const liveControlRef = useRef<LiveConnectionController | null>(null);
  
  // Visualização de Áudio (Separada do Stream de envio para performance)
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null);
  const visContextRef = useRef<AudioContext | null>(null);

  useEffect(() => { setIsMounted(true); }, []);

  useEffect(() => {
    if (autoScroll) feedEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [segments, currentStreamingText, autoScroll]);

  useEffect(() => {
    if (autoScroll) analysisEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [analyses, autoScroll]);

  // --- PROCESSING LOOP ---
  useEffect(() => {
    const processQueue = async () => {
        if (isProcessing || analysisQueue.length === 0) return;

        setIsProcessing(true);
        const segment = analysisQueue[0]; 

        try {
            const trimmedText = segment.text.trim();
            const wordCount = trimmedText.split(/\s+/).length;
            const charCount = trimmedText.length;
            const endsWithPunctuation = /[.?!]$/.test(trimmedText);
            const isSubstantial = charCount > 60 && wordCount >= 8;
            const isComplete = endsWithPunctuation || charCount > 120;

            if (isSubstantial && isComplete) {
                const recentHistory = segments
                    .filter(s => s.id !== segment.id)
                    .slice(-3)
                    .map(s => s.text);

                const analysis = await analyzeStatement(segment.text, segment.id, recentHistory);
                
                if (analysis.tokenUsage) {
                    setTotalInputTokens(prev => prev + analysis.tokenUsage!.promptTokens);
                    setTotalOutputTokens(prev => prev + analysis.tokenUsage!.responseTokens);
                }

                setAnalyses(prev => ({ ...prev, [segment.id]: analysis }));
                
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
            }
        } catch (err) {
            console.error("Processing error", err);
        } finally {
            setAnalysisQueue(prev => prev.slice(1));
            setIsProcessing(false);
        }
    };

    processQueue();
  }, [analysisQueue, isProcessing, segments]); 

  const handleTranscriptData = useCallback((data: { text: string; speaker: string; isFinal: boolean }) => {
     if (!data.isFinal) {
         const displayText = pendingMergeBufferRef.current 
             ? `${pendingMergeBufferRef.current} ${data.text}`
             : data.text;
         setCurrentStreamingText(displayText);
     } else {
         const incomingText = data.text.trim();
         let fullText = pendingMergeBufferRef.current 
             ? `${pendingMergeBufferRef.current} ${incomingText}`
             : incomingText;

         const hasTerminalPunctuation = /[.?!]$/.test(fullText);
         const isLongEnough = fullText.length > 80;

         if (!hasTerminalPunctuation && !isLongEnough && fullText.length < 50) {
             pendingMergeBufferRef.current = fullText;
             setCurrentStreamingText(fullText + "..."); 
             return;
         }

         const newSegment: DebateSegment = {
            id: uuidv4(),
            speaker: data.speaker,
            text: fullText,
            timestamp: Date.now()
         };
         
         pendingMergeBufferRef.current = "";
         setSegments(prev => [...prev, newSegment]);
         setCurrentStreamingText(''); 
         setAnalysisQueue(prev => [...prev, newSegment]);
     }
  }, []);

  const forceCutSegment = () => {
      let textToCut = currentStreamingText || pendingMergeBufferRef.current;
      if (!textToCut.trim()) return;
      
      const newSegment: DebateSegment = {
          id: uuidv4(),
          speaker: "DEBATER",
          text: textToCut,
          timestamp: Date.now()
      };

      setSegments(prev => [...prev, newSegment]);
      setAnalysisQueue(prev => [...prev, newSegment]);
      pendingMergeBufferRef.current = "";
      setCurrentStreamingText('');
  };

  const startListening = async () => {
    if (inputMode === 'none' || isConnecting) return;
    
    setIsConnecting(true);
    setLiveAudioSeconds(0);
    
    try {
        let stream: MediaStream;
        try {
            if (inputMode === 'mic') {
                stream = await navigator.mediaDevices.getUserMedia({ 
                    audio: { 
                        channelCount: 1, 
                        echoCancellation: true, 
                        noiseSuppression: true,
                        autoGainControl: true
                    } 
                });
            } else {
                stream = await navigator.mediaDevices.getDisplayMedia({ 
                    video: { displaySurface: "browser" }, 
                    audio: true,
                    preferCurrentTab: false,
                } as any);
                
                if (stream.getAudioTracks().length === 0) {
                     alert("⚠️ ERRO: Marque 'Compartilhar áudio da guia' na janela de seleção.");
                     stream.getTracks().forEach(t => t.stop());
                     throw new Error("No audio track");
                }
            }
        } catch (mediaErr: any) {
            setIsConnecting(false);
            if (mediaErr.name === 'NotAllowedError') throw new Error("Permission denied");
            throw mediaErr;
        }

        // --- VISUALIZER SETUP (Contexto Leve Apenas para UI) ---
        const visContext = new AudioContext();
        const visSource = visContext.createMediaStreamSource(stream);
        const analyser = visContext.createAnalyser();
        analyser.fftSize = 64;
        visSource.connect(analyser);
        visContextRef.current = visContext;
        setAnalyserNode(analyser);

        // --- GEMINI CONNECTION (Worklet Dedicado) ---
        const controller = await connectToLiveDebate(
            stream,
            handleTranscriptData,
            (err) => {
                console.error("Live Error", err);
                setLiveStatus({ type: 'warning', message: "Reconectando..." });
            },
            (status) => setLiveStatus(status)
        );
        liveControlRef.current = controller;
        
        setIsListening(true);
        liveTimerRef.current = window.setInterval(() => {
            setLiveAudioSeconds(prev => prev + 1);
        }, 1000);

    } catch (err: any) {
        console.error("Start error", err);
        setLiveStatus({ type: 'error', message: "Erro de Inicialização" });
    } finally {
        setIsConnecting(false);
    }
  };

  const stopListening = async () => {
      setIsListening(false);
      setIsConnecting(false);

      if (liveTimerRef.current) {
          clearInterval(liveTimerRef.current);
          liveTimerRef.current = null;
      }
      
      // Cleanup Service
      if (liveControlRef.current) {
          await liveControlRef.current.disconnect();
          liveControlRef.current = null;
      }

      // Cleanup Visualizer
      if (visContextRef.current && visContextRef.current.state !== 'closed') {
          await visContextRef.current.close();
          visContextRef.current = null;
      }
      setAnalyserNode(null);

      setLiveStatus(null);
      setCurrentStreamingText('');
      pendingMergeBufferRef.current = "";
  };

  const handleManualSubmit = (e: React.FormEvent) => {
      e.preventDefault();
      if (!inputText.trim()) return;
      handleTranscriptData({ text: inputText, speaker: "MANUAL", isFinal: true });
      setInputText('');
  };

  const toggleListening = () => {
      if (isListening) stopListening();
      else startListening();
  };

  const isApiKeyConfigured = Boolean(process.env.API_KEY);

  return (
    <div className={`min-h-screen bg-[#050a10] text-gray-200 font-sans selection:bg-toxic-green selection:text-black overflow-hidden flex flex-col ${isMounted ? 'opacity-100' : 'opacity-0'}`}>
      <header className="border-b border-gray-800 bg-[#0a141f]/80 px-6 py-3 flex items-center justify-between z-50">
        <div className="flex items-center gap-3">
          <Activity className="w-6 h-6 text-toxic-green" />
          <h1 className="text-xl font-mono font-bold tracking-wider text-transparent bg-clip-text bg-gradient-to-r from-toxic-green to-neon-cyan">
            DOSSIÊ_OCULTO
          </h1>
        </div>
        <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 text-xs font-mono text-gray-400">
                <div className={`w-2 h-2 rounded-full ${liveStatus?.type === 'error' ? 'bg-alert-red' : isListening ? 'bg-toxic-green' : 'bg-gray-600'} ${isListening && 'animate-pulse'}`} />
                <span>{liveStatus?.message || (isListening ? "ATIVO" : isConnecting ? "CONECTANDO..." : "INATIVO")}</span>
            </div>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        <div className="w-80 border-r border-gray-800 bg-[#0a141f]/50 flex flex-col p-4 gap-4">
            <div className="bg-black/40 border border-gray-800 rounded p-4 relative">
                {!isApiKeyConfigured && (
                  <div className="absolute inset-0 bg-black/80 z-20 flex flex-col items-center justify-center p-4 text-center">
                    <AlertOctagon className="w-8 h-8 text-alert-red mb-2" />
                    <p className="text-alert-red font-bold text-xs">API_KEY MISSING</p>
                  </div>
                )}
                <div className="space-y-2">
                    <button 
                        disabled={isListening || isConnecting}
                        onClick={() => setInputMode('mic')} 
                        className={`w-full flex items-center gap-3 px-3 py-2 rounded text-sm transition-all ${inputMode === 'mic' ? 'bg-toxic-green/10 text-toxic-green border-toxic-green/50 border' : 'bg-gray-900 text-gray-400'} disabled:opacity-50 disabled:cursor-not-allowed`}>
                        <Mic className="w-4 h-4" /> <span>Microfone</span>
                    </button>
                    <button 
                        disabled={isListening || isConnecting}
                        onClick={() => setInputMode('tab')} 
                        className={`w-full flex items-center gap-3 px-3 py-2 rounded text-sm transition-all ${inputMode === 'tab' ? 'bg-neon-cyan/10 text-neon-cyan border-neon-cyan/50 border' : 'bg-gray-900 text-gray-400'} disabled:opacity-50 disabled:cursor-not-allowed`}>
                        <MonitorPlay className="w-4 h-4" /> <span>Áudio da Guia</span>
                    </button>
                </div>
                {inputMode !== 'none' && (
                    <button 
                        onClick={toggleListening} 
                        disabled={isConnecting}
                        className={`mt-4 w-full flex items-center justify-center gap-2 py-3 rounded font-bold uppercase tracking-wide text-xs transition-all disabled:opacity-50 disabled:cursor-not-allowed ${isListening ? 'bg-alert-red text-white' : 'bg-toxic-green text-black'}`}>
                        {isConnecting ? (
                            <><Loader2 className="w-4 h-4 animate-spin" /> CONECTANDO...</>
                        ) : isListening ? (
                            <><StopCircle className="w-4 h-4" /> PARAR</>
                        ) : (
                            <><Zap className="w-4 h-4" /> INICIAR</>
                        )}
                    </button>
                )}
            </div>
            <AudioVisualizer active={isListening} analyser={analyserNode} />
            <div className="flex-1 bg-black/40 border border-gray-800 rounded relative overflow-hidden">
                <TruthChart data={truthData} />
            </div>
        </div>

        <div className="flex-1 flex flex-col bg-[#050a10] relative">
            <div className="absolute top-0 left-0 right-0 h-16 bg-gradient-to-b from-[#050a10] to-transparent z-10 pointer-events-none" />
            <div className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-thin scrollbar-thumb-gray-800">
                {segments.length === 0 && !currentStreamingText && (
                    <div className="h-full flex flex-col items-center justify-center text-gray-600 opacity-50">
                        <Radio className="w-16 h-16 mb-4" />
                        <p className="font-mono text-sm tracking-widest">AGUARDANDO ÁUDIO...</p>
                    </div>
                )}
                {segments.map(segment => (
                    <div key={segment.id} className="pl-4 border-l border-gray-800">
                        <div className="flex items-center gap-2 mb-1">
                            <span className="text-[10px] font-mono text-gray-500">{new Date(segment.timestamp).toLocaleTimeString()}</span>
                            <span className="text-xs font-bold uppercase text-toxic-green">{segment.speaker}</span>
                        </div>
                        <p className="text-lg text-gray-200 font-light">{segment.text}</p>
                        {!analyses[segment.id] && (segment.text.length > 50) && (
                            <div className="mt-2 flex items-center gap-2 text-neon-cyan text-xs font-mono animate-pulse">
                                <Cpu className="w-3 h-3" /> ANALISANDO...
                            </div>
                        )}
                    </div>
                ))}
                {currentStreamingText && (
                    <div className="pl-4 border-l border-toxic-green/50">
                         <div className="flex items-center gap-2 mb-1">
                             <span className="text-xs font-bold uppercase text-toxic-green animate-pulse">LIVE</span>
                             <button onClick={forceCutSegment} className="ml-4 flex items-center gap-1 bg-gray-800 text-xs px-2 py-1 rounded text-white border border-gray-600">
                                <Scissors className="w-3 h-3" /> CUT
                             </button>
                         </div>
                         <p className="text-lg text-toxic-green/70 font-mono">{currentStreamingText}</p>
                    </div>
                )}
                <div ref={feedEndRef} />
            </div>
            <div className="p-4 border-t border-gray-800 bg-[#0a141f]">
                <form onSubmit={handleManualSubmit} className="flex gap-2">
                    <input type="text" value={inputText} onChange={e => setInputText(e.target.value)} placeholder="Inserir texto manual..." className="flex-1 bg-black/50 border border-gray-700 rounded px-4 py-2 text-sm text-white" />
                    <button type="submit" disabled={!inputText.trim()} className="bg-gray-800 text-white p-2 rounded"><Send className="w-4 h-4" /></button>
                </form>
            </div>
        </div>

        <div className="w-96 border-l border-gray-800 bg-[#0a141f]/30 flex flex-col">
            <div className="p-4 border-b border-gray-800 flex items-center justify-between">
                <h2 className="font-mono text-sm font-bold text-gray-400 uppercase tracking-widest gap-2 flex"><Database className="w-4 h-4" /> ANÁLISE</h2>
                <label className="text-[10px] text-gray-500 uppercase cursor-pointer flex items-center gap-1">
                    <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} className="accent-toxic-green" /> Scroll
                </label>
            </div>
            <div className="flex-1 overflow-y-auto p-4 scrollbar-thin scrollbar-thumb-gray-800">
                 {Object.values(analyses).map((analysis: AnalysisResult, idx) => (
                     <AnalysisCard key={idx} analysis={analysis} segmentText={segments.find(s => s.id === analysis.segmentId)?.text || ""} />
                 ))}
                 <div ref={analysisEndRef} />
            </div>
        </div>
      </main>
    </div>
  );
};

export default App;