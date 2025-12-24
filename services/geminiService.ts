import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { AnalysisResult, VerdictType } from "../types";

const MODEL_NAME = "gemini-2.0-flash-exp";
const LIVE_MODEL_NAME = "gemini-2.0-flash-exp";

// --- TIPOS E ESTADOS ---

export type LiveStatus = {
  type: 'info' | 'warning' | 'error';
  message: string;
};

type ConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING';

export interface LiveConnectionController {
    disconnect: () => Promise<void>;
}

// --- AUDIO WORKLET CODE (INLINE) ---
// Este código roda em uma thread separada da UI (Audio Thread).
// Ele converte 44.1/48kHz para 16kHz PCM Int16 e faz buffer.
const PCM_PROCESSOR_CODE = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(2048); // Buffer interno menor
    this.bufferIndex = 0;
    this.targetRate = 16000;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    
    const inputChannel = input[0]; // Mono
    const inputRate = sampleRate; // Global do WorkletScope
    
    // Razão de Downsample (ex: 48000 / 16000 = 3)
    // Usamos decimação simples para performance (funciona bem para fala)
    const step = inputRate / this.targetRate;
    
    let sourceIndex = 0;
    
    // Processamento por bloco (128 frames padrão do WebAudio)
    // Precisamos acumular pois 128 frames a 48k não enchem um buffer útil de 16k
    while (sourceIndex < inputChannel.length) {
       const val = inputChannel[Math.floor(sourceIndex)];
       
       // Conversão Float32 -> Int16 PCM
       const s = Math.max(-1, Math.min(1, val));
       const pcm = s < 0 ? s * 0x8000 : s * 0x7FFF;
       
       // Envia quando encher o buffer interno (reduz spam de mensagens para main thread)
       if (this.bufferIndex >= this.buffer.length) {
           this.port.postMessage(this.buffer.slice(0, this.bufferIndex));
           this.bufferIndex = 0;
       }
       
       this.buffer[this.bufferIndex++] = pcm;
       sourceIndex += step;
    }

    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
`;

// --- UTILS ---

const cleanTranscriptText = (text: string): string => {
  if (!text) return "";
  return text.replace(/\s+/g, ' ').trim();
};

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

// --- FACT CHECKING (Mantido) ---
export const analyzeStatement = async (
  text: string,
  segmentId: string,
  contextHistory: string[] = [] 
): Promise<AnalysisResult> => {
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
  if (!apiKey) throw new Error("API Key is missing");
  const ai = new GoogleGenAI({ apiKey });
  
  try {
    const prompt = `
      CONTEXTO: Checagem de fatos (Brasil).
      CONTEXTO ANTERIOR: ${contextHistory.join(" | ")}
      FRASE: "${text}"
      TAREFA: Classificar e verificar.
      Retorne JSON: { verdict: "TRUE"|"FALSE"|"MISLEADING"|"OPINION", explanation: "...", confidence: 0.9 }
    `;

    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
      },
    });

    const jsonText = response.text || "{}"; 
    const data = JSON.parse(jsonText);
    const sources = response.candidates?.[0]?.groundingMetadata?.groundingChunks
      ?.map((chunk: any) => chunk.web)
      .filter((web: any) => web && web.uri && web.title) || [];

    return {
      segmentId,
      verdict: data.verdict as VerdictType || VerdictType.UNVERIFIABLE,
      confidence: data.confidence || 0,
      explanation: data.explanation || "Sem análise",
      counterEvidence: data.counterEvidence,
      sources: sources,
      sentimentScore: data.sentimentScore || 0,
      logicalFallacies: data.logicalFallacies || [],
      context: contextHistory,
      tokenUsage: {
          promptTokens: response.usageMetadata?.promptTokenCount || 0,
          responseTokens: response.usageMetadata?.candidatesTokenCount || 0,
          totalTokens: response.usageMetadata?.totalTokenCount || 0
      }
    };
  } catch (error) {
    console.error("Erro análise:", error);
    return {
      segmentId,
      verdict: VerdictType.UNVERIFIABLE,
      confidence: 0,
      explanation: "Erro técnico.",
      sources: [],
      sentimentScore: 0,
      logicalFallacies: [],
      context: [],
    };
  }
};

// --- CORE LIVE CONNECTION ---

export const connectToLiveDebate = async (
  originalStream: MediaStream,
  onTranscript: (data: { text: string; speaker: string; isFinal: boolean }) => void,
  onError: (err: Error) => void,
  onStatus?: (status: LiveStatus) => void
): Promise<LiveConnectionController> => {
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
  if (!apiKey) {
    onError(new Error("API Key missing"));
    return { disconnect: async () => {} };
  }

  // Clona o stream para garantir ciclo de vida independente
  const stream = originalStream.clone();
  const ai = new GoogleGenAI({ apiKey });

  // STATE MACHINE
  let connectionState: ConnectionState = 'DISCONNECTED';
  let shouldMaintainConnection = true;
  
  // Refs para cleanup
  let activeSessionPromise: Promise<any> | null = null;
  let audioContext: AudioContext | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let reconnectTimeout: any = null;

  // --- 1. Audio Setup (Worklet) ---
  const initAudioStack = async () => {
      try {
          audioContext = new AudioContext({ sampleRate: 48000 }); // Força sample rate alto se possível
          if (audioContext.state === 'suspended') await audioContext.resume();

          // Carrega o Worklet via Blob URL
          const blob = new Blob([PCM_PROCESSOR_CODE], { type: "application/javascript" });
          const workletUrl = URL.createObjectURL(blob);
          await audioContext.audioWorklet.addModule(workletUrl);

          sourceNode = audioContext.createMediaStreamSource(stream);
          workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');

          // EVENTO DE DADOS (Chega da Thread de Áudio)
          workletNode.port.onmessage = (event) => {
              // Int16Array buffer
              const pcmInt16 = event.data;
              sendAudioChunk(pcmInt16);
          };

          sourceNode.connect(workletNode);
          workletNode.connect(audioContext.destination); // Necessário para manter o clock ativo em alguns browsers
          
          console.log("🔊 Audio Worklet Initialized");

      } catch (e) {
          console.error("Falha ao iniciar Audio Engine", e);
          onError(e as Error);
      }
  };

  // --- 2. WebSocket Logic (State Guarded) ---
  const sendAudioChunk = (pcmInt16: Int16Array) => {
      // GUARD: Só envia se estiver estritamente CONECTADO
      if (connectionState !== 'CONNECTED' || !activeSessionPromise) return;

      const base64Data = arrayBufferToBase64(pcmInt16.buffer);

      activeSessionPromise.then(async (session) => {
          // Double Check pós-resolução da promise
          if (connectionState !== 'CONNECTED') return;

          try {
              await session.sendRealtimeInput([{ 
                  mimeType: "audio/pcm", // Protocolo lida com rate
                  data: base64Data
              }]);
          } catch (e) {
              // Silently catch send errors during transitions
          }
      });
  };

  const establishConnection = async () => {
    if (!shouldMaintainConnection) return;

    connectionState = 'CONNECTING';
    onStatus?.({ type: 'info', message: "CONECTANDO..." });

    try {
        const sessionPromise = ai.live.connect({
          model: LIVE_MODEL_NAME,
          config: {
            responseModalities: [Modality.AUDIO], // Necessário para estabilidade
            inputAudioTranscription: { model: LIVE_MODEL_NAME }, // Habilita ASR
            systemInstruction: {
                parts: [{ text: "You are a passive transcription system. Your ONLY job is to transcribe the input audio to Portuguese. Do NOT generate audio responses." }]
            },
            speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
            }
          },
          callbacks: {
            onopen: () => {
               console.log("🟢 Conectado (Worklet Mode)");
               connectionState = 'CONNECTED';
               onStatus?.({ type: 'info', message: "ONLINE" });
            },
            onmessage: (msg: LiveServerMessage) => {
               const inputTranscript = msg.serverContent?.inputTranscription?.text;
               const modelText = msg.serverContent?.modelTurn?.parts?.[0]?.text;
               
               if (inputTranscript) handleText(inputTranscript);
               if (modelText) handleText(modelText);
            },
            onclose: (e) => {
               console.log(`🔴 Socket Fechado (${e.code})`);
               connectionState = 'DISCONNECTED';
               
               if (shouldMaintainConnection) {
                   connectionState = 'RECONNECTING';
                   onStatus?.({ type: 'warning', message: "RECONECTANDO..." });
                   reconnectTimeout = setTimeout(establishConnection, 1000); 
               }
            },
            onerror: (err) => {
                console.error("Erro Socket:", err);
                connectionState = 'DISCONNECTED';
            }
          }
        });

        activeSessionPromise = sessionPromise;
        // Catch inicial da promise de conexão
        sessionPromise.catch(() => {
             if (shouldMaintainConnection && connectionState !== 'CONNECTED') {
                 reconnectTimeout = setTimeout(establishConnection, 1000);
             }
        });

    } catch (err) {
        connectionState = 'DISCONNECTED';
        if (shouldMaintainConnection) reconnectTimeout = setTimeout(establishConnection, 1000);
    }
  };

  // Handlers de Texto
  let currentBuffer = "";
  const handleText = (raw: string) => {
      const text = cleanTranscriptText(raw);
      if (text.length > 0) {
          currentBuffer += " " + text;
          onTranscript({ text: currentBuffer.trim(), speaker: "DEBATE", isFinal: false });
          
          if (currentBuffer.length > 80 || text.match(/[.!?]$/)) {
              onTranscript({ text: currentBuffer.trim(), speaker: "DEBATE", isFinal: true });
              currentBuffer = "";
          }
      }
  };

  // INICIALIZAÇÃO
  await initAudioStack(); // Inicia audio engine primeiro
  establishConnection();  // Inicia socket

  // CONTROLLER PÚBLICO
  return {
       disconnect: async () => {
           console.log("🛑 Encerrando Sessão...");
           shouldMaintainConnection = false;
           connectionState = 'DISCONNECTED';
           
           if (reconnectTimeout) clearTimeout(reconnectTimeout);

           // 1. Matar Worklet
           if (workletNode) {
               workletNode.port.onmessage = null;
               workletNode.disconnect();
           }
           if (sourceNode) sourceNode.disconnect();
           if (audioContext && audioContext.state !== 'closed') await audioContext.close();

           // 2. Fechar Socket
           if (activeSessionPromise) {
               try {
                   const session = await activeSessionPromise;
                   await session.close();
               } catch (e) { /* ignore */ }
           }
           
           stream.getTracks().forEach(t => t.stop()); 
       }
    };
}