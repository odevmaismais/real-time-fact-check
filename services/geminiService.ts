import { GoogleGenAI, Type, LiveServerMessage, Modality } from "@google/genai";
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
  if (/^[^a-zA-Z0-9À-ÿ\s]+$/.test(t)) return true; 

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

// --- AUDIO PROCESSING ---

// Convert Float32 (Web Audio) to Int16 (PCM) 1:1 without downsampling
// This preserves the native sample rate quality
const floatTo16BitPCM = (input: Float32Array): Int16Array => {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return output;
};

// [FIX] TS2345: Accept ArrayBufferLike to support SharedArrayBuffer if needed
function arrayBufferToBase64(buffer: ArrayBufferLike) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

// -------------------------------------------

export const analyzeStatement = async (
  text: string,
  segmentId: string,
  contextHistory: string[] = [] 
): Promise<AnalysisResult> => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) throw new Error("API_KEY not found");

  const ai = new GoogleGenAI({ apiKey });
  
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
      1. CLASSIFICATION: Determine if "TARGET STATEMENT" contains a Checkable Factual Claim (stats, laws, specific past events, quotes) OR if it is Pure Opinion/Rhetoric.
         - If OPINION/RHETORIC: Return verdict "OPINION" immediately. DO NOT use Google Search.
         - If FACTUAL CLAIM: You MUST use the 'googleSearch' tool to verify the specific data points.
      
      2. CONTEXTUALIZATION: Use the "IMMEDIATE CONTEXT" to resolve pronouns (he/she/it) or references to previous topics.
      
      3. ANALYSIS:
         - Identify lies, distortions, or cherry-picking.
         - Identify logical fallacies (Ad Hominem, Strawman, etc).
      
      RETURN JSON FORMAT (pt-BR).
    `;

    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            verdict: { type: Type.STRING, enum: Object.values(VerdictType) },
            confidence: { type: Type.NUMBER },
            explanation: { type: Type.STRING },
            counterEvidence: { type: Type.STRING },
            sentimentScore: { type: Type.NUMBER },
            logicalFallacies: { 
              type: Type.ARRAY, 
              items: { 
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  description: { type: Type.STRING }
                },
                required: ["name", "description"]
              } 
            },
          },
          required: ["verdict", "confidence", "explanation", "sentimentScore"],
        },
      },
    });

    const jsonText = response.text;
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
      explanation: "Erro de processamento ou verificação.",
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
    for (let i = 0; i < data.length; i++) {
        sum += data[i] * data[i];
    }
    return Math.sqrt(sum / data.length);
};

export const connectToLiveDebate = async (
  stream: MediaStream,
  onTranscript: (data: { text: string; speaker: string; isFinal: boolean }) => void,
  onError: (err: Error) => void,
  onStatus?: (status: LiveStatus) => void
): Promise<LiveConnectionController> => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
      onError(new Error("API_KEY not configured"));
      return { disconnect: async () => {}, flush: () => {} };
  }

  const ai = new GoogleGenAI({ apiKey });
  
  // [CRITICAL] 1. Use Native AudioContext (no specific sample rate)
  const audioContext = new AudioContext(); 
  const currentSampleRate = audioContext.sampleRate;
  console.log("Audio Context Rate:", currentSampleRate);

  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  
  let currentVolatileBuffer = "";
  const DEFAULT_SPEAKER = "DEBATER"; 
  let isConnected = false;
  let silenceTimer: any = null;
  let activeSession: any = null;
  
  const VAD_THRESHOLD = 0.001; 
  const SILENCE_HANGOVER_CHUNKS = 5; 
  let silenceChunkCount = 0;
  
  let pendingAudioRequests = 0;
  const MAX_PENDING_REQUESTS = 10; 

  const commitBuffer = () => {
    if (currentVolatileBuffer.trim().length > 0) {
        try {
            onTranscript({ text: currentVolatileBuffer.trim(), speaker: DEFAULT_SPEAKER, isFinal: true });
        } catch (e) {
            console.error("Callback error", e);
        }
        currentVolatileBuffer = "";
    }
  };

  const scheduleSilenceCommit = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
          if (currentVolatileBuffer.trim().length > 0) {
             commitBuffer();
          }
      }, 1500); 
  };

  try {
    activeSession = await ai.live.connect({
      model: LIVE_MODEL_NAME,
      config: {
        // [CRITICAL] 2. Maintain Modality.TEXT
        responseModalities: [Modality.TEXT], 
        // [FIX] Removed speechConfig (not needed for text output)
        // [FIX] Removed inputAudioTranscription (caused Error 1007)
        systemInstruction: "You are a live transcriber. Your job is to listen to the audio stream and output the Portuguese text EXACTLY as spoken. Do not summarize. Do not answer. Just write down the words immediately. If there is silence, output nothing."
      },
      callbacks: {
        onopen: () => {
           console.log("🟢 Gemini Live Connected (" + LIVE_MODEL_NAME + ") Rate: " + currentSampleRate);
           isConnected = true;
           onStatus?.({ type: 'info', message: "LIVE LINK ESTABLISHED" });
        },
        onmessage: (msg: LiveServerMessage) => {
           // With inputAudioTranscription removed, we rely on the model 'replying' with the text
           const textParts = msg.serverContent?.modelTurn?.parts;
           if (textParts) {
               for (const part of textParts) {
                   if (part.text) {
                       let text = part.text;
                       if (isGarbage(text)) continue;
                       
                       text = cleanTranscriptText(text);
                       currentVolatileBuffer += text;

                       try {
                           onTranscript({ text: currentVolatileBuffer, speaker: DEFAULT_SPEAKER, isFinal: false });
                       } catch (e) { }
                       
                       scheduleSilenceCommit();
                   }
               }
           }

           if (msg.serverContent?.turnComplete) {
               if (currentVolatileBuffer.trim().length > 0) {
                   commitBuffer();
               }
           }
        },
        onclose: (e: any) => {
           console.log("🔴 Gemini Live Closed", e);
           onStatus?.({ type: 'warning', message: "CONNECTION CLOSED" });
           isConnected = false;
        },
        onerror: (err: any) => {
           console.error("🔴 Gemini Live Error:", err);
           onStatus?.({ type: 'error', message: "STREAM ERROR" });
        }
      }
    });

    isConnected = true;

    processor.onaudioprocess = async (e) => {
      if (!isConnected || !activeSession) return; 

      if (pendingAudioRequests >= MAX_PENDING_REQUESTS) return;

      const inputData = e.inputBuffer.getChannelData(0);
      
      // VAD
      const rms = calculateRMS(inputData);
      if (rms < VAD_THRESHOLD) {
          silenceChunkCount++;
          if (silenceChunkCount > SILENCE_HANGOVER_CHUNKS) return; 
      } else {
          silenceChunkCount = 0;
      }

      // [CRITICAL] 3. Native Sample Rate Processing
      // Convert Float32 to Int16 directly (1:1 mapping, no downsampling)
      const pcmData = floatTo16BitPCM(inputData);
      const base64Data = arrayBufferToBase64(pcmData.buffer);
      
      try {
          pendingAudioRequests++;
          await activeSession.sendRealtimeInput([{ 
              media: {
                  // [CRITICAL] Dynamic Sample Rate in MimeType
                  mimeType: `audio/pcm;rate=${currentSampleRate}`,
                  data: base64Data
              }
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
           if (silenceTimer) clearTimeout(silenceTimer);
           
           source.disconnect();
           processor.disconnect();
           processor.onaudioprocess = null;
           
           if (audioContext.state !== 'closed') await audioContext.close();
           if (activeSession) activeSession.close();
       },
       flush: () => {
           currentVolatileBuffer = "";
           if (silenceTimer) clearTimeout(silenceTimer);
       }
    };
  } catch (err: any) {
    onError(err);
    if (audioContext.state !== 'closed') await audioContext.close();
    return { disconnect: async () => {}, flush: () => {} };
  }
}