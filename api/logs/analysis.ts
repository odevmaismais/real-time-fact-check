import type { VercelRequest, VercelResponse } from '@vercel/node';
import { connectToDb } from '../../server/db';
import { ObjectId } from 'mongodb';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    return res.status(200).end(); //
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const db = await connectToDb();
    const { sessionId, segment, analysis } = req.body;

    if (!sessionId || !ObjectId.isValid(sessionId)) {
      return res.status(400).json({ error: 'Invalid Session ID' });
    }
    
    const logEntry = {
      sessionId: new ObjectId(sessionId as string),
      timestamp: new Date(),
      segmentId: segment.id,
      speaker: segment.speaker,
      transcriptText: segment.text,
      verdict: analysis.verdict,
      confidence: analysis.confidence,
      sentimentScore: analysis.sentimentScore,
      tokenUsage: analysis.tokenUsage || { promptTokens: 0, candidatesTokens: 0 },
      model: "gemini-2.0-flash-exp"
    };

    await db.collection('analyses').insertOne(logEntry);
    
    // Atomically increment token usage in the session document
    if (analysis.tokenUsage) {
        await db.collection('sessions').updateOne(
            { _id: new ObjectId(sessionId as string) },
            { 
                $inc: { 
                    totalInputTokens: analysis.tokenUsage.promptTokens,
                    totalOutputTokens: analysis.tokenUsage.candidatesTokens
                }
            }
        );
    }
    
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error logging analysis:", error);
    return res.status(500).json({ error: 'Failed to log analysis' });
  }
}