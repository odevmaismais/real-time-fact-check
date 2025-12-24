import { MongoClient, Db } from 'mongodb';

// Cache da conexão para reutilização entre invocações (Padrão Serverless)
let cachedClient: MongoClient | null = null;
let cachedDb: Db | null = null;

export async function connectToDatabase() {
  if (cachedClient && cachedDb) {
    return { client: cachedClient, db: cachedDb };
  }

  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error("Defina a variável MONGO_URI no .env");
  }

  // Opções recomendadas para Serverless
  const client = new MongoClient(uri, {
    maxPoolSize: 1, // Mantém baixo consumo de conexões no Atlas
    minPoolSize: 0,
    serverSelectionTimeoutMS: 5000,
  });

  await client.connect();
  
  // Pega o nome do banco da URI ou usa um padrão
  const db = client.db(new URL(uri).pathname.substr(1) || 'veritas_live');

  cachedClient = client;
  cachedDb = db;

  return { client, db };
}
