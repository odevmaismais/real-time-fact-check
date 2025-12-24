export enum VerdictType {
  TRUE = 'TRUE',
  FALSE = 'FALSE',
  MISLEADING = 'MISLEADING',
  OPINION = 'OPINION',
  UNVERIFIABLE = 'UNVERIFIABLE'
}

export interface Source {
  uri: string;
  title: string;
}

export interface LogicalFallacy {
  name: string;
  description: string;
}

export interface DebateSegment {
  id: string;
  speaker: string;
  text: string;
  timestamp: number;
}

// Tipos para reconhecimento de fala (Web Speech API ou custom)
export type SpeechRecognition = any;
export type SpeechRecognitionEvent = any;

export interface AnalysisResult {
  segmentId: string;
  verdict: VerdictType;
  confidence: number;
  explanation: string;
  counterEvidence?: string;
  sources: Source[];
  sentimentScore: number;
  logicalFallacies: LogicalFallacy[]; 
  context: string[];
  tokenUsage?: {
    promptTokens: number;
    responseTokens: number; // Nome padronizado
    totalTokens: number;
  };
}