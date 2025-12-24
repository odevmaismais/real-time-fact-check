import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { AnalysisResult, VerdictType } from "../types";

const MODEL_NAME = "gemini-2.0-flash-exp";
const LIVE_MODEL_NAME = "gemini-2.0-flash-exp";

export type LiveStatus = {
  type: 'info' | 'warning' | 'error';
  message: string;
};

// --- UTILS DE ÁUDIO (MATEMÁTICA PURA) ---

const cleanTranscriptText = (text: string): string => {
  if (!text) return "";
  return text.replace(/\s+/g, ' ').trim();
};

/**
 * Converte Float32 (Navegador) para Int16 (PCM) E faz o Downsample para 16kHz.
 * Isso é crucial para que o Gemini entenda a velocidade da fala.
 */
function downsampleAndConvertToPCM(input: Float32Array, inputRate: number): ArrayBuffer {
    const targetRate = 16000;
    
    // Se já for 16k, apenas converte
    if (inputRate === targetRate) {
        const buffer = new ArrayBuffer(input.length * 2);
        const view = new DataView(buffer);
        for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]));
            const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
            view.setInt16(i * 2, val, true); // True = Little Endian
        }
        return buffer;
    }

    // Cálculo de Downsample simples
    const ratio = inputRate / targetRate;
    const newLength = Math.ceil(input.length / ratio);
    const buffer = new ArrayBuffer(newLength * 2);
    const view = new DataView(buffer);
    
    for (let i = 0; i < newLength; i++) {
        const offset = Math.floor(i * ratio);
        // Garante que não estoure o array original
        const valFloat = input[Math.min(offset, input.length - 1)];
        
        // Clamp e Conversão
        const s = Math.max(-1, Math.min(1, valFloat));
        const valInt = s < 0 ? s * 0x8000 : s * 0x7FFF;
        
        view.setInt16(i * 2, valInt, true); // Little Endian
    }
    return buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    const chunkSize = 0x8000; // 32k chunks para evitar stack overflow
    
    for (let i = 0; i < len; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
        binary += String.fromCharCode.apply(null, Array.from(chunk));
    }
    return btoa(binary);
}

// -------------------------------------------
// FACT CHECKING (Mantido Igual)
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

// -------------------------------------------
// CONEXÃO LIVE (16kHz FORCE)
// -------------------------------------------

export interface LiveConnectionController {
    disconnect: () => Promise<void>;
    flush: () => void;
}

export const connectToLiveDebate = async (
  originalStream: MediaStream,
  onTranscript: (data: { text: string; speaker: string; isFinal: boolean }) => void,
  onError: (err: Error) => void,
  onStatus?: (status: LiveStatus) => void
): Promise<LiveConnectionController> => {
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
  if (!apiKey) {
    onError(new Error("API Key missing"));
    return { disconnect: async () => {}, flush: () => {} };
  }

  const stream = originalStream.clone();
  
  let shouldMaintainConnection = true;
  let activeSessionPromise: Promise<any> | null = null;
  let audioContext: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let gain: GainNode | null = null;
  let reconnectCount = 0;
  let currentBuffer = "";

  const ai = new GoogleGenAI({ apiKey });

  const handleText = (raw: string) => {
      const text = cleanTranscriptText(raw);
      if (text.length > 0) {
          console.log("📝 TRANSCRITO:", text); 
          currentBuffer += " " + text;
          onTranscript({ text: currentBuffer.trim(), speaker: "DEBATE", isFinal: false });
          
          if (currentBuffer.length > 80 || text.match(/[.!?]$/)) {
              onTranscript({ text: currentBuffer.trim(), speaker: "DEBATE", isFinal: true });
              currentBuffer = "";
          }
      }
  };

  const establishConnection = () => {
    if (!shouldMaintainConnection) return;

    onStatus?.({ type: 'info', message: "CONECTANDO..." });

    try {
        let sessionPromise: Promise<any>;

        sessionPromise = ai.live.connect({
          model: LIVE_MODEL_NAME,
          config: {
            responseModalities: [Modality.TEXT], 
            // @ts-ignore
            inputAudioTranscription: {}, 
            systemInstruction: {
                parts: [{ text: "Transcreva o áudio para Português." }]
            },
          },
          callbacks: {
            onopen: () => {
               console.log("🟢 Conectado (16kHz Mode)!");
               onStatus?.({ type: 'info', message: "ESCUTANDO" });
               reconnectCount = 0;
            },
            onmessage: (msg: LiveServerMessage) => {
               const t1 = msg.serverContent?.inputTranscription?.text;
               const t2 = msg.serverContent?.modelTurn?.parts?.[0]?.text;
               if (t1) handleText(t1);
               if (t2) handleText(t2);
            },
            onclose: (e) => {
               if (shouldMaintainConnection) {
                   console.log("🔄 Reconectando...");
                   setTimeout(establishConnection, 100); 
               }
            },
            onerror: (err) => console.error("🔴 Erro Socket:", err)
          }
        });

        activeSessionPromise = sessionPromise;

        sessionPromise.catch(err => {
            if (shouldMaintainConnection) setTimeout(establishConnection, 1000); 
        });

    } catch (err) {
        if (shouldMaintainConnection) setTimeout(establishConnection, 1000);
    }
  };

  establishConnection();

  const initAudio = async () => {
      audioContext = new AudioContext();
      if (audioContext.state === 'suspended') await audioContext.resume();
      
      const streamRate = audioContext.sampleRate;
      console.log(`🎤 Input Rate: ${streamRate}Hz -> Convertendo para 16000Hz`);

      source = audioContext.createMediaStreamSource(stream);
      // Buffer de 4096 é seguro
      processor = audioContext.createScriptProcessor(4096, 1, 1);
      gain = audioContext.createGain();
      gain.gain.value = 0;

      processor.onaudioprocess = async (e) => {
          if (!activeSessionPromise) return;

          const inputData = e.inputBuffer.getChannelData(0);
          
          if (Math.random() < 0.05) console.log("💓 Enviando Áudio 16k...");

          // 1. Volume Boost (5x)
          const boosted = new Float32Array(inputData.length);
          for (let i = 0; i < inputData.length; i++) boosted[i] = inputData[i] * 5.0; 

          try {
              // 2. Downsample e Conversão PCM rigorosa
              const pcmBuffer = downsampleAndConvertToPCM(boosted, streamRate);
              const base64Data = arrayBufferToBase64(pcmBuffer);

              activeSessionPromise.then(async (session) => {
                 await session.sendRealtimeInput([{ 
                      mimeType: "audio/pcm;rate=16000", // Agora é verdade!
                      data: base64Data
                  }]);
              }).catch(() => {});
          } catch (err) {}
      };

      source.connect(processor);
      processor.connect(gain);
      gain.connect(audioContext.destination);
  };

  initAudio();

  return {
       disconnect: async () => {
           console.log("🛑 Encerrando...");
           shouldMaintainConnection = false;
           if (source) source.disconnect();
           if (processor) processor.disconnect();
           if (gain) gain.disconnect();
           if (activeSessionPromise) {
               try {
                   const session = await activeSessionPromise;
                   session.close();
               } catch (e) { /* ignore */ }
           }
           if (audioContext && audioContext.state !== 'closed') await audioContext.close();
           stream.getTracks().forEach(t => t.stop()); 
       },
       flush: () => { currentBuffer = ""; }
    };
}