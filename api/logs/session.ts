import { VercelRequest, VercelResponse } from '@vercel/node';
import { connectToDb } from '../_lib/db.js'; // Note o .js

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'POST') {
    try {
      const { db } = await connectToDb();
      const sessionData = req.body;
      const result = await db.collection('sessions').insertOne({
        ...sessionData,
        createdAt: new Date()
      });
      return res.status(200).json({ sessionId: result.insertedId });
    } catch (error) {
      console.error("Erro DB:", error);
      return res.status(500).json({ error: 'Erro ao criar sessão' });
    }
  }
  return res.status(405).json({ error: 'Method not allowed' });
}