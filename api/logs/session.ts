import type { VercelRequest, VercelResponse } from '@vercel/node';
import { connectToDb } from '../../server/db'; 

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  // Handle Preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const db = await connectToDb();
    
    const sessionData = {
      startTime: new Date(),
      status: 'ACTIVE',
      inputMode: req.body.inputMode,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      userAgent: req.headers['user-agent'] || 'unknown'
    };
    
    const result = await db.collection('sessions').insertOne(sessionData);
    
    return res.status(200).json({ sessionId: result.insertedId });
  } catch (error) {
    console.error("Error creating session:", error);
    return res.status(500).json({ error: 'Failed to create session' });
  }
}