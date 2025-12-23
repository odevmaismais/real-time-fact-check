
import { GoogleGenAI, Type, LiveServerMessage, Modality } from "@google/genai";
import { AnalysisResult, VerdictType } from "../types";

// We use the flash preview for speed, as live fact-checking needs low latency.
const MODEL_NAME = "gemini-3-flash-preview";
const LIVE_MODEL_NAME = "gemini-2.5-flash-native-audio-preview-09-2025";

export type LiveStatus = {
  type: 'info' | 'warning' | 'error';
  message: string;
};

// --- GARBAGE COLLECTION & CLEANING UTILS ---

const isGarbage = (text: string): boolean => {
  const t = text.trim();
  if (t.length === 0) return true;

  // 1. Strict Short Word Filter
  // Only allow specific short words that are common connectors or interjections in PT-BR.
  // Reject random 1-2 char noise (e.g., "z", "k", "tt") unless it's a known valid word.
  const allowList = [
      'a', 'e', 'é', 'o', 'ó', 'u', 'à', 'y', 
      'oi', 'ai', 'ui', 'eu', 'tu', 'ele', 'nós', 'vós', 
      'ir', 'vir', 'ser', 'ter', 'ver', 'ler', 'dar',
      'sim', 'não', 'ok', 'fim', 'paz', 'luz', 'sol', 'mar',
      'fé', 'lei', 'crê', 'dê', 'vê'
  ];
  
  // If text is 2 chars or less, it MUST be in the allowList or a number.
  if (t.length <= 2 && !allowList.includes(t.toLowerCase()) && !/^\d+$/.test(t)) return true;

  const lower = t.toLowerCase();
  
  // 2. Enhanced Hallucination List
  // These are common artifacts in training data from YouTube/TV captions.
  const hallucinations = [
    // General / English artifacts
    'legendas', 'subtitles', 'watching', 'transcribed', 
    'copyright', 'todos os direitos', 'obrigado por assistir',
    'subs by', '[music]', '[applause]', '(risos)', '(silêncio)',
    'www.', '.com', 'http',
    
    // PT-BR Broadcast/YouTube artifacts
    'inscreva-se', 'deixe o like', 'deixe seu like', 'ative o sininho',
    'link na bio', 'siga nas redes', 'compartilhe',
    'tradução por', 'sincronia', 'legenda por', 'editado por',
    'créditos:', 'fim da transmissão', 'voltamos já', 
    'a seguir', 'blá blá', 'etc etc', 'realização', 'apoio cultural',
    'áudio original', 'encerrando transmissão', 'sem áudio',
    
    // Nonsense phrases common in low-confidence ASR during noise
    'o se amo', 'um saúde', 'uma saúde', 'obrigado a todos', 'até a próxima',
    'tv câmara', 'tv senado', 'reprodução', 
    'legendado por', 'tradução:', 'legenda:',
    'assine o canal', 'curta o vídeo',
    'whatsapp', 'facebook', 'instagram', 'twitter', 'youtube'
  ];
  
  // Check against hallucination list
  if (hallucinations.some(h => lower.includes(h))) return true;
  
  // 3. Pattern Matching for Garbage
  
  // Regex to catch only symbols (e.g. "???" or "...")
  if (/^[^a-zA-Z0-9À-ÿ\s]+$/.test(t)) return true;

  // Regex to catch repetitive single-char noise (e.g., "a a a a a", "e e e")
  if (/^([a-zà-ÿ])(\s+\1){2,}$/i.test(t)) return true;
  
  // Catch repetitive syllables (e.g., "da da da da") often output during static
  if (/^(\w{2,})\s\1\s\1/.test(lower)) return true;

  return false;
};

const cleanTranscriptText = (text: string): string => {
  if (!text) return "";
  let cleaned = text;
  // Normalize whitespace
  cleaned = cleaned.replace(/\s+/g, ' ');
  // Remove aggressive stuttering (3+ repeats)
  cleaned = cleaned.replace(/\b(\w+)( \1){2,}\b/gi, '$1');
  return cleaned;
};

// -------------------------------------------

export const analyzeStatement = async (
  text: string,
  segmentId: string
): Promise<AnalysisResult> => {
  // Create local instance for independent REST calls
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  try {
    const now = new Date();
    const formattedDate = now.toLocaleDateString('pt-BR', { dateStyle: 'full' });
    const formattedTime = now.toLocaleTimeString('pt-BR');

    const prompt = `
      CONTEXT: Today is ${formattedDate}, ${formattedTime}.
      The user is monitoring a live political debate in Brazil.
      
      Statement to Analyze: "${text}"

      INSTRUCTIONS:
      1. Check this statement for factual accuracy using Google Search.
      2. Identify: Lies, Distortions, Correct Data, Fallacies.
      3. If the statement is an opinion, mark as OPINION.
      
      Return JSON:
      - verdict: "TRUE", "FALSE", "MISLEADING", "UNVERIFIABLE", "OPINION"
      - confidence: number (0-100)
      - explanation: Concise Portuguese summary (Max 2 sentences).
      - counterEvidence: If FALSE/MISLEADING, provide real data.
      - sentimentScore: -1 (Hostile) to 1 (Constructive).
      - logicalFallacies: [{name, description}] (in PT-BR).
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
    };
  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    return {
      segmentId,
      verdict: VerdictType.UNVERIFIABLE,
      confidence: 0,
      explanation: "Erro de verificação.",
      sources: [],
      sentimentScore: 0,
    };
  }
};

export interface LiveConnectionController {
    disconnect: () => Promise<void>;
    flush: () => void;
}

/**
 * Calculates Root Mean Square (RMS) amplitude of audio buffer.
 * Used for Voice Activity Detection (VAD).
 */
const calculateRMS = (data: Float32Array): number => {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
        sum += data[i] * data[i];
    }
    return Math.sqrt(sum / data.length);
};

/**
 * Connects to Gemini Live API to stream audio from a tab/system for transcription.
 */
export const connectToLiveDebate = async (
  stream: MediaStream,
  onTranscript: (data: { text: string; speaker: string; isFinal: boolean }) => void,
  onError: (err: Error) => void,
  onStatus?: (status: LiveStatus) => void
): Promise<LiveConnectionController> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const streamClone = stream.clone();
  
  // 16kHz is optimal for Speech-to-Text
  const audioContext = new AudioContext({ sampleRate: 16000 });
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const source = audioContext.createMediaStreamSource(streamClone);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  
  let currentVolatileBuffer = "";
  const DEFAULT_SPEAKER = "DEBATER"; 
  let isConnected = false;
  let silenceTimer: any = null;
  let activeSession: any = null;
  
  // --- VAD & BACKPRESSURE CONFIG ---
  // RMS Threshold: < 0.01 usually means silence/background hum. 
  // Increase if environment is noisy.
  const VAD_THRESHOLD = 0.01; 
  
  // Hangover: Number of "silence" chunks to keep sending after speech ends.
  // 4096 samples @ 16kHz ~= 256ms. 
  // 3 chunks ~= 750ms of trailing audio to capture soft endings of words.
  const SILENCE_HANGOVER_CHUNKS = 3;
  let silenceChunkCount = 0;

  // Backpressure: If we have too many un-acked requests, drop frames.
  let pendingAudioRequests = 0;
  const MAX_PENDING_REQUESTS = 4; // Max concurrent audio pushes allowed

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
        systemInstruction: `
          Role: Elite Portuguese Speech-to-Text Specialist for Political Analysis.
          Context: Real-time audio feed from a political debate.
          
          Directives:
          1. VERBATIM TRANSCRIPTION: Transcribe the dominant speaker exactly as heard in Portuguese (Brazil).
          2. NOISE FILTERING: Completely IGNORE background noise, applause, cheering, music, and distinct cross-talk from audience.
          3. HALLUCINATION CHECK: Do NOT output broadcast artifacts like "Obrigado por assistir", "Legendas", "Copyright", "Sincronia". If the audio is just music or silence, output NOTHING.
          4. OVERLAP HANDLING: In case of overlapping speech (debater vs moderator or debater vs debater), prioritize the dominant/louder voice.
          5. PUNCTUATION & SEGMENTATION: Use natural punctuation (., ?, !) to separate thoughts.
          6. DISFLUENCY: Omit pure filler sounds (uh, um, ah) unless necessary for context, but keep hesitations if they change meaning.
          7. SPEAKER IDENTIFICATION: Focus on the main speech content.
        `,
      },
      callbacks: {
        onopen: () => {
           console.log("Gemini Live Session Opened");
           isConnected = true;
           onStatus?.({ type: 'info', message: "LIVE FEED ACTIVE" });
        },
        onmessage: (msg: LiveServerMessage) => {
           // 1. Handle Input Transcription (ASR)
           const inputTrx = msg.serverContent?.inputTranscription;
           if (inputTrx?.text) {
               let text = inputTrx.text;
               
               if (isGarbage(text)) {
                   return; 
               }
               
               text = cleanTranscriptText(text);
               currentVolatileBuffer += text;

               // Safety: Auto-flush if buffer is too big
               if (currentVolatileBuffer.length > 1500) {
                   commitBuffer();
               } else {
                   try {
                       onTranscript({ text: currentVolatileBuffer, speaker: DEFAULT_SPEAKER, isFinal: false });
                   } catch (e) { console.error("Callback error (partial)", e); }
                   scheduleSilenceCommit();
               }
           }
           
           // 2. Handle Turn Complete
           if (msg.serverContent?.turnComplete) {
               const trimmed = currentVolatileBuffer.trim();
               const isStrongPunctuation = /[.?!]$/.test(trimmed);
               const isSubstantial = trimmed.length > 80;
               const isCompleteSentence = trimmed.length > 30 && isStrongPunctuation;
               
               if (isSubstantial || isCompleteSentence) {
                   commitBuffer();
               } else {
                   scheduleSilenceCommit();
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

    // --- AUDIO PROCESSING LOOP ---
    processor.onaudioprocess = async (e) => {
      if (!isConnected || !activeSession) return; 

      // 1. BACKPRESSURE CHECK
      // If the network is clogging, don't add more fuel to the fire.
      // Drop frames to let the queue drain.
      if (pendingAudioRequests >= MAX_PENDING_REQUESTS) {
          // console.warn("Dropping frame due to backpressure");
          return;
      }

      const inputData = e.inputBuffer.getChannelData(0);
      
      // 2. VOICE ACTIVITY DETECTION (VAD)
      const rms = calculateRMS(inputData);
      
      // If RMS is below noise threshold, we might skip sending
      if (rms < VAD_THRESHOLD) {
          silenceChunkCount++;
          // If we have exceeded the "hangover" period (tail of speech), stop sending data.
          // This saves massive bandwidth and prevents model hallucinations on silence.
          if (silenceChunkCount > SILENCE_HANGOVER_CHUNKS) {
              return; 
          }
      } else {
          // Reset silence counter if we hear sound
          silenceChunkCount = 0;
      }

      // 3. ENCODING
      const pcmData = floatTo16BitPCM(inputData);

      // 4. SEND WITH BACKPRESSURE TRACKING
      try {
          pendingAudioRequests++;
          
          // Note: sendRealtimeInput is void in types, but internally wraps a promise-like structure 
          // in the websocket queue. We wrap it to track execution flow if possible, 
          // though strict awaiting inside onaudioprocess is tricky. 
          // We assume synchronous push to socket queue.
          
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
           
           streamClone.getTracks().forEach(track => track.stop());

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
    streamClone.getTracks().forEach(track => track.stop());
    if (audioContext.state !== 'closed') await audioContext.close();
    
    return {
        disconnect: async () => {},
        flush: () => {}
    };
  }
}

/**
 * Fast conversion from Float32 to 16-bit PCM base64.
 * Assumes input is already at correct sample rate.
 */
function floatTo16BitPCM(input: Float32Array): string {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    
    // Convert to binary string
    let binary = '';
    const bytes = new Uint8Array(output.buffer);
    const len = bytes.byteLength;
    // Chunk processing for large buffers to avoid stack overflow
    for (let i = 0; i < len; i+=1024) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.slice(i, i+1024)));
    }
    return btoa(binary);
}
