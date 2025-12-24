import React, { useState, useRef, useEffect } from 'react';
import { Activity, ShieldCheck, AlertTriangle, Info, Play, Square, Trash2 } from 'lucide-react';
import { AnalysisCard } from './components/AnalysisCard';
import { TruthChart } from './components/TruthChart';
import { AudioVisualizer } from './components/AudioVisualizer';
import { connectToLiveDebate, LiveConnectionController, LiveStatus } from './services/geminiService';
import { logAnalysis, logSessionStart, logSessionEnd } from './services/loggingService';
import { AnalysisResult, VerdictType } from './types';

// Função auxiliar para gerar IDs únicos
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
  const scrollRef = useRef<HTMLDivElement>(null);

  // --- EFEITOS DE PERSISTÊNCIA ---

  // 1. Salvar histórico e SessionID sempre que mudarem
  useEffect(() => {
    localStorage.setItem('debate_history', JSON.stringify(analysisHistory));
    localStorage.setItem('debate_session_id', sessionId);
  }, [analysisHistory, sessionId]);

  // 2. Auto-scroll para o final quando novas mensagens chegam
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [analysisHistory, currentTranscript]);

  const handleStart = async () => {
    try {
      // Se for uma nova sessão após limpeza, gera novo ID
      if (!localStorage.getItem('debate_session_id')) {
          const newId = generateId();
          setSessionId(newId);
          await logSessionStart(newId);
      } else {
          // Retoma sessão existente (opcional: logar "resume")
          console.log("Retomando sessão:", sessionId);
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

      // Listener para quando o usuário para o compartilhamento pela barra do navegador
      stream.getVideoTracks()[0].onended = () => {
        handleStop();
      };

      const connection = await connectToLiveDebate(
        stream,
        (transcriptData) => {
          if (transcriptData.isFinal) {
            // Texto finalizado: processa e limpa o buffer visual
            processConfirmedSegment(transcriptData.text);
            setCurrentTranscript(""); 
          } else {
            // Texto em tempo real: atualiza buffer visual
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
      setStatus({ type: 'error', message: 'Falha ao capturar áudio. Verifique permissões.' });
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
    
    // Não limpamos o sessionID aqui para permitir refresh e continuação.
    // A limpeza é feita apenas no botão "Limpar".
    await logSessionEnd(sessionId);
  };

  const handleClearSession = () => {
      if (confirm("Tem certeza? Isso apagará todo o histórico do debate atual.")) {
          setAnalysisHistory([]);
          setCurrentTranscript("");
          const newSessionId = generateId();
          setSessionId(newSessionId);
          localStorage.removeItem('debate_history');
          localStorage.setItem('debate_session_id', newSessionId);
          setStatus({ type: 'info', message: 'Histórico limpo. Nova sessão iniciada.' });
      }
  };

  // Processa o texto confirmado vindo do Gemini
  const processConfirmedSegment = async (text: string) => {
    if (!text || text.trim().length < 5) return;

    // Cria um item temporário de análise
    const newItem: AnalysisResult = {
      segmentId: generateId(),
      verdict: VerdictType.UNVERIFIABLE, // Placeholder enquanto analisa
      confidence: 0,
      explanation: "Analisando em tempo real...",
      sources: [],
      sentimentScore: 0,
      logicalFallacies: [],
      context: [text] // O texto em si é o contexto imediato
    };

    setAnalysisHistory(prev => [...prev, newItem]);

    // Envia para o backend para análise real
    // Aqui usamos a função `analyzeStatement` que já existe no geminiService,
    // mas chamamos ela indiretamente ou supomos que a conexão Live já traz a análise.
    // *NOTA*: Como o Gemini Live Bidi pode retornar texto e audio, mas a checagem profunda
    // requer o modelo Flash Thinking ou Search, o ideal seria ter uma chamada paralela aqui.
    
    // Para simplificar e manter a estrutura atual: 
    // Vamos simular a chamada de análise ou usar a existente se você tiver importado.
    // (Assumindo que a lógica de "Analysis" está dentro do connectToLiveDebate ou separada).
    
    // *Se você não tiver a lógica de análise automática vindo do socket, adicione aqui:*
    // analyzeStatement(text, newItem.segmentId, ...).then(updatedResult => { ...updateState... })
    
    // Log no banco
    logAnalysis(sessionId, newItem.segmentId, text, newItem);
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 font-sans selection:bg-blue-500 selection:text-white">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-950/50 backdrop-blur-md sticky top-0 z-10">
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
              <p className="text-xs text-slate-400 font-medium">IA Fact-Checking em Tempo Real</p>
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
                Iniciar Monitoramento
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

            {/* Botão de Limpar Histórico */}
            <button
                onClick={handleClearSession}
                className="p-2 text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded-lg transition-colors"
                title="Limpar Histórico e Reiniciar Sessão"
            >
                <Trash2 className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Coluna Esquerda: Transcrição e Estatísticas */}
        <div className="lg:col-span-4 space-y-6">
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

          {/* Transcrição em Tempo Real */}
          <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4 h-[300px] flex flex-col shadow-sm">
            <h2 className="text-sm font-semibold text-slate-400 mb-3 flex items-center gap-2">
              <Info className="w-4 h-4" />
              Transcrição ao Vivo
            </h2>
            <div className="flex-1 overflow-y-auto space-y-2 pr-2 font-mono text-sm leading-relaxed scrollbar-thin scrollbar-thumb-slate-600 scrollbar-track-transparent">
               {analysisHistory.slice(-3).map((item, i) => (
                   <p key={i} className="text-slate-400 opacity-60">{item.context?.[0]}</p>
               ))}
               <p className="text-blue-300 animate-pulse">{currentTranscript}</p>
            </div>
          </div>
        </div>

        {/* Coluna Direita: Feed de Verificações */}
        <div className="lg:col-span-8 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-200">Feed de Análise</h2>
            <span className="text-xs text-slate-500 bg-slate-900 px-2 py-1 rounded border border-slate-800">
              {analysisHistory.length} verificações
            </span>
          </div>
          
          <div 
            ref={scrollRef}
            className="h-[calc(100vh-12rem)] overflow-y-auto pr-2 space-y-4 scroll-smooth scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent pb-10"
          >
            {analysisHistory.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-slate-500 gap-4 border-2 border-dashed border-slate-800 rounded-xl">
                <AlertTriangle className="w-12 h-12 opacity-20" />
                <p>Aguardando início do debate...</p>
              </div>
            ) : (
              analysisHistory.map((analysis) => (
                <AnalysisCard key={analysis.segmentId} result={analysis} />
              ))
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
