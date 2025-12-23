
import { MongoClient, Db } from 'mongodb';

const URI = "mongodb+srv://Vercel-Admin-o-esgoto-do-poder:DKkQ7z6HcVxcOvHx@o-esgoto-do-poder.b82hdkf.mongodb.net/?retryWrites=true&w=majority";
const DB_NAME = "dossie_oculto_logs";

let client: MongoClient;
let db: Db;

export const connectToDb = async () => {
  if (db) return db;
  
  try {
    client = new MongoClient(URI);
    await client.connect();
    db = client.db(DB_NAME);
    console.log("🟢 Connected to MongoDB Atlas");
    return db;
  } catch (error) {
    console.error("🔴 MongoDB Connection Error:", error);
    (process as any).exit(1);
  }
};

export const getDb = () => {
  if (!db) {
    throw new Error("Database not initialized. Call connectToDb first.");
  }
  return db;
};
