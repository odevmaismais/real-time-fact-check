export enum VerdictType {
  TRUE = 'TRUE',
  FALSE = 'FALSE',
  MISLEADING = 'MISLEADING',
  OPINION = 'OPINION',
  UNVERIFIABLE = 'UNVERIFIABLE'
}

// Interface para as fontes (Grounding)
export interface Source {
  uri: string;
  title: string;
}

export interface AnalysisResult {
  segmentId: string;
  verdict: VerdictType;
  confidence: number;
  explanation: string;
  counterEvidence?: string;
  sources: Source[]; // Corrigido de string[] para Source[]
  sentimentScore: number;
  logicalFallacies: string[];
  context: string[];
  // Adicionado para evitar erro no App.tsx
  tokenUsage?: {
    promptTokens: number;
    responseTokens: number;
    totalTokens: number;
  };
}