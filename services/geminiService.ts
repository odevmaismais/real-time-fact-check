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
  const t = text.trim();
  if (t.length === 0) return true;
  // Filtro básico de ruído estrutural
  const allowList = [
      'a', 'e', 'é', 'o', 'ó', 'u', 'à', 'y', 
      'oi', 'ai', 'ui', 'eu', 'tu', 'ele', 'nós', 'vós', 
      'ir', 'vir', 'ser', 'ter', 'ver', 'ler', 'dar',
      'sim', 'não', 'ok', 'fim', 'paz', 'luz', 'sol', 'mar',
      'fé', 'lei', 'crê', 'dê', 'vê'
  ];
  if (t.length <= 2 && !allowList.includes(t.toLowerCase()) && !/^\d+$/.test(t)) return true;
  return false;
};

const cleanTranscriptText = (text: string): string => {
  if (!text) return "";
  let cleaned = text;
  cleaned = cleaned.replace(/\s+/g, ' ');
  // Remove gagueira (ex: "eu eu eu acho")
  cleaned = cleaned.replace(/\b(\w+)( \1){2,}\b/gi, '$1'); 
  return cleaned;
};

// Conversão otimizada Float32 -> Int16 PCM
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
  if (!apiKey) throw new Error("API Key is missing");
  
  const ai = new GoogleGenAI({ apiKey });
  
  try {
    const now = new Date();
    const contextBlock = contextHistory.length > 0 
      ? `IMMEDIATE CONTEXT (Previous statements):\n${contextHistory.map((s, i) => `-${i+1}: "${s}"`).join('\n')}`
      : "IMMEDIATE CONTEXT: None";

    const prompt = `
      SYSTEM_TIME: ${now.toISOString()}.
      TASK: Real-time Fact Checking of Brazilian Political Debate.
      ${contextBlock}
      TARGET STATEMENT TO ANALYZE: "${text}"
      EXECUTION PROTOCOL:
      1. CLASSIFICATION: Is this a Checkable Factual Claim?
         - If OPINION/RHETORIC: Return verdict "OPINION".
         - If FACTUAL CLAIM: You MUST use 'googleSearch'.
      2. CONTEXTUALIZATION: Resolve pronouns using context.
      RETURN JSON FORMAT (pt-BR).
    `;

    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
      },
    });

    const jsonText = response.text; // Propriedade getter, não função
    
    if (!jsonText) throw new Error("No response from AI");
    
    const data = JSON.parse(jsonText);
    const sources = response.candidates?.[0]?.groundingMetadata?.groundingChunks
      ?.map((chunk: any) => chunk.web)
      .filter((web: any) => web && web.uri && web.title) || [];

    return {
      segmentId,
      verdict: data.verdict as VerdictType,
      confidence: data.confidence,
      explanation: data.explanation,
      counterEvidence: data.counterEvidence,
      sources: sources,
      sentimentScore: data.sentimentScore,
      logicalFallacies: data.logicalFallacies || [],
      context: contextHistory
    };
  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    return {
      segmentId,
      verdict: VerdictType.UNVERIFIABLE,
      confidence: 0,
      explanation: "Erro de processamento.",
      sources: [],
      sentimentScore: 0,
    };
  }
};

// -------------------------------------------
// FUNÇÃO DE CONEXÃO LIVE (STREAMING)
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
  
  // Audio Setup
  const audioContext = new AudioContext(); 
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const source = audioContext.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but reliable for raw PCM extraction in pure JS/TS without Worklets
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  
  let currentVolatileBuffer = "";
  let isConnected = false;
  let activeSession: any = null;
  let silenceTimer: any = null;

  const commitBuffer = () => {
    if (currentVolatileBuffer.trim().length > 0) {
        onTranscript({ text: currentVolatileBuffer.trim(), speaker: "DEBATE", isFinal: true });
        currentVolatileBuffer = "";
    }
  };

  const scheduleSilenceCommit = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
          if (currentVolatileBuffer.trim().length > 0) commitBuffer();
      }, 2000); 
  };

  try {
    console.log(`🎤 Connecting to Live Model: ${LIVE_MODEL_NAME} | Rate: ${audioContext.sampleRate}`);

    // [BARE METAL CONFIG]
    activeSession = await ai.live.connect({
      model: LIVE_MODEL_NAME,
      config: {
        // [CRITICAL] Text ONLY. Adding Audio here often causes "Code 1000" if output handling isn't perfect.
        responseModalities: [Modality.TEXT], 
        
        // [CRITICAL] Enable Transcription (Empty Object per SDK requirements for pure transcription)
        // @ts-ignore
        inputAudioTranscription: {}, 
        
        // [CRITICAL] Simple Instruction. No tools. No weird configs.
        systemInstruction: {
            parts: [{
                text: "Transcribe the audio to text."
            }]
        }
      },
      callbacks: {
        onopen: () => {
           console.log("🟢 Gemini Live Connected");
           isConnected = true;
           onStatus?.({ type: 'info', message: "CONECTADO: ESCUTANDO..." });
        },
        onmessage: (msg: LiveServerMessage) => {
           // Handle Transcription
           const inputTrx = msg.serverContent?.inputTranscription;
           if (inputTrx?.text) {
               const text = cleanTranscriptText(inputTrx.text);
               if (!isGarbage(text)) {
                   currentVolatileBuffer += text;
                   // Send "interim" result
                   onTranscript({ text: currentVolatileBuffer, speaker: "DEBATE", isFinal: false });
                   scheduleSilenceCommit();
               }
           }
           
           // Handle Turn Complete (Model finished thinking/processing a chunk)
           if (msg.serverContent?.turnComplete) {
               commitBuffer();
           }
        },
        onclose: (e) => {
           console.log("🔴 Gemini Live Closed", e);
           onStatus?.({ type: 'warning', message: `DESCONECTADO (Code ${e.code})` });
           isConnected = false;
        },
        onerror: (err: any) => {
           console.error("🔴 Gemini Live Error:", err);
           onStatus?.({ type: 'error', message: "ERRO DE STREAM" });
        }
      }
    });

    isConnected = true;

    // [AUDIO PROCESSING LOOP]
    processor.onaudioprocess = async (e) => {
      if (!isConnected || !activeSession) return; 

      const inputData = e.inputBuffer.getChannelData(0);
      
      // [CRITICAL] VAD REMOVED. SEND EVERYTHING.
      // If we filter silence here, the server might think the connection died if the video is quiet.
      // We send the raw PCM and let the model decide what is silence.
      
      const pcmData = floatTo16BitPCM(inputData);
      
      try {
          // Dynamic Sample Rate is safer than hardcoded 16000
          activeSession.sendRealtimeInput([{ 
              mimeType: `audio/pcm;rate=${audioContext.sampleRate}`,
              data: pcmData
          }]);
      } catch (error) {
          console.error("Audio Send Error:", error);
      }
    };

    // Connect Graph
    source.connect(processor);
    processor.connect(audioContext.destination);

    return {
       disconnect: async () => {
           console.log("Terminating session...");
           isConnected = false;
           source.disconnect();
           processor.disconnect();
           if (activeSession) activeSession.close();
           if (audioContext.state !== 'closed') await audioContext.close();
       },
       flush: () => {
           currentVolatileBuffer = "";
       }
    };
  } catch (err: any) {
    onError(err);
    return { disconnect: async () => {}, flush: () => {} };
  }
}