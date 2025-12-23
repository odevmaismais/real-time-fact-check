import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { AnalysisResult, VerdictType } from "../types";

const MODEL_NAME = "gemini-2.0-flash-exp";
const LIVE_MODEL_NAME = "gemini-2.0-flash-exp";

export type LiveStatus = {
  type: 'info' | 'warning' | 'error';
  message: string;
};

// --- UTILS ---

const isGarbage = (text: string): boolean => {
  if (!text) return true;
  const t = text.trim();
  if (t.length === 0) return true;
  return false;
};

const cleanTranscriptText = (text: string): string => {
  if (!text) return "";
  return text.replace(/\s+/g, ' ').trim();
};

function floatTo16BitPCM(input: Float32Array): string {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    const bytes = new Uint8Array(output.buffer);
    let binary = '';
    const len = bytes.byteLength;
    const CHUNK_SIZE = 0x8000; 
    for (let i = 0; i < len; i += CHUNK_SIZE) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK_SIZE)));
    }
    return btoa(binary);
}

// -------------------------------------------
// FUNÇÃO DE ANÁLISE (FACT CHECKING)
// -------------------------------------------

export const analyzeStatement = async (
  text: string,
  segmentId: string,
  contextHistory: string[] = [] 
): Promise<AnalysisResult> => {
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
  const ai = new GoogleGenAI({ apiKey });
  
  try {
    const contextBlock = contextHistory.length > 0 
      ? `CONTEXTO ANTERIOR:\n${contextHistory.map((s, i) => `-${i+1}: "${s}"`).join('\n')}`
      : "CONTEXTO: Início do debate";

    const prompt = `
      CONTEXTO: Checagem de fatos em tempo real (Brasil).
      ${contextBlock}
      FRASE ALVO: "${text}"
      
      TAREFA:
      1. Se for OPINIÃO/RETÓRICA -> verdict: "OPINION" (Não busque).
      2. Se for FATO -> verdict: "TRUE"/"FALSE"/"MISLEADING" (Use googleSearch).
      
      Responda em JSON (pt-BR).
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
      context: contextHistory
    };
  } catch (error) {
    console.error("Erro análise:", error);
    return {
      segmentId,
      verdict: VerdictType.UNVERIFIABLE,
      confidence: 0,
      explanation: "Erro técnico na verificação.",
      sources: [],
      sentimentScore: 0,
    };
  }
};

// -------------------------------------------
// FUNÇÃO DE CONEXÃO LIVE
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
  const ai = new GoogleGenAI({ apiKey });
  
  const audioContext = new AudioContext(); 
  if (audioContext.state === 'suspended') await audioContext.resume();

  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  
  let currentBuffer = "";
  let isConnected = false;
  let activeSession: any = null;

  const handleTextPart = (rawText: string) => {
      const text = cleanTranscriptText(rawText);
      if (!isGarbage(text)) {
          console.log("📝 Texto Recebido:", text); // Debug visual
          currentBuffer += " " + text;
          onTranscript({ text: currentBuffer.trim(), speaker: "DEBATE", isFinal: false });
          
          // Commit rápido para manter fluidez
          if (currentBuffer.length > 100 || text.endsWith('.')) {
              onTranscript({ text: currentBuffer.trim(), speaker: "DEBATE", isFinal: true });
              currentBuffer = "";
          }
      }
  };

  try {
    console.log(`🎤 Conectando Gemini Live (Rate: ${audioContext.sampleRate}Hz)`);

    activeSession = await ai.live.connect({
      model: LIVE_MODEL_NAME,
      config: {
        responseModalities: [Modality.TEXT], 
        // @ts-ignore
        inputAudioTranscription: {}, 
        systemInstruction: {
            parts: [{
                text: "You are a transcriber. Output EXACTLY what is said in Portuguese. Do not translate. Do not summarize."
            }]
        }
      },
      callbacks: {
        onopen: () => {
           console.log("🟢 Conectado!");
           isConnected = true;
           onStatus?.({ type: 'info', message: "CONEXÃO ESTABELECIDA" });
        },
        onmessage: (msg: LiveServerMessage) => {
           // 1. Tenta pegar do Input Transcription (Eco do usuário)
           const inputTrx = msg.serverContent?.inputTranscription;
           if (inputTrx?.text) {
               handleTextPart(inputTrx.text);
           }
           
           // 2. Tenta pegar do Model Turn (Resposta da IA atuando como transcritor)
           // Isso resolve o problema se o 'inputTranscription' estiver mudo.
           const modelTurn = msg.serverContent?.modelTurn;
           if (modelTurn?.parts) {
               for (const part of modelTurn.parts) {
                   if (part.text) handleTextPart(part.text);
               }
           }

           if (msg.serverContent?.turnComplete) {
               if(currentBuffer.trim()) {
                   onTranscript({ text: currentBuffer.trim(), speaker: "DEBATE", isFinal: true });
                   currentBuffer = "";
               }
           }
        },
        onclose: (e) => {
           console.log("🔴 Fechado:", e);
           onStatus?.({ type: 'warning', message: "DESCONECTADO" });
           isConnected = false;
        },
        onerror: (err) => {
           console.error("🔴 Erro:", err);
           onStatus?.({ type: 'error', message: "ERRO DE CONEXÃO" });
        }
      }
    });

    isConnected = true;

    processor.onaudioprocess = async (e) => {
      if (!isConnected || !activeSession) return; 
      
      const inputData = e.inputBuffer.getChannelData(0);
      
      // Monitor de Volume (Debug no Console)
      // Se aparecerem apenas zeros, o Chrome não está pegando áudio da aba
      let sum = 0;
      for(let i=0; i<100; i++) sum += Math.abs(inputData[i]);
      if (Math.random() < 0.05) console.log("📊 Vol:", (sum/100).toFixed(4)); 

      const pcmData = floatTo16BitPCM(inputData);
      
      try {
          await activeSession.sendRealtimeInput([{ 
              mimeType: `audio/pcm;rate=${audioContext.sampleRate}`,
              data: pcmData
          }]);
      } catch (err) {
          console.error("Erro envio áudio", err);
      }
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

    return {
       disconnect: async () => {
           isConnected = false;
           source.disconnect();
           processor.disconnect();
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