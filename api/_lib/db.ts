import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI || "";
const options = {};

let client;
let clientPromise: Promise<MongoClient>;

if (!process.env.MONGODB_URI) {
  throw new Error('Please add your Mongo URI to .env.local');
}

if (process.env.NODE_ENV === 'development') {
  // Em desenvolvimento, use uma variável global para preservar o cliente
  // entre reloads de módulo causados pelo HMR.
  if (!(global as any)._mongoClientPromise) {
    client = new MongoClient(uri, options);
    (global as any)._mongoClientPromise = client.connect();
  }
  clientPromise = (global as any)._mongoClientPromise;
} else {
  // Em produção, é seguro não usar variável global.
  client = new MongoClient(uri, options);
  clientPromise = client.connect();
}

// Função helper para conectar ao banco
export async function connectToDb() {
    const client = await clientPromise;
    const db = client.db('fact-check-db'); // Nome do seu banco
    return { client, db };
}

export default clientPromise;