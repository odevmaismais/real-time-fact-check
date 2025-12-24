import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { AnalysisResult, VerdictType } from "../types";

const MODEL_NAME = "gemini-2.0-flash-exp";
const LIVE_MODEL_NAME = "gemini-2.0-flash-exp";

export type LiveStatus = {
  type: 'info' | 'warning' | 'error';
  message: string;
};

// --- UTILS ---

const cleanTranscriptText = (text: string): string => {
  if (!text) return "";
  return text.replace(/\s+/g, ' ').trim();
};

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    const chunkSize = 0x8000; 
    for (let i = 0; i < len; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
        binary += String.fromCharCode.apply(null, Array.from(chunk));
    }
    return btoa(binary);
}

// -------------------------------------------
// FACT CHECKING
// -------------------------------------------

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

    const jsonText = response.text; 
    if (!jsonText) return {
      segmentId,
      verdict: VerdictType.UNVERIFIABLE,
      confidence: 0,
      explanation: "Sem resposta da IA",
      sources: [],
      sentimentScore: 0,
    };

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
      sentimentScore: 0,
      logicalFallacies: [],
      context: contextHistory
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
    };
  }
};

// -------------------------------------------
// CONEXÃO LIVE (STREAMING)
// -------------------------------------------

export interface LiveConnectionController {
    disconnect: () => Promise<void>;
    flush: () => void;
}

export const connectToLiveDebate = async (
  stream: MediaStream,
  onTranscript: (data: { text: string; speaker: string; isFinal: boolean }) => void,
  onError: (err: Error) => void,
  onStatus?: (status: LiveStatus) => void
): Promise<LiveConnectionController> => {
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
  if (!apiKey) {
    onError(new Error("API Key missing"));
    return { disconnect: async () => {}, flush: () => {} };
  }
  
  const ai = new GoogleGenAI({ apiKey });
  
  // Usar AudioContext sem sampleRate fixo (deixa o navegador decidir, geralmente 44.1k ou 48k)
  // Isso evita overhead de processamento no JS
  const audioContext = new AudioContext(); 
  if (audioContext.state === 'suspended') await audioContext.resume();

  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const gain = audioContext.createGain();
  gain.gain.value = 0; 
  
  let currentBuffer = "";
  let isConnected = false;
  let activeSession: any = null;
  
  // Buffer Acumulador para estabilidade de rede
  let audioAccumulator: Float32Array = new Float32Array(0);
  const CHUNK_THRESHOLD = 2; // Acumula 2 chunks antes de enviar
  let chunkCounter = 0;

  const handleText = (raw: string) => {
      const text = cleanTranscriptText(raw);
      if (text.length > 0) {
          console.log("📝 RECEBIDO:", text);
          currentBuffer += " " + text;
          onTranscript({ text: currentBuffer.trim(), speaker: "DEBATE", isFinal: false });
          
          if (currentBuffer.length > 80 || text.match(/[.!?]$/)) {
              onTranscript({ text: currentBuffer.trim(), speaker: "DEBATE", isFinal: true });
              currentBuffer = "";
          }
      }
  };

  try {
    const streamRate = audioContext.sampleRate;
    console.log(`🎤 Iniciando Stream: ${streamRate}Hz (Nativo)`);

    activeSession = await ai.live.connect({
      model: LIVE_MODEL_NAME,
      config: {
        // AUDIO mantém a conexão aberta esperando "conversa"
        responseModalities: [Modality.AUDIO], 
        
        // Ativa o eco do usuário (nossa principal fonte de transcrição)
        // @ts-ignore
        inputAudioTranscription: {}, 
        
        systemInstruction: {
            // Instrução "Echo Bot" - Repetir o que ouve força o modelo a processar o texto
            parts: [{ text: "Repita EXATAMENTE o que você ouvir em Português. Não traduza. Não responda. Apenas repita." }]
        }
      },
      callbacks: {
        onopen: () => {
           console.log("🟢 Conectado!");
           isConnected = true;
           onStatus?.({ type: 'info', message: "ESCUTANDO..." });
        },
        onmessage: (msg: LiveServerMessage) => {
           // 1. Fonte Primária: O que o modelo "entendeu" do áudio (User Echo)
           const t1 = msg.serverContent?.inputTranscription?.text;
           // 2. Fonte Secundária: O que o modelo "vai repetir" (Model Response)
           const t2 = msg.serverContent?.modelTurn?.parts?.[0]?.text;
           
           if (t1) handleText(t1);
           if (t2) handleText(t2);
           
           if (msg.serverContent?.turnComplete && currentBuffer) {
               onTranscript({ text: currentBuffer.trim(), speaker: "DEBATE", isFinal: true });
               currentBuffer = "";
           }
        },
        onclose: (e) => {
           console.log("🔴 Fechado:", e);
           if(isConnected) onStatus?.({ type: 'warning', message: "DESCONECTADO" });
           isConnected = false;
        },
        onerror: (err) => {
           console.error("🔴 Erro:", err);
           onStatus?.({ type: 'error', message: "ERRO DE STREAM" });
        }
      }
    });

    isConnected = true;

    processor.onaudioprocess = async (e) => {
      if (!isConnected || !activeSession) return; 

      const inputData = e.inputBuffer.getChannelData(0);
      
      // Boost de Volume (3x) - Menos agressivo, mas suficiente
      const boosted = new Float32Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
          boosted[i] = inputData[i] * 3.0;
      }

      const temp = new Float32Array(audioAccumulator.length + boosted.length);
      temp.set(audioAccumulator);
      temp.set(boosted, audioAccumulator.length);
      audioAccumulator = temp;
      chunkCounter++;

      if (chunkCounter >= CHUNK_THRESHOLD) {
          try {
              // ENVIO NA TAXA NATIVA (SEM DOWNSAMPLE)
              // O Gemini 2.0 Flash lida bem com 48kHz se o cabeçalho estiver certo.
              const base64Data = arrayBufferToBase64(audioAccumulator.buffer as ArrayBuffer);

              await activeSession.sendRealtimeInput([{ 
                  mimeType: `audio/pcm;rate=${streamRate}`,
                  data: base64Data
              }]);
          } catch (err) {
              // Ignora erros de rede
          } finally {
              audioAccumulator = new Float32Array(0);
              chunkCounter = 0;
          }
      }
    };

    source.connect(processor);
    processor.connect(gain);
    gain.connect(audioContext.destination);

    return {
       disconnect: async () => {
           isConnected = false;
           source.disconnect();
           processor.disconnect();
           gain.disconnect();
           if (activeSession) activeSession.close();
           if (audioContext.state !== 'closed') await audioContext.close();
       },
       flush: () => { currentBuffer = ""; }
    };
  } catch (err: any) {
    onError(err);
    return { disconnect: async () => {}, flush: () => {} };
  }
}