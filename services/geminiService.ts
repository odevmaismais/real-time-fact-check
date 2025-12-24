import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { AnalysisResult, VerdictType } from "../types";

const MODEL_NAME = "gemini-2.0-flash-exp";
const LIVE_MODEL_NAME = "gemini-2.0-flash-exp";

export type LiveStatus = {
  type: 'info' | 'warning' | 'error';
  message: string;
};

const cleanTranscriptText = (text: string): string => {
  if (!text) return "";
  return text.replace(/\s+/g, ' ').trim();
};

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
// CONEXÃO LIVE (NATIVE STREAM SIMPLIFICADO)
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
          console.log("📝 RECEBIDO:", text); 
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
            // [MUDANÇA] Voltamos para TEXT. Se o modelo fechar a conexão (Code 1000), 
            // a lógica de auto-reconnect lida com isso. É mais seguro que áudio mudo.
            responseModalities: [Modality.TEXT], 
            // @ts-ignore
            inputAudioTranscription: {}, 
            systemInstruction: {
                parts: [{ text: "You are a transcriber. Listen to the Portuguese audio and return the text transcription exactly. Do not add explanations." }]
            },
          },
          callbacks: {
            onopen: () => {
               console.log("🟢 Conectado!");
               onStatus?.({ type: 'info', message: "ESCUTANDO" });
               reconnectCount = 0;
            },
            onmessage: (msg: LiveServerMessage) => {
               // Verifica todas as fontes possíveis de texto
               const t1 = msg.serverContent?.inputTranscription?.text;
               const t2 = msg.serverContent?.modelTurn?.parts?.[0]?.text;
               
               if (t1) handleText(t1);
               if (t2) handleText(t2);
            },
            onclose: (e) => {
               console.log("⚠️ Conexão caiu:", e);
               if (shouldMaintainConnection) {
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

  const initAudio = async () => {
      audioContext = new AudioContext();
      if (audioContext.state === 'suspended') await audioContext.resume();
      
      const streamRate = audioContext.sampleRate;
      console.log(`🎤 Taxa de Áudio Nativa: ${streamRate}Hz`); // Debug

      source = audioContext.createMediaStreamSource(stream);
      // Buffer maior (16384) para menos carga na CPU
      processor = audioContext.createScriptProcessor(16384, 1, 1);
      gain = audioContext.createGain();
      gain.gain.value = 0;

      processor.onaudioprocess = async (e) => {
          if (!activeSessionPromise) return;

          const inputData = e.inputBuffer.getChannelData(0);
          
          if (Math.random() < 0.05) console.log("💓 Audio Pulse");

          // Boost de Volume (5x)
          const boosted = new Float32Array(inputData.length);
          let vol = 0;
          for (let i = 0; i < inputData.length; i++) {
              boosted[i] = inputData[i] * 5.0; 
              vol += Math.abs(inputData[i]);
          }

          if (vol < 0.0001) return;

          try {
              // [CRÍTICO] Envia na taxa NATIVA (sem downsample manual arriscado)
              // O Gemini 2.0 suporta 48k se o cabeçalho estiver certo
              const pcmData = floatTo16BitPCM(boosted);
              const base64Data = arrayBufferToBase64(pcmData.buffer as ArrayBuffer);

              activeSessionPromise.then(async (session) => {
                 await session.sendRealtimeInput([{ 
                      mimeType: `audio/pcm;rate=${streamRate}`, // Usa a taxa real (ex: 48000)
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