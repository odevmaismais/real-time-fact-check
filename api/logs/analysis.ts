import { VercelRequest, VercelResponse } from '@vercel/node';
import { connectToDb } from '../_lib/db.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'POST') {
    try {
      const { db } = await connectToDb();
      const analysisData = req.body;
      await db.collection('analyses').insertOne({
        ...analysisData,
        createdAt: new Date()
      });
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error("Erro DB:", error);
      return res.status(500).json({ error: 'Erro ao salvar análise' });
    }
  }
  return res.status(405).json({ error: 'Method not allowed' });
}