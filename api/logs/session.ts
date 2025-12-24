import type { VercelRequest, VercelResponse } from '@vercel/node';
import { connectToDatabase } from '../_lib/db';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    const { db } = await connectToDatabase();

    await db.collection('sessions').insertOne({
        session_id: sessionId,
        started_at: new Date(),
        status: 'active',
        metadata: {
            user_agent: req.headers['user-agent'],
            ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress
        }
    });

    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('Mongo Error (Session Start):', error);
    return res.status(500).json({ error: error.message });
  }
}
