import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
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

// Reintroduzindo Downsampling robusto para garantir compatibilidade com a API (16kHz PCM)
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
        // Clamp manual para evitar distorção (clipping)
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
    const e = new Error("API Key missing");
    onError(e);
    return { disconnect: async () => {}, flush: () => {} };
  }
  
  const ai = new GoogleGenAI({ apiKey });
  
  // Setup AudioContext
  const audioContext = new AudioContext(); 
  if (audioContext.state === 'suspended') await audioContext.resume();

  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  
  // Gain node nulo para manter o pipeline ativo sem eco local (hack para Chrome/Edge)
  // Isso força o navegador a processar o áudio sem tocar nas caixas de som do usuário
  const gain = audioContext.createGain();
  gain.gain.value = 0; 
  
  let currentBuffer = "";
  let isConnected = false;
  let activeSession: any = null;

  const handleText = (raw: string) => {
      const text = cleanTranscriptText(raw);
      if (text.length > 0) {
          // console.log("📝 RECEBIDO:", text); // Debug limpo
          currentBuffer += " " + text;
          onTranscript({ text: currentBuffer.trim(), speaker: "DEBATE", isFinal: false });
          
          if (currentBuffer.length > 80 || text.match(/[.!?]$/)) {
              onTranscript({ text: currentBuffer.trim(), speaker: "DEBATE", isFinal: true });
              currentBuffer = "";
          }
      }
  };

  try {
    const streamRate = audioContext.sampleRate;
    console.log(`🎤 Configurando Áudio: Input=${streamRate}Hz -> Output=16000Hz`);

    activeSession = await ai.live.connect({
      model: LIVE_MODEL_NAME,
      config: {
        // [CRÍTICO] A API Live EXIGE Modality.AUDIO para manter a conexão websocket aberta.
        // Se usar TEXT, ela fecha o socket após a primeira resposta.
        responseModalities: [Modality.AUDIO], 
        
        speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
        },
        
        // Habilita transcrição de entrada em PT-BR
        // @ts-ignore
        inputAudioTranscription: { 
            languageCode: "pt-BR" 
        }, 
        
        systemInstruction: {
            parts: [{ text: "Você é um transcritor passivo de debates. Sua ÚNICA função é converter o áudio recebido em texto (transcrição). Mantenha silêncio absoluto no canal de áudio de saída. Apenas transcreva." }]
        }
      },
      callbacks: {
        onopen: () => {
           console.log("🟢 Conectado ao Gemini Live!");
           isConnected = true;
           onStatus?.({ type: 'info', message: "ESCUTANDO..." });
        },
        onmessage: (msg: LiveServerMessage) => {
           // A transcrição do que estamos enviando vem em 'inputTranscription'
           const t1 = msg.serverContent?.inputTranscription?.text;
           
           if (t1) handleText(t1);
           
           if (msg.serverContent?.turnComplete && currentBuffer) {
               onTranscript({ text: currentBuffer.trim(), speaker: "DEBATE", isFinal: true });
               currentBuffer = "";
           }
        },
        onclose: (e) => {
           console.log("🔴 Fechado:", e);
           if(isConnected) onStatus?.({ type: 'warning', message: `DESCONECTADO` });
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
      
      // Monitor de Volume (RMS) para debug
      let sumSquares = 0;
      for (let i = 0; i < inputData.length; i++) {
        sumSquares += inputData[i] * inputData[i];
      }
      const rms = Math.sqrt(sumSquares / inputData.length);
      
      // Se estiver muito silencioso por muito tempo, alerta no console
      if (rms < 0.001 && Math.random() < 0.005) {
          console.warn("⚠️ Áudio muito baixo ou silêncio detectado no stream de entrada.");
      }

      try {
          // Downsample para 16kHz para estabilidade da API
          const pcm16k = downsampleTo16k(inputData, streamRate);
          const base64Data = arrayBufferToBase64(pcm16k.buffer as ArrayBuffer);

          activeSession.sessionPromise.then(async () => {
             await activeSession.sendRealtimeInput([{ 
                  mimeType: "audio/pcm;rate=16000",
                  data: base64Data
              }]);
          });
      } catch (err) {
          // Ignora erros de envio momentâneos (ex: rede oscilando)
      }
    };

    source.connect(processor);
    // Truque para manter o ScriptProcessor ativo no Chrome: conectar ao destino (mas com volume 0)
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