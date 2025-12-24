
export interface DebateSegment {
  id: string;
  speaker: string;
  text: string;
  timestamp: number;
}

export enum VerdictType {
  TRUE = 'TRUE',
  FALSE = 'FALSE',
  MISLEADING = 'MISLEADING',
  OPINION = 'OPINION',
  UNVERIFIABLE = 'UNVERIFIABLE'
}

export interface AnalysisResult {
  segmentId: string;
  verdict: VerdictType;
  confidence: number;
  explanation: string;
  counterEvidence?: string;
  sources: string[];
  sentimentScore: number;
  logicalFallacies: string[];
  context: string[];
}

export interface GroundingSource {
  title: string;
  uri: string;
}

export interface TokenUsage {
  promptTokens: number;
  candidatesTokens: number;
  totalTokens: number;
}

export interface LogicalFallacy {
  name: string;
  description: string;
}

export interface AppState {
  isListening: boolean;
  segments: DebateSegment[];
  analyses: Record<string, AnalysisResult>;
  truthScoreHistory: { time: string; score: number }[];
}

export interface SpeechRecognitionEvent {
  results: {
    length: number;
    [index: number]: {
      [index: number]: {
        transcript: string;
      };
    };
  };
}

export interface SpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: any) => void) | null;
}
