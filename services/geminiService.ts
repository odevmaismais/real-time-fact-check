
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
 * Connects to Gemini Live API to stream audio from a tab/system for transcription.
 */
export const connectToLiveDebate = async (
  stream: MediaStream,
  onTranscript: (data: { text: string; speaker: string; isFinal: boolean }) => void,
  onError: (err: Error) => void,
  onStatus?: (status: LiveStatus) => void
): Promise<LiveConnectionController> => {
  // Create local instance for independent Live session
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  // 1. CLONE STREAM: Critical to ensure this service doesn't conflict with Visualizers in the UI
  const streamClone = stream.clone();
  
  // OPTIMIZATION: Request 16kHz context directly to avoid JS resampling.
  // Browser will handle resampling natively (C++), which is much faster and smoother.
  const audioContext = new AudioContext({ sampleRate: 16000 });
  
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const source = audioContext.createMediaStreamSource(streamClone);
  // Use a slightly larger buffer to be safe against main thread jank
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  
  let currentVolatileBuffer = "";
  const DEFAULT_SPEAKER = "DEBATER"; 
  let isConnected = false;
  let silenceTimer: any = null;
  let activeSession: any = null; // Store stable session reference
  
  // Increased max buffer to allow for longer thoughts before forced cut
  const MAX_BUFFER_LENGTH = 1500; 

  // Helper to commit what we have
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
      // WATCHDOG: Wait 2.0 seconds of silence before forcing a commit.
      // This ensures that if the model doesn't send TurnComplete (common in noise), we still get text.
      silenceTimer = setTimeout(() => {
          if (currentVolatileBuffer.trim().length > 0) {
             console.log("Silence watchdog - forcing commit");
             commitBuffer();
          }
      }, 2000); 
  };

  try {
    // 2. SESSION PERSISTENCE: Await connection *before* starting loop.
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
               if (currentVolatileBuffer.length > MAX_BUFFER_LENGTH) {
                   commitBuffer();
               } else {
                   // Send PARTIAL update
                   try {
                       onTranscript({ text: currentVolatileBuffer, speaker: DEFAULT_SPEAKER, isFinal: false });
                   } catch (e) { console.error("Callback error (partial)", e); }
                   scheduleSilenceCommit();
               }
           }
           
           // 2. Handle Turn Complete (Model finished "listening" phase)
           if (msg.serverContent?.turnComplete) {
               const trimmed = currentVolatileBuffer.trim();
               const isStrongPunctuation = /[.?!]$/.test(trimmed);
               
               // IMPROVED SEGMENTATION LOGIC:
               // Avoid fragmentation. Merge short sentences to provide better context for analysis.
               
               // 1. Substantial length: Commit regardless of punctuation (avoids buffer lockup on run-on sentences).
               const isSubstantial = trimmed.length > 80;
               
               // 2. Medium length + Strong Punctuation: Standard sentence completion.
               // We ignore short sentences (< 30 chars) even if they have punctuation, merging them into the next turn.
               const isCompleteSentence = trimmed.length > 30 && isStrongPunctuation;
               
               if (isSubstantial || isCompleteSentence) {
                   commitBuffer();
               } else {
                   // HOLD BUFFER:
                   // Keep the text in the buffer. The next transcription event will append to it.
                   // If the speaker stops talking (silence), the watchdog (2s) will flush it.
                   // This effectively merges "Hello." with "I'm here to discuss taxes."
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

    // Mark connected only after success
    isConnected = true;

    // Start Audio Processing Loop
    processor.onaudioprocess = (e) => {
      // 3. STABILITY: Use stable activeSession reference, no promise chaining here.
      if (!isConnected || !activeSession) return; 

      const inputData = e.inputBuffer.getChannelData(0);
      
      // Since context is 16000Hz, we don't need complex downsampling.
      // Just convert float32 to int16 PCM.
      const pcmData = floatTo16BitPCM(inputData);

      try {
          activeSession.sendRealtimeInput({ 
              media: {
                  mimeType: 'audio/pcm;rate=16000',
                  data: pcmData
              }
          });
      } catch (e) {
          console.error("Error sending audio chunk", e);
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
           
           // Close Audio Context
           if (audioContext.state !== 'closed') {
               await audioContext.close();
           }
           
           // Cleanup Stream Clone
           streamClone.getTracks().forEach(track => track.stop());

           // Close Session
           if (activeSession) {
                // We don't await this to prevent UI blocking on cleanup
               try {
                  activeSession.close();
               } catch (e) { console.log("Session close ignored", e); }
           }
       },
       flush: () => {
           // Manually reset the internal buffer
           currentVolatileBuffer = "";
           if (silenceTimer) clearTimeout(silenceTimer);
       }
    };
  } catch (err: any) {
    onError(err);
    // Emergency cleanup
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
