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
        // Clamp manual
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
// CONEXÃO LIVE (PERSISTENT TOOL STREAM)
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
  
  // Audio Context Setup (Persistente)
  const audioContext = new AudioContext(); 
  if (audioContext.state === 'suspended') await audioContext.resume();

  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const gain = audioContext.createGain();
  gain.gain.value = 0; // Mute local
  
  let currentBuffer = "";
  let shouldMaintainConnection = true;
  // Use a Promise to track the session, as recommended for race condition handling
  let activeSessionPromise: Promise<any> | null = null;
  let reconnectCount = 0;

  // 1. TOOL DEFINITION
  const transcriptTool: FunctionDeclaration = {
      name: "submit_transcript",
      description: "Submits the raw text transcription of the Portuguese speech detected.",
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
          console.log("📝 TRANSCRITO:", text);
          currentBuffer += " " + text;
          onTranscript({ text: currentBuffer.trim(), speaker: "DEBATE", isFinal: false });
          
          if (currentBuffer.length > 80 || text.match(/[.!?]$/)) {
              onTranscript({ text: currentBuffer.trim(), speaker: "DEBATE", isFinal: true });
              currentBuffer = "";
          }
      }
  };

  // 2. FUNÇÃO DE CONEXÃO RECURSIVA (AUTO-HEALING)
  const establishConnection = () => {
    if (!shouldMaintainConnection) return;

    console.log(`📡 Estabelecendo conexão... (Tentativa ${reconnectCount + 1})`);
    onStatus?.({ type: 'info', message: reconnectCount > 0 ? "RECONECTANDO..." : "CONECTANDO..." });

    try {
        // Capture the promise for this specific connection attempt
        // This is used inside callbacks to ensure we refer to the correct session logic
        let sessionPromise: Promise<any>;

        sessionPromise = ai.live.connect({
          model: LIVE_MODEL_NAME,
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
            },
            systemInstruction: {
                parts: [{ text: "You are a specialized audio transcriber. Listen continuously. Whenever you hear speech in Portuguese, IMMEDIATELY call the `submit_transcript` function with the text. Do NOT speak. Do NOT reply with audio. Do NOT summarize." }]
            },
            tools: [{ functionDeclarations: [transcriptTool] }],
          },
          callbacks: {
            onopen: () => {
               console.log("🟢 Conectado!");
               onStatus?.({ type: 'info', message: "ESCUTANDO" });
               reconnectCount = 0;
            },
            onmessage: (msg: LiveServerMessage) => {
               // Verifica chamadas de ferramenta
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

                               // Responde OK para a tool para liberar o modelo para o próximo turno
                               // FIX: Use sessionPromise directly
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
               console.log("⚠️ Conexão fechada pelo servidor:", e);
               // Lógica de Auto-Reconexão
               if (shouldMaintainConnection) {
                   reconnectCount++;
                   setTimeout(establishConnection, 100); // Reconexão imediata
               } else {
                   onStatus?.({ type: 'warning', message: "DESCONECTADO" });
               }
            },
            onerror: (err) => {
               console.error("🔴 Erro de Socket:", err);
               // Deixa o onclose lidar com a reconexão
            }
          }
        });

        activeSessionPromise = sessionPromise;

        // Handle connection failure for the initial promise (optional, mostly handled by callbacks)
        sessionPromise.catch(err => {
            console.error("Erro ao conectar (Promise catch):", err);
            if (shouldMaintainConnection) {
                setTimeout(establishConnection, 1000); 
            } else {
                 onError(err as Error);
            }
        });

    } catch (err) {
        console.error("Erro ao conectar:", err);
        if (shouldMaintainConnection) {
            setTimeout(establishConnection, 1000);
        } else {
             onError(err as Error);
        }
    }
  };

  // Inicia primeira conexão
  establishConnection();

  // 3. PROCESSAMENTO DE ÁUDIO (GLOBAL E CONTÍNUO)
  // O processador roda independentemente da sessão estar conectada ou não.
  // Assim que a sessão volta, o áudio volta a fluir.
  const streamRate = audioContext.sampleRate;
  
  processor.onaudioprocess = async (e) => {
      // Só processa se tivermos uma sessão ativa (promessa)
      if (!activeSessionPromise) return;

      const inputData = e.inputBuffer.getChannelData(0);
      
      // Volume Boost (5x)
      const boosted = new Float32Array(inputData.length);
      let vol = 0;
      for (let i = 0; i < inputData.length; i++) {
          boosted[i] = inputData[i] * 5.0;
          vol += Math.abs(inputData[i]);
      }

      // Se houver silêncio absoluto, evite enviar para economizar banda/processamento
      if (vol < 0.0001) return;

      try {
          // Downsample para 16k e Envio Imediato (Sem Buffer)
          const pcm16k = downsampleTo16k(boosted, streamRate);
          const base64Data = arrayBufferToBase64(pcm16k.buffer as ArrayBuffer);

          // Dispara e esquece (fire and forget)
          // Usamos a referência `activeSessionPromise`
          activeSessionPromise.then(async (session) => {
             await session.sendRealtimeInput([{ 
                  mimeType: "audio/pcm;rate=16000",
                  data: base64Data
              }]);
          }).catch(() => {
              // Ignore sending errors if session is closed/closing
          });
      } catch (err) {
          // Erros de envio são esperados durante trocas de conexão
      }
  };

  source.connect(processor);
  processor.connect(gain);
  gain.connect(audioContext.destination);

  return {
       disconnect: async () => {
           console.log("🛑 Encerrando controlador...");
           shouldMaintainConnection = false;
           source.disconnect();
           processor.disconnect();
           gain.disconnect();
           if (activeSessionPromise) {
               try {
                   const session = await activeSessionPromise;
                   session.close();
               } catch (e) { /* ignore */ }
           }
           if (audioContext.state !== 'closed') await audioContext.close();
       },
       flush: () => { currentBuffer = ""; }
    };
}