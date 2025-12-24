import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { AnalysisResult, VerdictType } from "../types";

const MODEL_NAME = "gemini-2.0-flash-exp";
// CORREÇÃO CRÍTICA: O prefixo 'models/' é necessário para estabilidade em algumas versões da lib
const LIVE_MODEL_NAME = "models/gemini-2.0-flash-exp";

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
// Usando a versão que VOCÊ confirmou que funciona (Box Filter + Tanh)
// Isso garante que o áudio tenha volume suficiente para o VAD do Gemini.
const PCM_PROCESSOR_CODE = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(4096); 
    this.bufferIndex = 0;
    this.targetRate = 16000;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    
    const inputChannel = input[0];
    // sampleRate é global no escopo do Worklet
    const ratio = sampleRate / this.targetRate;
    let inputIndex = 0;
    
    while (inputIndex < inputChannel.length) {
        let sum = 0;
        let count = 0;
        
        // Downsampling com Média (Box Filter)
        const start = Math.floor(inputIndex);
        const end = Math.min(inputChannel.length, Math.floor(inputIndex + ratio));
        
        for (let i = start; i < end; i++) {
            sum += inputChannel[i];
            count++;
        }
        
        if (count === 0 && start < inputChannel.length) {
            sum = inputChannel[start];
            count = 1;
        }

        const avg = count > 0 ? sum / count : 0;
        
        // BOOST INTELIGENTE (Math.tanh)
        // Aumenta o volume sem distorcer. Essencial para o Gemini não ignorar o áudio.
        const boosted = Math.tanh(avg * 2.5); 
        
        const pcm = boosted < 0 ? boosted * 0x8000 : boosted * 0x7FFF;
        
        if (this.bufferIndex >= this.buffer.length) {
            this.port.postMessage(this.buffer.slice(0, this.bufferIndex));
            this.bufferIndex = 0;
        }
        
        this.buffer[this.bufferIndex++] = pcm;
        inputIndex += ratio;
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
`;

// --- UTILS ---

// ATENÇÃO: Use apenas para formatar o texto final para a UI ou para o Prompt de Análise.
// NÃO use no stream de entrada, pois remove espaços que colam as palavras.
const cleanTranscriptText = (text: string): string => {
  if (!text) return "";
  return text.replace(/\s+/g, ' ').trim();
};

function arrayBufferToBase64(buffer: ArrayBuffer | SharedArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

// --- FACT CHECKING (CORRIGIDO ERRO JSON) ---
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

    // --- CORREÇÃO DE SYNTAX ERROR ---
    // O Gemini às vezes envia Markdown (```json ... ```) mesmo pedindo JSON.
    let jsonText = response.text || "{}";
    jsonText = jsonText.replace(/```json/g, "").replace(/```/g, "").trim();

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

  const stream = originalStream.clone();
  const ai = new GoogleGenAI({ apiKey });

  let connectionState: ConnectionState = 'DISCONNECTED';
  let shouldMaintainConnection = true;
  
  let activeSessionPromise: Promise<any> | null = null;
  let audioContext: AudioContext | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let reconnectTimeout: any = null;

  const initAudioStack = async () => {
      try {
          audioContext = new AudioContext(); 
          if (audioContext.state === 'suspended') await audioContext.resume();

          console.log(`🔊 AudioContext: ${audioContext.sampleRate}Hz (Volume Boost: ON)`);

          const blob = new Blob([PCM_PROCESSOR_CODE], { type: "application/javascript" });
          const workletUrl = URL.createObjectURL(blob);
          await audioContext.audioWorklet.addModule(workletUrl);

          sourceNode = audioContext.createMediaStreamSource(stream);
          workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');

          workletNode.port.onmessage = (event) => {
              if (connectionState === 'CONNECTED') {
                  const pcmInt16 = event.data;
                  sendAudioChunk(pcmInt16);
              }
          };

          sourceNode.connect(workletNode);
          workletNode.connect(audioContext.destination); 
          
          console.log("🔊 Worklet Pronto");

      } catch (e) {
          console.error("Audio Init Error:", e);
          onError(e as Error);
      }
  };

  const sendAudioChunk = (pcmInt16: Int16Array) => {
      if (connectionState !== 'CONNECTED' || !activeSessionPromise) return;

      const base64Data = arrayBufferToBase64(pcmInt16.buffer);

      activeSessionPromise.then(async (session) => {
          if (connectionState !== 'CONNECTED') return;
          try {
              await session.sendRealtimeInput([{ 
                  mimeType: "audio/pcm;rate=16000", 
                  data: base64Data
              }]);
          } catch (e: any) {
              if (e.message && (e.message.includes("CLOSING") || e.message.includes("CLOSED"))) return;
              console.warn("Tx Warning:", e);
          }
      }).catch(() => {});
  };

  const establishConnection = async () => {
    if (!shouldMaintainConnection) return;

    connectionState = 'CONNECTING';
    onStatus?.({ type: 'info', message: "CONECTANDO..." });

    try {
        const sessionPromise = ai.live.connect({
          model: LIVE_MODEL_NAME, // models/gemini-2.0...
          config: {
            // TEXT = Streaming Real-Time sem buffer de turno
            responseModalities: [Modality.TEXT], 
            
            // Input Vazio = Ativa transcrição sem erro 1007
            // @ts-ignore
            inputAudioTranscription: { }, 
            
            systemInstruction: {
                parts: [{ text: "You are a real-time Portuguese transcriber. Output words immediately. Do not format as script." }]
            },
          },
          callbacks: {
            onopen: () => {
               console.log("🟢 Conectado!");
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
               console.log(`🔴 Fechado (${e.code})`);
               connectionState = 'DISCONNECTED';
               
               if (e.code === 1000) {
                   shouldMaintainConnection = false;
                   onStatus?.({ type: 'info', message: "Desconectado" });
                   return;
               }

               if (shouldMaintainConnection) {
                   connectionState = 'RECONNECTING';
                   onStatus?.({ type: 'warning', message: "RECONECTANDO..." });
                   reconnectTimeout = setTimeout(establishConnection, 1000); 
               }
            },
            onerror: (err) => {
                console.error("Socket Error:", err);
                connectionState = 'DISCONNECTED';
            }
          }
        });

        activeSessionPromise = sessionPromise;
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

  // --- CORREÇÃO DO PICOTADO ---
  let currentBuffer = "";
  const handleText = (raw: string) => {
      // Recebe o texto BRUTO (com espaços iniciais se houver).
      // Isso permite que " po" + "lícia" se torne " polícia".
      if (raw) {
          // console.log("📝", `"${raw}"`); // Debug opcional
          currentBuffer += raw; 
          
          // Envia para UI (o trim aqui é visual, não afeta o buffer)
          onTranscript({ text: currentBuffer.trim(), speaker: "DEBATE", isFinal: false });
          
          // Limpa buffer em pontuações fortes para evitar strings infinitas
          if (currentBuffer.length > 200 || raw.match(/[.!?]$/)) {
              onTranscript({ text: currentBuffer.trim(), speaker: "DEBATE", isFinal: true });
              currentBuffer = "";
          }
      }
  };

  await initAudioStack(); 
  establishConnection(); 

  return {
       disconnect: async () => {
           console.log("🛑 Stop...");
           shouldMaintainConnection = false;
           connectionState = 'DISCONNECTED';
           
           if (reconnectTimeout) clearTimeout(reconnectTimeout);

           if (workletNode) {
               workletNode.port.onmessage = null;
               workletNode.disconnect();
           }
           if (sourceNode) sourceNode.disconnect();
           if (audioContext && audioContext.state !== 'closed') await audioContext.close();

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
