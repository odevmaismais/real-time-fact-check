import type { VercelRequest, VercelResponse } from '@vercel/node';
import { connectToDatabase } from '../_lib/db.js'; // Adicionado .js

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { sessionId, segmentId, text, analysis } = req.body;

    if (!sessionId || !segmentId || !text) {
        return res.status(400).json({ error: "Dados obrigatórios faltando" });
    }

    const { db } = await connectToDatabase();

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

    await db.collection('analysis_logs').insertOne({
        session_id: sessionId,
        segment_id: segmentId,
        verdict: analysis?.verdict || 'UNVERIFIABLE',
        confidence: analysis?.confidence || 0,
        explanation: analysis?.explanation || '',
        raw_response: analysis,
        created_at: new Date()
    });

    return res.status(200).json({ success: true });

  } catch (error: any) {
    console.error('Mongo Error:', error);
    return res.status(500).json({ error: error.message });
  }
}