import { MongoClient, Db } from 'mongodb';

const URI = process.env.MONGODB_URI || "mongodb+srv://Vercel-Admin-o-esgoto-do-poder:DKkQ7z6HcVxcOvHx@o-esgoto-do-poder.b82hdkf.mongodb.net/?retryWrites=true&w=majority";
const DB_NAME = "dossie_oculto_logs";

let cachedDb: Db | null = null;

// Extensão do objeto global para cache em desenvolvimento (HMR)
let globalWithMongo = global as typeof globalThis & {
  _mongoDb?: Db;
};

export const connectToDb = async (): Promise<Db> => {
  if (cachedDb) {
    return cachedDb;
  }

  if (globalWithMongo._mongoDb) {
    cachedDb = globalWithMongo._mongoDb;
    return cachedDb;
  }

  try {
    const client = new MongoClient(URI);
    await client.connect();
    
    const db = client.db(DB_NAME);
    
    cachedDb = db;
    globalWithMongo._mongoDb = db;
    
    console.log("🟢 Connected to MongoDB Atlas (Serverless)");
    return db;
  } catch (error) {
    console.error("🔴 MongoDB Connection Error:", error);
    throw error;
  }
};

export const getDb = (): Db => {
  if (cachedDb) {
    return cachedDb;
  }
  if (globalWithMongo._mongoDb) {
    cachedDb = globalWithMongo._mongoDb;
    return cachedDb;
  }
  throw new Error("Database not initialized. Call connectToDb first.");
};
