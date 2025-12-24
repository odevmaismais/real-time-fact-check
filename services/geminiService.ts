import { GoogleGenAI, LiveServerMessage, Modality, SchemaType } from "@google/genai";
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
// CONEXÃO LIVE (STREAMING COM AUTO-RECONEXÃO)
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
  
  let shouldReconnect = true;
  let activeSession: any = null;
  let audioContext: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let currentBuffer = "";

  const ai = new GoogleGenAI({ apiKey });

  const handleTranscriptText = (text: string) => {
      const clean = cleanTranscriptText(text);
      if (clean) {
          console.log("📝 TRANSCRITO:", clean);
          currentBuffer += " " + clean;
          onTranscript({ text: currentBuffer.trim(), speaker: "DEBATE", isFinal: false });
          if (currentBuffer.length > 100 || clean.match(/[.!?]$/)) {
              onTranscript({ text: currentBuffer.trim(), speaker: "DEBATE", isFinal: true });
              currentBuffer = "";
          }
      }
  };

  const connect = async () => {
      try {
          if (!audioContext || audioContext.state === 'closed') {
              audioContext = new AudioContext();
          }
          if (audioContext.state === 'suspended') await audioContext.resume();

          const streamRate = audioContext.sampleRate;
          console.log(`🔄 (Re)Conectando Gemini... Rate: ${streamRate}`);

          activeSession = await ai.live.connect({
              model: LIVE_MODEL_NAME,
              config: {
                  responseModalities: [Modality.AUDIO], 
                  // @ts-ignore
                  inputAudioTranscription: {}, 
                  tools: [{
                      functionDeclarations: [{
                          name: "submit_transcript",
                          description: "Submit the transcribed text from the audio stream.",
                          parameters: {
                              // CORREÇÃO AQUI: Usando SchemaType
                              type: SchemaType.OBJECT,
                              properties: {
                                  text: { type: SchemaType.STRING, description: "The transcribed text in Portuguese." }
                              },
                              required: ["text"]
                          }
                      }]
                  }],
                  systemInstruction: {
                      parts: [{ text: "You are a transcriber. Listen to the audio. Whenever you detect speech, IMMEDIATELY call the function 'submit_transcript' with the exact Portuguese text. Do NOT speak. Do NOT reply with audio." }]
                  }
              },
              callbacks: {
                  onopen: () => onStatus?.({ type: 'info', message: "CONECTADO (AUTO-REC)" }),
                  onmessage: (msg: LiveServerMessage) => {
                      const fc = msg.serverContent?.modelTurn?.parts?.find(p => p.functionCall);
                      if (fc && fc.functionCall?.name === 'submit_transcript') {
                          const args = fc.functionCall.args as any;
                          if (args?.text) handleTranscriptText(args.text);
                      }
                      
                      const t1 = msg.serverContent?.inputTranscription?.text;
                      if (t1) handleTranscriptText(t1);
                  },
                  onclose: (e) => {
                      console.log("⚠️ Conexão fechada:", e);
                      if (shouldReconnect) {
                          onStatus?.({ type: 'warning', message: "RECONECTANDO..." });
                          setTimeout(connect, 100); 
                      }
                  },
                  onerror: (e) => console.error("Erro stream:", e)
              }
          });

          if (!processor) {
              source = audioContext.createMediaStreamSource(stream);
              processor = audioContext.createScriptProcessor(4096, 1, 1);
              
              processor.onaudioprocess = async (e) => {
                  if (!shouldReconnect || !activeSession) return;

                  const inputData = e.inputBuffer.getChannelData(0);
                  
                  if (Math.random() < 0.05) console.log("💓 Audio Pulse (Processing)");

                  const boosted = new Float32Array(inputData.length);
                  for (let i = 0; i < inputData.length; i++) boosted[i] = inputData[i] * 5.0;

                  try {
                      const pcm16k = downsampleTo16k(boosted, streamRate);
                      const base64Data = arrayBufferToBase64(pcm16k.buffer as ArrayBuffer);
                      
                      await activeSession.sendRealtimeInput([{ 
                          mimeType: "audio/pcm;rate=16000",
                          data: base64Data
                      }]);
                  } catch (err) {
                  }
              };

              source.connect(processor);
              processor.connect(audioContext.destination); 
          }
 
      } catch (err: any) {
          console.error("Falha na conexão:", err);
          if (shouldReconnect) setTimeout(connect, 1000);
      }
  };

  connect();

  return {
      disconnect: async () => {
          shouldReconnect = false;
          console.log("🛑 Parando tudo...");
          if (activeSession) await activeSession.close();
          if (source) source.disconnect();
          if (processor) processor.disconnect();
          if (audioContext) await audioContext.close();
          stream.getTracks().forEach(t => t.stop()); 
      },
      flush: () => { currentBuffer = ""; }
  };
}