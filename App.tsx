import React, { useState, useRef, useEffect } from 'react';
import { Activity, ShieldCheck, AlertTriangle, Info, Play, Square, Trash2 } from 'lucide-react';
import { AnalysisCard } from './components/AnalysisCard';
import { TruthChart } from './components/TruthChart';
import { AudioVisualizer } from './components/AudioVisualizer';
import { connectToLiveDebate, analyzeStatement, LiveConnectionController, LiveStatus } from './services/geminiService'; // Adicionado analyzeStatement
import { logAnalysis, logSessionStart, logSessionEnd } from './services/loggingService';
import { AnalysisResult, VerdictType } from './types';

const generateId = () => Math.random().toString(36).substr(2, 9);

function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [currentTranscript, setCurrentTranscript] = useState("");
  
  // Estado inicial tenta ler do localStorage
  const [analysisHistory, setAnalysisHistory] = useState<AnalysisResult[]>(() => {
    const saved = localStorage.getItem('debate_history');
    return saved ? JSON.parse(saved) : [];
  });
  
  const [status, setStatus] = useState<LiveStatus>({ type: 'info', message: 'Pronto para iniciar' });
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
  const [sessionId, setSessionId] = useState<string>(() => {
     return localStorage.getItem('debate_session_id') || generateId();
  });

  const connectionRef = useRef<LiveConnectionController | null>(null);
  
  // PERSISTÊNCIA
  useEffect(() => {
    localStorage.setItem('debate_history', JSON.stringify(analysisHistory));
    localStorage.setItem('debate_session_id', sessionId);
  }, [analysisHistory, sessionId]);

  const handleStart = async () => {
    try {
      if (!localStorage.getItem('debate_session_id')) {
          const newId = generateId();
          setSessionId(newId);
          await logSessionStart(newId);
      }

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: 1, height: 1 }, 
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000
        },
        systemAudio: 'include' 
      } as any);

      setAudioStream(stream);

      stream.getVideoTracks()[0].onended = () => {
        handleStop();
      };

      const connection = await connectToLiveDebate(
        stream,
        (transcriptData) => {
          if (transcriptData.isFinal) {
            // 1. Processa a frase finalizada
            processConfirmedSegment(transcriptData.text);
            // 2. Limpa o buffer visual IMEDIATAMENTE para evitar duplicidade visual
            setCurrentTranscript(""); 
          } else {
            // Atualiza o texto em tempo real (cinza)
            setCurrentTranscript(transcriptData.text);
          }
        },
        (error) => {
          setStatus({ type: 'error', message: error.message });
          handleStop();
        },
        (newStatus) => setStatus(newStatus)
      );

      connectionRef.current = connection;
      setIsConnected(true);
    } catch (err) {
      console.error(err);
      setStatus({ type: 'error', message: 'Falha ao capturar áudio.' });
    }
  };

  const handleStop = async () => {
    if (connectionRef.current) {
      await connectionRef.current.disconnect();
      connectionRef.current = null;
    }
    if (audioStream) {
      audioStream.getTracks().forEach(track => track.stop());
      setAudioStream(null);
    }
    setIsConnected(false);
    setStatus({ type: 'info', message: 'Sessão finalizada' });
    await logSessionEnd(sessionId);
  };

  const handleClearSession = () => {
      if (confirm("Tem certeza? Isso apagará todo o histórico.")) {
          setAnalysisHistory([]);
          setCurrentTranscript("");
          const newSessionId = generateId();
          setSessionId(newSessionId);
          localStorage.removeItem('debate_history');
          localStorage.setItem('debate_session_id', newSessionId);
          setStatus({ type: 'info', message: 'Histórico limpo.' });
      }
  };

  // --- LÓGICA CORE DE ANÁLISE ---
  const processConfirmedSegment = async (text: string) => {
    if (!text || text.trim().length < 5) return;

    const newSegmentId = generateId();

    // 1. Cria Placeholder (Feedback Imediato na UI)
    // Inserimos no COMEÇO do array ([new, ...old]) para aparecer no topo
    const placeholderItem: AnalysisResult = {
      segmentId: newSegmentId,
      verdict: VerdictType.UNVERIFIABLE,
      confidence: 0,
      explanation: "🔍 Analisando veracidade...",
      sources: [],
      sentimentScore: 0,
      logicalFallacies: [],
      context: [text]
    };

    setAnalysisHistory(prev => [placeholderItem, ...prev]);

    // 2. Dispara a Análise Real em Segundo Plano (Gemini Flash Check)
    // Passamos as últimas 3 frases como contexto para ajudar a IA
    const recentContext = analysisHistory.slice(0, 3).map(h => h.context?.[0] || "");
    
    try {
        const analysisResult = await analyzeStatement(text, newSegmentId, recentContext);
        
        // 3. Atualiza o Card com o Resultado Real
        setAnalysisHistory(prev => prev.map(item => 
            item.segmentId === newSegmentId ? { ...analysisResult, context: [text] } : item
        ));

        // 4. Loga no Banco de Dados
        await logAnalysis(sessionId, newSegmentId, text, analysisResult);

    } catch (error) {
        console.error("Erro na verificação:", error);
        // Em caso de erro, atualiza para mostrar falha, não fica "analisando" pra sempre
        setAnalysisHistory(prev => prev.map(item => 
            item.segmentId === newSegmentId ? { 
                ...item, 
                explanation: "Falha técnica ao verificar este trecho." 
            } : item
        ));
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 font-sans selection:bg-blue-500 selection:text-white">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-950/50 backdrop-blur-md sticky top-0 z-50">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative">
              <ShieldCheck className="w-8 h-8 text-blue-500" />
              {isConnected && (
                <span className="absolute -top-1 -right-1 w-3 h-3 bg-green-500 rounded-full animate-pulse shadow-[0_0_10px_rgba(34,197,94,0.5)]" />
              )}
            </div>
            <div>
              <h1 className="font-bold text-xl tracking-tight">Veritas<span className="text-blue-500">Live</span></h1>
              <p className="text-xs text-slate-400 font-medium">Fact-Checking em Tempo Real</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className={`px-3 py-1 rounded-full text-xs font-medium border ${
              status.type === 'error' ? 'bg-red-500/10 border-red-500/20 text-red-400' :
              status.type === 'warning' ? 'bg-yellow-500/10 border-yellow-500/20 text-yellow-400' :
              isConnected ? 'bg-green-500/10 border-green-500/20 text-green-400' :
              'bg-slate-800 border-slate-700 text-slate-400'
            }`}>
              {status.message}
            </div>
            
            {!isConnected ? (
              <button
                onClick={handleStart}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-all shadow-lg shadow-blue-900/20 active:scale-95"
              >
                <Play className="w-4 h-4 fill-current" />
                Iniciar
              </button>
            ) : (
              <button
                onClick={handleStop}
                className="flex items-center gap-2 px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded-lg font-medium transition-all"
              >
                <Square className="w-4 h-4 fill-current" />
                Parar
              </button>
            )}

            <button
                onClick={handleClearSession}
                className="p-2 text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded-lg transition-colors"
                title="Limpar Histórico"
            >
                <Trash2 className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Coluna Esquerda: Transcrição e Estatísticas */}
        <div className="lg:col-span-4 space-y-6 h-fit sticky top-24">
          
          {/* Visualizador de Áudio */}
          <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-400 mb-3 flex items-center gap-2">
              <Activity className="w-4 h-4" />
              Sinal de Áudio
            </h2>
            <AudioVisualizer stream={audioStream} isConnected={isConnected} />
          </div>

          {/* Gráfico de Verdade */}
          <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4 shadow-sm">
             <TruthChart history={analysisHistory} />
          </div>

          {/* Transcrição ao Vivo (Invertida: Novo no Topo) */}
          <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4 h-[400px] flex flex-col shadow-sm">
            <h2 className="text-sm font-semibold text-slate-400 mb-3 flex items-center gap-2">
              <Info className="w-4 h-4" />
              Transcrição ao Vivo
            </h2>
            
            <div className="flex-1 overflow-y-auto pr-2 font-mono text-sm leading-relaxed scrollbar-thin scrollbar-thumb-slate-600 scrollbar-track-transparent flex flex-col gap-3">
               {/* 1. Texto atual (Buffer) no TOPO com destaque */}
               {currentTranscript && (
                   <div className="text-blue-300 animate-pulse border-l-2 border-blue-500 pl-2">
                       {currentTranscript}
                   </div>
               )}

               {/* 2. Histórico recente logo abaixo (Do mais novo para o mais velho) */}
               {analysisHistory.slice(0, 10).map((item, i) => (
                   <p key={item.segmentId} className="text-slate-400 opacity-60 border-l-2 border-transparent pl-2 transition-all hover:opacity-100">
                       {item.context?.[0]}
                   </p>
               ))}
            </div>
          </div>
        </div>

        {/* Coluna Direita: Feed de Verificações (Novo no Topo) */}
        <div className="lg:col-span-8 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-200">Feed de Análise</h2>
            <span className="text-xs text-slate-500 bg-slate-900 px-2 py-1 rounded border border-slate-800">
              {analysisHistory.length} verificações
            </span>
          </div>
          
          <div className="min-h-[50vh] space-y-4 pb-10">
            {analysisHistory.length === 0 ? (
              <div className="h-64 flex flex-col items-center justify-center text-slate-500 gap-4 border-2 border-dashed border-slate-800 rounded-xl">
                <AlertTriangle className="w-12 h-12 opacity-20" />
                <p>Aguardando início do debate...</p>
              </div>
            ) : (
              // Mapeia diretamente pois o array já está [Newest, ..., Oldest]
              analysisHistory.map((analysis) => (
                <div key={analysis.segmentId} className="animate-in fade-in slide-in-from-top-4 duration-500">
                    <AnalysisCard result={analysis} />
                </div>
              ))
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
