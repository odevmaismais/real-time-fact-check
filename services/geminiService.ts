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
    if (inputRate === 16000) return floatTo16BitPCM(input);
    const ratio = inputRate / 16000;
    const newLength = Math.ceil(input.length / ratio);
    const output = new Int16Array(newLength);
    for (let i = 0; i < newLength; i++) {
        const offset = Math.floor(i * ratio);
        const val = input[Math.min(offset, input.length - 1)];
        output[i] = Math.max(-1, Math.min(1, val)) < 0 ? Math.max(-1, Math.min(1, val)) * 0x8000 : Math.max(-1, Math.min(1, val)) * 0x7FFF;
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
      sentimentScore: 0,
      logicalFallacies: [],
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
// CONEXÃO LIVE (OMNIVOROUS STREAM)
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

  // Clona o stream para evitar conflitos
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

  const transcriptTool: FunctionDeclaration = {
      name: "submit_transcript",
      description: "Submits the raw text transcription.",
      parameters: {
          type: Type.OBJECT,
          properties: {
              text: {
                  type: Type.STRING,
                  description: "The transcribed text."
              }
          },
          required: ["text"]
      }
  };

  const handleText = (raw: string) => {
      const text = cleanTranscriptText(raw);
      if (text.length > 0) {
          console.log("📝 RECEBIDO:", text); // Debug essencial
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

    console.log(`📡 Conectando... (Tentativa ${reconnectCount + 1})`);
    onStatus?.({ type: 'info', message: reconnectCount > 0 ? "RECONECTANDO..." : "CONECTANDO..." });

    try {
        let sessionPromise: Promise<any>;

        sessionPromise = ai.live.connect({
          model: LIVE_MODEL_NAME,
          config: {
            responseModalities: [Modality.AUDIO],
            // @ts-ignore
            inputAudioTranscription: {}, 
            tools: [{ functionDeclarations: [transcriptTool] }],
            systemInstruction: {
                parts: [{ text: "You are a transcriber. Listen to the Portuguese audio. Output the text immediately using the `submit_transcript` tool OR by simply replying with the text. Do NOT speak audio." }]
            },
          },
          callbacks: {
            onopen: () => {
               console.log("🟢 Conectado!");
               onStatus?.({ type: 'info', message: "ESCUTANDO" });
               reconnectCount = 0;
            },
            onmessage: (msg: LiveServerMessage) => {
               // DEBUG: Ver o que está chegando (pode remover depois)
               // console.log("RAW:", JSON.stringify(msg.serverContent).substring(0, 100));

               // 1. Fonte: Input Transcription (Eco rápido do usuário)
               // Essa é a fonte mais rápida e comum para transcrição em tempo real
               const inputTrx = msg.serverContent?.inputTranscription?.text;
               if (inputTrx) handleText(inputTrx);

               // 2. Fonte: Resposta do Modelo (Texto direto)
               const parts = msg.serverContent?.modelTurn?.parts;
               if (parts) {
                   for (const part of parts) {
                       // 2a. Via Texto Normal
                       if (part.text) {
                           handleText(part.text);
                       }
                       // 2b. Via Chamada de Função
                       if (part.functionCall) {
                           const fc = part.functionCall;
                           if (fc.name === 'submit_transcript') {
                               const args = fc.args as any;
                               if (args && args.text) handleText(args.text);
                               
                               // Responde OK para a função (para destravar o modelo)
                               sessionPromise.then(async (session) => {
                                    await session.sendToolResponse({
                                        functionResponses: [{
                                            id: fc.id,
                                            name: fc.name,
                                            response: { result: "ok" }
                                        }]
                                    });
                               }).catch(() => {});
                           }
                       }
                   }
               }
            },
            onclose: (e) => {
               if (shouldMaintainConnection) {
                   console.log("⚠️ Conexão caiu, reconectando...");
                   reconnectCount++;
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

  // AUDIO PIPELINE
  const initAudio = async () => {
      audioContext = new AudioContext();
      if (audioContext.state === 'suspended') await audioContext.resume();
      
      const streamRate = audioContext.sampleRate;
      source = audioContext.createMediaStreamSource(stream);
      processor = audioContext.createScriptProcessor(4096, 1, 1);
      gain = audioContext.createGain();
      gain.gain.value = 0;

      processor.onaudioprocess = async (e) => {
          if (!activeSessionPromise) return;

          const inputData = e.inputBuffer.getChannelData(0);
          
          if (Math.random() < 0.05) console.log("💓 Audio Pulse");

          // Boost de Volume (5x) para garantir que o modelo ouça
          const boosted = new Float32Array(inputData.length);
          let vol = 0;
          for (let i = 0; i < inputData.length; i++) {
              boosted[i] = inputData[i] * 5.0; 
              vol += Math.abs(inputData[i]);
          }

          if (vol < 0.0001) return;

          try {
              const pcm16k = downsampleTo16k(boosted, streamRate);
              const base64Data = arrayBufferToBase64(pcm16k.buffer as ArrayBuffer);

              activeSessionPromise.then(async (session) => {
                 await session.sendRealtimeInput([{ 
                      mimeType: "audio/pcm;rate=16000",
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