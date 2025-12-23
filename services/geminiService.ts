import { GoogleGenAI, Type, LiveServerMessage, Modality } from "@google/genai";
import { AnalysisResult, VerdictType } from "../types";

// [FIX] Usando os modelos REAIS disponíveis atualmente na API
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
  // Se for apenas uma letra (exceto as vogais e 'y' comuns) ou símbolos
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
  // Remove gagueira repetitiva (ex: "o o o que")
  cleaned = cleaned.replace(/\b(\w+)( \1){2,}\b/gi, '$1'); 
  return cleaned;
};

// -------------------------------------------

export const analyzeStatement = async (
  text: string,
  segmentId: string,
  contextHistory: string[] = [] 
): Promise<AnalysisResult> => {
  // [FIX] Certifique-se que REACT_APP_API_KEY ou VITE_API_KEY esteja configurado
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

// [FIX] Better Base64 conversion for Audio
function arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

export const connectToLiveDebate = async (
  stream: MediaStream,
  onTranscript: (data: { text: string; speaker: string; isFinal: boolean }) => void,
  onError: (err: Error) => void,
  onStatus?: (status: LiveStatus) => void
): Promise<LiveConnectionController> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  // [FIX] Ensure AudioContext is handled correctly across browsers
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
  
  const VAD_THRESHOLD = 0.002; 
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
        // [FIX] We only need Input Transcription for this use case
        responseModalities: [Modality.AUDIO], 
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
        },
        inputAudioTranscription: {
            model: "gemini-2.0-flash-exp" // Ensure explicit transcription model if supported, or let auto
        }, 
        systemInstruction: {
            parts: [{
                text: `
                Role: Portuguese (Brazil) Transcriber.
                Context: Political debate.
                
                Rules:
                1. Transcribe spoken Portuguese exactly.
                2. IGNORE background noise, music, or silence.
                3. DO NOT output "Obrigado por assistir", "Legendas", or credits.
                4. If speech is unclear, output nothing.
                `
            }]
        }
      },
    });

    // Event Handling
    // Note: The SDK event structure might differ slightly depending on version, 
    // ensuring we catch the right content.
    // @ts-ignore
    activeSession.on('open', () => {
        console.log("🟢 Gemini Live Connected");
        isConnected = true;
        onStatus?.({ type: 'info', message: "LIVE LINK ESTABLISHED" });
    });

    // @ts-ignore
    activeSession.on('message', (msg: LiveServerMessage) => {
        // Handle Server Content (Transcription)
        const inputTrx = msg.serverContent?.inputTranscription;
        
        if (inputTrx?.text) {
            let text = inputTrx.text;
            // console.log("Stream:", text);
            
            if (isGarbage(text)) return;
            
            text = cleanTranscriptText(text);
            currentVolatileBuffer += text;

            // Send 'ghost' update for UI
            try {
                onTranscript({ text: currentVolatileBuffer, speaker: DEFAULT_SPEAKER, isFinal: false });
            } catch (e) { }
            
            scheduleSilenceCommit();
        }

        if (msg.serverContent?.turnComplete) {
            if (currentVolatileBuffer.trim().length > 0) {
                commitBuffer();
            }
        }
    });

    // @ts-ignore
    activeSession.on('close', () => {
        console.log("🔴 Gemini Live Closed");
        onStatus?.({ type: 'warning', message: "CONNECTION CLOSED" });
        isConnected = false;
    });

    // @ts-ignore
    activeSession.on('error', (err: any) => {
        console.error("🔴 Gemini Live Error:", err);
        onStatus?.({ type: 'error', message: "STREAM ERROR" });
    });

    isConnected = true;

    processor.onaudioprocess = async (e) => {
      if (!isConnected || !activeSession) return; 

      if (pendingAudioRequests >= MAX_PENDING_REQUESTS) {
          // Drop frame to catch up
          return;
      }

      const inputData = e.inputBuffer.getChannelData(0);
      
      // Simple VAD
      const rms = calculateRMS(inputData);
      if (rms < VAD_THRESHOLD) {
          silenceChunkCount++;
          if (silenceChunkCount > SILENCE_HANGOVER_CHUNKS) return; 
      } else {
          silenceChunkCount = 0;
      }

      // Convert to PCM
      const pcmData = floatTo16BitPCM(inputData);
      
      // Send
      try {
          pendingAudioRequests++;
          await activeSession.sendRealtimeInput([{ 
              mimeType: 'audio/pcm;rate=16000',
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

function floatTo16BitPCM(input: Float32Array): string {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    const bytes = new Uint8Array(output.buffer);
    
    // Optimized Base64 for chunks
    let binary = '';
    const len = bytes.byteLength;
    // Process in chunks to avoid stack overflow in String.fromCharCode
    const CHUNK_SIZE = 0x8000; 
    for (let i = 0; i < len; i += CHUNK_SIZE) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK_SIZE)));
    }
    return btoa(binary);
}