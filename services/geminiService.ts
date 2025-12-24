import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { AnalysisResult, VerdictType } from "../types";

const MODEL_NAME = "gemini-2.0-flash-exp";
const LIVE_MODEL_NAME = "gemini-2.0-flash-exp";

export type LiveStatus = {
  type: 'info' | 'warning' | 'error';
  message: string;
};

// --- UTILS DE ÁUDIO ---

const cleanTranscriptText = (text: string): string => {
  if (!text) return "";
  return text.replace(/\s+/g, ' ').trim();
};

/**
 * Converte Float32 (Navegador) para Int16 (PCM) E faz o Downsample para 16kHz.
 */
function downsampleAndConvertToPCM(input: Float32Array, inputRate: number): ArrayBuffer {
    const targetRate = 16000;
    
    // Se já for 16k, apenas converte
    if (inputRate === targetRate) {
        const buffer = new ArrayBuffer(input.length * 2);
        const view = new DataView(buffer);
        for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]));
            const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
            view.setInt16(i * 2, val, true); // Little Endian
        }
        return buffer;
    }

    // Cálculo de Downsample simples
    const ratio = inputRate / targetRate;
    const newLength = Math.ceil(input.length / ratio);
    const buffer = new ArrayBuffer(newLength * 2);
    const view = new DataView(buffer);
    
    for (let i = 0; i < newLength; i++) {
        const offset = Math.floor(i * ratio);
        const valFloat = input[Math.min(offset, input.length - 1)];
        
        // Clamp e Conversão
        const s = Math.max(-1, Math.min(1, valFloat));
        const valInt = s < 0 ? s * 0x8000 : s * 0x7FFF;
        
        view.setInt16(i * 2, valInt, true); // Little Endian
    }
    return buffer;
}

/**
 * OTIMIZAÇÃO: Conversão iterativa robusta para Base64.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

// -------------------------------------------
// FACT CHECKING (Mantido Igual)
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
      sentimentScore: data.sentimentScore || 0,
      logicalFallacies: data.logicalFallacies || [],
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
// CONEXÃO LIVE (ROBUSTA)
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

  const stream = originalStream.clone();
  
  let shouldMaintainConnection = true;
  let activeSessionPromise: Promise<any> | null = null;
  
  // 🛡️ GATEKEEPER: Flag atômica de conexão
  let isConnected = false;

  let audioContext: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let gain: GainNode | null = null;
  let reconnectCount = 0;
  let currentBuffer = "";

  const ai = new GoogleGenAI({ apiKey });

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

  const establishConnection = () => {
    if (!shouldMaintainConnection) return;

    onStatus?.({ type: 'info', message: "CONECTANDO..." });

    try {
        const sessionPromise = ai.live.connect({
          model: LIVE_MODEL_NAME,
          config: {
            // FIX CRÍTICO: Modality.AUDIO impede erro 1007 e queda de conexão
            responseModalities: [Modality.AUDIO], 
            
            // Ativa ASR
            inputAudioTranscription: {
                model: LIVE_MODEL_NAME 
            },
            
            // System Prompt Passivo
            systemInstruction: {
                parts: [{ text: "You are a passive transcription system. Your ONLY job is to transcribe the input audio to Portuguese. Do NOT generate audio responses. Do NOT speak. Just listen and transcribe." }]
            },
            // Configuração de voz dummy (obrigatória para AUDIO modality, mesmo que não usada)
            speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
            }
          },
          callbacks: {
            onopen: () => {
               console.log("🟢 Conexão Estável (Audio Mode)");
               isConnected = true; 
               onStatus?.({ type: 'info', message: "ESCUTANDO" });
               reconnectCount = 0;
            },
            onmessage: (msg: LiveServerMessage) => {
               // Prioridade: Transcrição do Input (O que o usuário/áudio disse)
               const inputTranscript = msg.serverContent?.inputTranscription?.text;
               if (inputTranscript) {
                   handleText(inputTranscript);
               }

               // Se o modelo alucinar e gerar texto, capturamos também, mas ignoramos áudio
               const modelText = msg.serverContent?.modelTurn?.parts?.[0]?.text;
               if (modelText) {
                   handleText(modelText);
               }
            },
            onclose: (e) => {
               isConnected = false; // Bloqueio imediato
               console.log(`🔴 Conexão Fechada (Code: ${e.code})`);
               if (shouldMaintainConnection) {
                   onStatus?.({ type: 'warning', message: "RECONECTANDO..." });
                   setTimeout(establishConnection, 500); 
               }
            },
            onerror: (err) => {
                isConnected = false;
                console.error("🔴 Erro Socket:", err);
            }
          }
        });

        activeSessionPromise = sessionPromise;

        sessionPromise.catch(err => {
            isConnected = false;
            if (shouldMaintainConnection) {
                setTimeout(establishConnection, 1000); 
            }
        });

    } catch (err) {
        isConnected = false;
        if (shouldMaintainConnection) setTimeout(establishConnection, 1000);
    }
  };

  establishConnection();

  const initAudio = async () => {
      audioContext = new AudioContext();
      if (audioContext.state === 'suspended') await audioContext.resume();
      
      const streamRate = audioContext.sampleRate;
      console.log(`🎤 Input Rate: ${streamRate}Hz`);

      source = audioContext.createMediaStreamSource(stream);
      processor = audioContext.createScriptProcessor(4096, 1, 1);
      gain = audioContext.createGain();
      gain.gain.value = 0; // Mute local feedback

      processor.onaudioprocess = async (e) => {
          // GATEKEEPER 1: Verificação rápida
          if (!activeSessionPromise || !isConnected) return;

          const inputData = e.inputBuffer.getChannelData(0);
          
          try {
              // 1. Processamento de Áudio (Boost + Downsample)
              const boosted = new Float32Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) boosted[i] = inputData[i] * 5.0; 

              const pcmBuffer = downsampleAndConvertToPCM(boosted, streamRate);
              const base64Data = arrayBufferToBase64(pcmBuffer);

              // 2. Envio Seguro (Race Condition Proof)
              activeSessionPromise.then(async (session) => {
                 // GATEKEEPER 2: Verificação final pré-envio
                 if (!isConnected) return;

                 try {
                     await session.sendRealtimeInput([{ 
                          mimeType: "audio/pcm;rate=16000",
                          data: base64Data
                      }]);
                 } catch (sendError: any) {
                     // SILENT CATCH: Ignora erros de "Socket Closed" durante transições
                     if (sendError.message?.includes("CLOSING") || sendError.message?.includes("CLOSED") || !isConnected) {
                         isConnected = false; 
                     } else {
                         // Apenas loga se for erro real de payload
                         console.warn("Drop de pacote de áudio (esperado em reconexão)");
                     }
                 }
              }).catch(() => {
                  // Catch da Promise do Session (raro, mas seguro)
                  isConnected = false;
              });

          } catch (err) {
              console.error("Erro crítico processador:", err);
          }
      };

      source.connect(processor);
      processor.connect(gain);
      gain.connect(audioContext.destination);
  };

  initAudio();

  return {
       disconnect: async () => {
           console.log("🛑 Finalizando Sessão...");
           shouldMaintainConnection = false;
           isConnected = false; // Killswitch
           
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