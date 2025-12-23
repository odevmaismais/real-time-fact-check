
import { DebateSegment, AnalysisResult } from "../types";

export const loggingService = {
    startSession: async (inputMode: string): Promise<string | null> => {
        try {
            // Timeout after 2 seconds to avoid blocking the UI if backend is down
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);

            const res = await fetch('/api/logs/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ inputMode }),
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);

            if (!res.ok) throw new Error("Failed to start session");
            const data = await res.json();
            return data.sessionId;
        } catch (e) {
            console.error("Logging Error (Start):", e);
            return null;
        }
    },

    logAnalysis: async (sessionId: string, segment: DebateSegment, analysis: AnalysisResult) => {
        try {
            await fetch('/api/logs/analysis', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId, segment, analysis })
            });
        } catch (e) {
            console.error("Logging Error (Analysis):", e);
        }
    },

    endSession: async (sessionId: string, totalCost: string, durationSeconds: number) => {
        try {
            await fetch('/api/logs/session/end', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId, totalCost, durationSeconds })
            });
        } catch (e) {
            console.error("Logging Error (End):", e);
        }
    }
};
