import type { VercelRequest, VercelResponse } from '@vercel/node';
import { connectToDb } from '../../_lib/db';
import { ObjectId } from 'mongodb';
 
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const db = await connectToDb();
    const { sessionId, totalCost, durationSeconds } = req.body;
    
    if (!sessionId || !ObjectId.isValid(sessionId)) {
      return res.status(400).json({ error: 'Invalid Session ID' });
    }

    await db.collection('sessions').updateOne(
        { _id: new ObjectId(sessionId as string) },
        { 
            $set: { 
                status: 'COMPLETED',
                endTime: new Date(),
                totalCost: parseFloat(totalCost || '0'),
                durationSeconds: durationSeconds || 0
            }
        }
    );
    
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error ending session:", error);
    return res.status(500).json({ error: 'Failed to end session' });
  }
}