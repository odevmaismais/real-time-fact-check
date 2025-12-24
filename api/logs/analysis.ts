import type { VercelRequest, VercelResponse } from '@vercel/node';
import { connectToDatabase } from '../../_lib/db';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Configuração CORS (Padrão)
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { sessionId, segmentId, text, analysis } = req.body;

    // 1. Validação de Segurança
    if (!sessionId || !segmentId || !text) {
        return res.status(400).json({ error: "Dados obrigatórios faltando (sessionId, segmentId, text)" });
    }

    const { db } = await connectToDatabase();

    // 2. Salvar Segmento (Idempotente)
    // Se o segmento já existe, não faz nada ($setOnInsert só roda na criação)
    await db.collection('debate_segments').updateOne(
        { segment_id: segmentId },
        { 
            $setOnInsert: {
                session_id: sessionId,
                text_content: text,
                created_at: new Date()
            }
        },
        { upsert: true }
    );

    // 3. Salvar Log de Análise
    await db.collection('analysis_logs').insertOne({
        session_id: sessionId,
        segment_id: segmentId,
        verdict: analysis?.verdict || 'UNVERIFIABLE',
        confidence: analysis?.confidence || 0,
        explanation: analysis?.explanation || '',
        raw_response: analysis, // MongoDB salva JSON nativamente, muito melhor!
        created_at: new Date()
    });

    return res.status(200).json({ success: true });

  } catch (error: any) {
    console.error('Mongo Error (Analysis):', error);
    return res.status(500).json({ error: 'Erro interno', details: error.message });
  }
}
