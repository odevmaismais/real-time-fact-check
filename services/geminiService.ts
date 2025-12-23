
import { GoogleGenAI, Type, LiveServerMessage, Modality } from "@google/genai";
import { AnalysisResult, VerdictType } from "../types";

// We use the flash preview for speed, as live fact-checking needs low latency.
const MODEL_NAME = "gemini-3-flash-preview";
const LIVE_MODEL_NAME = "gemini-2.5-flash-native-audio-preview-09-2025";

export type LiveStatus = {
  type: 'info' | 'warning' | 'error';
  message: string;
};

// --- UTILS ---

const isGarbage = (text: string): boolean => {
  const t = text.trim();
  if (t.length === 0) return true;

  // Structural noise filter only. 
  // We strictly rely on the model's System Instruction to avoid semantic hallucinations (credits, subtitles).
  
  // 1. Single/Double character noise (unless whitelisted)
  const allowList = [
      'a', 'e', 'é', 'o', 'ó', 'u', 'à', 'y', 
      'oi', 'ai', 'ui', 'eu', 'tu', 'ele', 'nós', 'vós', 
      'ir', 'vir', 'ser', 'ter', 'ver', 'ler', 'dar',
      'sim', 'não', 'ok', 'fim', 'paz', 'luz', 'sol', 'mar',
      'fé', 'lei', 'crê', 'dê', 'vê'
  ];
  
  if (t.length <= 2 && !allowList.includes(t.toLowerCase()) && !/^\d+$/.test(t)) return true;

  // 2. Pattern Matching for Garbage (Repeated chars or symbols)
  if (/^[^a-zA-Z0-9À-ÿ\s]+$/.test(t)) return true; // Only symbols
  if (/^([a-zà-ÿ])(\s+\1){2,}$/i.test(t)) return true; // "a a a a"
  
  return false;
};

const cleanTranscriptText = (text: string): string => {
  if (!text) return "";
  let cleaned = text;
  cleaned = cleaned.replace(/\s+/g, ' ');
  cleaned = cleaned.replace(/\b(\w+)( \1){2,}\b/gi, '$1'); // Remove stutter
  return cleaned;
};

// -------------------------------------------

export const analyzeStatement = async (
  text: string,
  segmentId: string,
  contextHistory: string[] = [] // New: History of previous sentences
): Promise<AnalysisResult> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  try {
    const now = new Date();
    const formattedDate = now.toLocaleDateString('pt-BR', { dateStyle: 'full' });
    const formattedTime = now.toLocaleTimeString('pt-BR');

    // CONTEXT INJECTION
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
      
      RETURN JSON FORMAT (pt-BR):
      {
        "verdict": "TRUE" | "FALSE" | "MISLEADING" | "UNVERIFIABLE" | "OPINION",
        "confidence": number (0-100),
        "explanation": "Concise summary in Portuguese (Max 250 chars).",
        "counterEvidence": "If FALSE/MISLEADING, provide the correct data with source.",
        "sentimentScore": number (-1.0 to 1.0),
        "logicalFallacies": [{"name": "Name", "description": "Short desc"}]
      }
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
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const audioContext = new AudioContext({ sampleRate: 16000 });
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
  
  // VAD Settings
  const VAD_THRESHOLD = 0.002; 
  const SILENCE_HANGOVER_CHUNKS = 5; 
  let silenceChunkCount = 0;
  let pendingAudioRequests = 0;
  const MAX_PENDING_REQUESTS = 4; 

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
             console.log("Silence watchdog - forcing commit");
             commitBuffer();
          }
      }, 2000); 
  };

  try {
    activeSession = await ai.live.connect({
      model: LIVE_MODEL_NAME,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
        },
        inputAudioTranscription: {}, 
        // ENHANCED SYSTEM INSTRUCTION FOR ROBUSTNESS
        systemInstruction: `
          Role: Expert Court Reporter / Stenographer for Portuguese (Brazil).
          Context: High-stakes political debate feed.
          
          CRITICAL RULES:
          1. AUDIO-ONLY: Transcribe ONLY spoken words.
          2. ANTI-HALLUCINATION: 
             - NEVER output "Obrigado por assistir".
             - NEVER output "Legendas por...".
             - NEVER output "Copyright".
             - If the audio is music, silence, or unintelligible noise, OUTPUT NOTHING (Empty String).
          3. VERBATIM: Do not summarize. Capture the exact Portuguese phrasing.
          4. CONTINUITY: If a sentence is interrupted, transcribe the partial sentence exactly.
        `,
      },
      callbacks: {
        onopen: () => {
           console.log("Gemini Live Session Opened");
           isConnected = true;
           onStatus?.({ type: 'info', message: "LIVE FEED ACTIVE" });
        },
        onmessage: (msg: LiveServerMessage) => {
           const inputTrx = msg.serverContent?.inputTranscription;
           if (inputTrx?.text) {
               let text = inputTrx.text;
               
               if (isGarbage(text)) {
                   return; 
               }
               
               text = cleanTranscriptText(text);
               currentVolatileBuffer += text;

               if (currentVolatileBuffer.length > 1500) {
                   commitBuffer();
               } else {
                   try {
                       onTranscript({ text: currentVolatileBuffer, speaker: DEFAULT_SPEAKER, isFinal: false });
                   } catch (e) { console.error("Callback error (partial)", e); }
                   scheduleSilenceCommit();
               }
           }
           
           if (msg.serverContent?.turnComplete) {
               const trimmed = currentVolatileBuffer.trim();
               // More lenient check for commit to ensure we don't hold text too long
               if (trimmed.length > 0) {
                   commitBuffer();
               }
           }
        },
        onerror: (err) => {
            console.error("Gemini Live Error:", err);
            onStatus?.({ type: 'error', message: "CONNECTION INTERRUPTED" });
            isConnected = false;
        },
        onclose: () => {
            console.log("Gemini Live Session Closed");
            onStatus?.({ type: 'warning', message: "SESSION ENDED" });
            isConnected = false;
        }
      }
    });

    isConnected = true;

    processor.onaudioprocess = async (e) => {
      if (!isConnected || !activeSession) return; 

      if (pendingAudioRequests >= MAX_PENDING_REQUESTS) {
          console.warn("High Latency: Audio queue full, dropping frames may occur.");
          if (pendingAudioRequests > 10) return;
      }

      const inputData = e.inputBuffer.getChannelData(0);
      const rms = calculateRMS(inputData);
      
      if (rms < VAD_THRESHOLD) {
          silenceChunkCount++;
          if (silenceChunkCount > SILENCE_HANGOVER_CHUNKS) {
              return; 
          }
      } else {
          silenceChunkCount = 0;
      }

      const pcmData = floatTo16BitPCM(inputData);

      try {
          pendingAudioRequests++;
          
          await activeSession.sendRealtimeInput({ 
              media: {
                  mimeType: 'audio/pcm;rate=16000',
                  data: pcmData
              }
          });
      } catch (e) {
          console.error("Error sending audio chunk", e);
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
           
           if (audioContext.state !== 'closed') {
               await audioContext.close();
           }
           
           if (activeSession) {
               try {
                  activeSession.close();
               } catch (e) { console.log("Session close ignored", e); }
           }
       },
       flush: () => {
           currentVolatileBuffer = "";
           if (silenceTimer) clearTimeout(silenceTimer);
       }
    };
  } catch (err: any) {
    onError(err);
    if (audioContext.state !== 'closed') await audioContext.close();
    
    return {
        disconnect: async () => {},
        flush: () => {}
    };
  }
}

function floatTo16BitPCM(input: Float32Array): string {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    
    let binary = '';
    const bytes = new Uint8Array(output.buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i+=1024) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.slice(i, i+1024)));
    }
    return btoa(binary);
}
