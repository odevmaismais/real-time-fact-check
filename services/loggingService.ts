import { AnalysisResult } from '../types';

const API_BASE = '/api/logs';

export const logSessionStart = async (sessionId: string) => {
  try {
    await fetch(`${API_BASE}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
  } catch (e) {
    console.error("Falha ao logar inicio de sessão", e);
  }
};

export const logSessionEnd = async (sessionId: string) => {
  try {
    // navigator.sendBeacon é melhor para eventos de fechamento de página, 
    // mas fetch é ok se for clique de botão
    await fetch(`${API_BASE}/session/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
  } catch (e) {
    console.error("Falha ao logar fim de sessão", e);
  }
};

export const logAnalysis = async (
  sessionId: string,
  segmentId: string,
  text: string,
  analysis: AnalysisResult
) => {
  try {
    await fetch(`${API_BASE}/analysis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        segmentId,
        text,
        analysis
      }),
    });
  } catch (e) {
    console.error("Falha ao logar análise", e);
  }
};