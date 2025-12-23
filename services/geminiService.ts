import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { AnalysisResult, VerdictType } from "../types";

// [CRITICAL] Using the specific model requested that supports Live API reliably
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
  // Structural noise filter
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
  // Remove stutter
  cleaned = cleaned.replace(/\b(\w+)( \1){2,}\b/gi, '$1'); 
  return cleaned;
};

// -------------------------------------------

export const analyzeStatement = async (
  text: string,
  segmentId: string,
  contextHistory: string[] = [] 
): Promise<AnalysisResult> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  try {
    const now = new Date();
    const formattedDate = now.toLocaleDateString('pt-BR', { dateStyle: 'full' });
    const formattedTime = now.toLocaleTimeString('pt-BR');

    const contextBlock = contextHistory.length > 0 
      ? `IMMEDIATE CONTEXT (Previous statements):\n${contextHistory.map((s, i) => `-${i+1}: "${s}"`).join('\n')}`
      : "IMMEDIATE CONTEXT: None (Start of debate)";

    const prompt = `
      SYSTEM_TIME: ${formattedDate}, ${formattedTime}.
      TASK: Real-time Fact Checking of Brazilian Political Debate.
      ${contextBlock}
      TARGET STATEMENT TO ANALYZE: "${text}"
      EXECUTION PROTOCOL:
      1. CLASSIFICATION: Determine if "TARGET STATEMENT" contains a Checkable Factual Claim.
         - If OPINION/RHETORIC: Return verdict "OPINION" immediately. DO NOT use Google Search.
         - If FACTUAL CLAIM: You MUST use the 'googleSearch' tool.
      2. CONTEXTUALIZATION: Use the "IMMEDIATE CONTEXT" to resolve pronouns.
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

    const jsonText = response.text();
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

export interface LiveConnectionController {
    disconnect: () => Promise<void>;
    flush: () => void;
}

const calculateRMS = (data: Float32Array): number => {
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    return Math.sqrt(sum / data.length);
};

// Optimized Base64 conversion
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

export const connectToLiveDebate = async (
  stream: MediaStream,
  onTranscript: (data: { text: string; speaker: string; isFinal: boolean }) => void,
  onError: (err: Error) => void,
  onStatus?: (status: LiveStatus) => void
): Promise<LiveConnectionController> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  // [FIX 1] Removed fixed sampleRate. Let browser decide (likely 48000Hz for Youtube)
  const audioContext = new AudioContext(); 
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  
  let currentVolatileBuffer = "";
  let isConnected = false;
  let silenceTimer: any = null;
  let activeSession: any = null;
  
  const VAD_THRESHOLD = 0.001; 
  let silenceChunkCount = 0;
  let pendingAudioRequests = 0;

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
      }, 1500); 
  };

  try {
    console.log("🎤 Audio Context Rate:", audioContext.sampleRate); // Debug

    activeSession = await ai.live.connect({
      model: LIVE_MODEL_NAME,
      config: {
        // [FIX 2] Request TEXT only. No AUDIO response.
        responseModalities: [Modality.TEXT], 
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
        },
        // [FIX 3] Empty object enables transcription without invalid 'model' field
        // @ts-ignore
        inputAudioTranscription: {}, 
        systemInstruction: {
            parts: [{
                text: "Transcreva o debate político em Português (Brasil) EXATAMENTE como falado. Ignore ruídos."
            }]
        }
      },
      callbacks: {
        onopen: () => {
           console.log("🟢 Gemini Live Connected");
           isConnected = true;
           onStatus?.({ type: 'info', message: "CONECTADO AO YOUTUBE" });
        },
        onmessage: (msg: LiveServerMessage) => {
           const inputTrx = msg.serverContent?.inputTranscription;
           if (inputTrx?.text) {
               let text = cleanTranscriptText(inputTrx.text);
               if (!isGarbage(text)) {
                   currentVolatileBuffer += text;
                   onTranscript({ text: currentVolatileBuffer, speaker: "DEBATE", isFinal: false });
                   scheduleSilenceCommit();
               }
           }
           if (msg.serverContent?.turnComplete) {
               commitBuffer();
           }
        },
        onclose: (e) => {
           console.log("🔴 Gemini Live Closed", e);
           onStatus?.({ type: 'warning', message: "DESCONECTADO" });
           isConnected = false;
        },
        onerror: (err: any) => {
           console.error("🔴 Gemini Live Error:", err);
           onStatus?.({ type: 'error', message: "ERRO DE STREAM" });
        }
      }
    });

    isConnected = true;

    processor.onaudioprocess = async (e) => {
      if (!isConnected || !activeSession) return; 

      if (pendingAudioRequests >= 10) return;

      const inputData = e.inputBuffer.getChannelData(0);
      const rms = calculateRMS(inputData);
      
      // Simples VAD
      if (rms < VAD_THRESHOLD) {
          silenceChunkCount++;
          if (silenceChunkCount > 5) return; 
      } else {
          silenceChunkCount = 0;
      }

      const pcmData = floatTo16BitPCM(inputData);
      
      try {
          pendingAudioRequests++;
          // [FIX 4] Dynamic Sample Rate sending
          await activeSession.sendRealtimeInput([{ 
              mimeType: `audio/pcm;rate=${audioContext.sampleRate}`,
              data: pcmData
          }]);
      } catch (e) {
          console.error("Audio send error", e);
      } finally {
          pendingAudioRequests--;
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
       flush: () => {
           currentVolatileBuffer = "";
       }
    };
  } catch (err: any) {
    onError(err);
    return { disconnect: async () => {}, flush: () => {} };
  }
}