import { GoogleGenAI, LiveServerMessage, Modality, FunctionDeclaration, Type } from "@google/genai";
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

function downsampleTo16k(input: Float32Array, inputRate: number): Int16Array {
    if (inputRate === 16000) {
        return floatTo16BitPCM(input);
    }
    const ratio = inputRate / 16000;
    const newLength = Math.ceil(input.length / ratio);
    const output = new Int16Array(newLength);
    
    for (let i = 0; i < newLength; i++) {
        const offset = Math.floor(i * ratio);
        const val = input[Math.min(offset, input.length - 1)];
        const s = Math.max(-1, Math.min(1, val));
        output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return output;
}

function floatTo16BitPCM(input: Float32Array): Int16Array {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return output;
}

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
  
  const audioContext = new AudioContext(); 
  if (audioContext.state === 'suspended') await audioContext.resume();

  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const gain = audioContext.createGain();
  gain.gain.value = 0; // Mute local output
  
  let currentBuffer = "";
  let isConnected = false;
  let activeSession: any = null;
  
  // Buffer e Acumuladores de Áudio
  let audioAccumulator: Float32Array = new Float32Array(0);
  const CHUNK_THRESHOLD = 3; 
  let chunkCounter = 0;

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

  // 1. TOOL DEFINITION
  const transcriptTool: FunctionDeclaration = {
      name: "submit_transcript",
      description: "Submits the raw text transcription of the audio heard.",
      parameters: {
          type: Type.OBJECT,
          properties: {
              text: {
                  type: Type.STRING,
                  description: "The exact Portuguese text transcribed from the audio."
              }
          },
          required: ["text"]
      }
  };

  try {
    const streamRate = audioContext.sampleRate;
    console.log(`🎤 Iniciando (Function Calling Mode): Input=${streamRate}Hz`);

    activeSession = await ai.live.connect({
      model: LIVE_MODEL_NAME,
      config: {
        responseModalities: [Modality.AUDIO], // Mantém a conexão viva
        speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
        },
        // 2. SYSTEM INSTRUCTION ESTRATÉGICA
        systemInstruction: {
            parts: [{ text: "You are a dedicated transcription agent. Your ONLY job is to listen to the Portuguese audio and IMMEDIATELLY call the function `submit_transcript` passing the exact transcribed text. Do not reply with audio. Do not summarize. Just transcribe." }]
        },
        tools: [{ functionDeclarations: [transcriptTool] }],
        // Backup: ativa transcrição passiva caso o function calling falhe
        // @ts-ignore
        inputAudioTranscription: {}, 
      },
      callbacks: {
        onopen: () => {
           console.log("🟢 Conectado!");
           isConnected = true;
           onStatus?.({ type: 'info', message: "ESCUTANDO..." });
        },
        onmessage: (msg: LiveServerMessage) => {
           // 3. PROCESSAMENTO DE FUNCTION CALL
           const parts = msg.serverContent?.modelTurn?.parts;
           if (parts) {
               for (const part of parts) {
                   if (part.functionCall) {
                       const fc = part.functionCall;
                       if (fc.name === 'submit_transcript') {
                           const args = fc.args as any;
                           if (args && args.text) {
                               handleText(args.text);
                           }

                           // IMPORTANTE: Enviar resposta da tool para completar o turno
                           activeSession.sessionPromise.then(async () => {
                                await activeSession.sendToolResponse({
                                    functionResponses: [{
                                        id: fc.id,
                                        name: fc.name,
                                        response: { result: "ok" }
                                    }]
                                });
                           });
                       }
                   }
               }
           }

           // Backup: Transcrição passiva nativa
           const tInput = msg.serverContent?.inputTranscription?.text;
           if (tInput) handleText(tInput);
           
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
      
      // Boost de Volume
      const boosted = new Float32Array(inputData.length);
      let vol = 0;
      for (let i = 0; i < inputData.length; i++) {
          boosted[i] = inputData[i] * 5.0;
          vol += Math.abs(inputData[i]);
      }

      // Bufferização
      const temp = new Float32Array(audioAccumulator.length + boosted.length);
      temp.set(audioAccumulator);
      temp.set(boosted, audioAccumulator.length);
      audioAccumulator = temp;
      chunkCounter++;

      if (chunkCounter >= CHUNK_THRESHOLD) {
          if(vol > 0.01) {
              // console.log("📡 Enviando Buffer..."); 
          }
          
          try {
              const pcm16k = downsampleTo16k(audioAccumulator, streamRate);
              const base64Data = arrayBufferToBase64(pcm16k.buffer as ArrayBuffer);

              await activeSession.sendRealtimeInput([{ 
                  mimeType: "audio/pcm;rate=16000",
                  data: base64Data
              }]);
          } catch (err) {
              // Silencioso para não poluir logs
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