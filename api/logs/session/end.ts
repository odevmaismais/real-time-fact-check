import { VercelRequest, VercelResponse } from '@vercel/node';
import { connectToDb } from '../../_lib/db.js';
import { ObjectId } from 'mongodb';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'POST') {
    try {
      const { sessionId } = req.body;
      if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

      const { db } = await connectToDb();
      await db.collection('sessions').updateOne(
        { _id: new ObjectId(sessionId) },
        { $set: { endedAt: new Date() } }
      );
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error("Erro DB:", error);
      return res.status(500).json({ error: 'Erro ao finalizar sessão' });
    }
  }
  return res.status(405).json({ error: 'Method not allowed' });
}