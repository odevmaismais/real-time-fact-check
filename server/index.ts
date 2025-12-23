import express from 'express';
import cors from 'cors';
import { connectToDb, getDb } from './db';
import { ObjectId } from 'mongodb';

const app = express();
const PORT = 3001;

app.use(cors() as any);
app.use(express.json() as any);

// Initialize DB connection but don't block server startup
connectToDb().catch(err => console.error("Initial DB connection failed", err));

// 1. Create a new Session
app.post('/api/logs/session', async (req, res) => {
  try {
    const db = getDb(); // might throw if not ready
    const sessionData = {
      startTime: new Date(),
      status: 'ACTIVE',
      inputMode: req.body.inputMode,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      userAgent: req.headers['user-agent']
    };
    
    const result = await db.collection('sessions').insertOne(sessionData);
    res.json({ sessionId: result.insertedId });
  } catch (error) {
    console.error("Error creating session:", error);
    res.status(500).json({ error: 'Failed to create session or DB not ready' });
  }
});

// 2. Log an Analysis Result
app.post('/api/logs/analysis', async (req, res) => {
  try {
    const db = getDb();
    const { sessionId, segment, analysis } = req.body;
    
    const logEntry = {
      sessionId: new ObjectId(sessionId),
      timestamp: new Date(),
      segmentId: segment.id,
      speaker: segment.speaker,
      transcriptText: segment.text,
      verdict: analysis.verdict,
      confidence: analysis.confidence,
      sentimentScore: analysis.sentimentScore,
      tokenUsage: analysis.tokenUsage || { promptTokens: 0, candidatesTokens: 0 },
      model: "gemini-3-flash-preview"
    };

    await db.collection('analyses').insertOne(logEntry);
    
    // Increment tokens in session
    if (analysis.tokenUsage) {
        await db.collection('sessions').updateOne(
            { _id: new ObjectId(sessionId) },
            { 
                $inc: { 
                    totalInputTokens: analysis.tokenUsage.promptTokens,
                    totalOutputTokens: analysis.tokenUsage.candidatesTokens
                }
            }
        );
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error("Error logging analysis:", error);
    res.status(500).json({ error: 'Failed to log analysis' });
  }
});

// 3. End Session / Update Stats
app.post('/api/logs/session/end', async (req, res) => {
  try {
    const db = getDb();
    const { sessionId, totalCost, durationSeconds } = req.body;
    
    await db.collection('sessions').updateOne(
        { _id: new ObjectId(sessionId) },
        { 
            $set: { 
                status: 'COMPLETED',
                endTime: new Date(),
                totalCost: parseFloat(totalCost),
                durationSeconds: durationSeconds
            }
        }
    );
    res.json({ success: true });
  } catch (error) {
    console.error("Error ending session:", error);
    res.status(500).json({ error: 'Failed to end session' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});