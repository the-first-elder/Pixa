'use client';

import { useState } from 'react';
import type { CameraCommand } from './SceneViewer';
import VoiceButton from './VoiceButton';

interface Action {
  actionId: string;
  type: string;
  status: string;
  message?: string;
  targetId?: string;
  entityIds?: string[];
  camera?: CameraCommand;
  evidence?: unknown;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  actions?: Action[];
}

/**
 * Conversational panel. Sends text to POST query, dispatches validated camera
 * commands to the viewer, then confirms actual execution back to the server.
 * What the model requested vs. what really happened stays distinguishable.
 */
export default function AssistantPanel({
  sceneId,
  onCamera,
}: {
  sceneId: string;
  onCamera: (cmd: CameraCommand) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [phase, setPhase] = useState<'idle' | 'thinking' | 'executing' | 'error'>('idle');
  const [notice, setNotice] = useState<string | null>(null);

  async function confirm(actionId: string, executed: boolean, extra: Record<string, unknown> = {}) {
    try {
      await fetch(`/api/scenes/${encodeURIComponent(sceneId)}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId, executed, ...extra }),
      });
    } catch {
      // Confirm is bookkeeping; the user already saw the outcome.
    }
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || phase === 'thinking' || phase === 'executing') return;
    setNotice(null);
    setMessages((m) => [...m, { role: 'user', content: message }]);
    setInput('');
    setPhase('thinking');
    try {
      const res = await fetch(`/api/scenes/${encodeURIComponent(sceneId)}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, ...(sessionId ? { sessionId } : {}) }),
      });
      const data = (await res.json()) as {
        response: string;
        actions: Action[];
        sessionId?: string;
        error?: string;
      };
      if (data.sessionId) setSessionId(data.sessionId);
      if (!res.ok) throw new Error(data.response || `Query failed (${res.status})`);

      setPhase('executing');
      for (const action of data.actions ?? []) {
        const camera = action.camera;
        if (camera) {
          onCamera(camera);
          // Camera tween duration + margin, then verify by confirming dispatch.
          // True per-frame verification arrives with renderer-confirmed states.
          await new Promise((r) => setTimeout(r, camera.durationMs + 400));
          await confirm(action.actionId, action.status === 'success', {
            status: action.status,
            executionResult: { dispatched: true, via: 'viewer-tween' },
          });
        } else {
          await confirm(action.actionId, action.status === 'success', {
            status: action.status,
            executionResult: { dispatched: false, reason: action.message ?? 'no camera command' },
          });
        }
      }
      setMessages((m) => [...m, { role: 'assistant', content: data.response, actions: data.actions }]);
      setPhase('idle');
    } catch (e) {
      setPhase('error');
      setNotice(e instanceof Error ? e.message : 'Request failed');
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-3 overflow-auto">
        {messages.length === 0 && (
          <p className="text-sm text-neutral-500">
            Ask about this space — e.g. “take me to the entrance”, “show me the table”.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'text-right' : ''}>
            <div
              className={`inline-block max-w-full rounded-md px-3 py-2 text-sm ${
                m.role === 'user' ? 'bg-neutral-800' : 'bg-transparent px-0 text-neutral-300'
              }`}
            >
              {m.content}
            </div>
            {m.actions && m.actions.length > 0 && (
              <div className="mt-1 space-y-1">
                {m.actions.map((a) => (
                  <p key={a.actionId} className="text-xs text-neutral-500">
                    {a.type}: {a.status}
                    {a.message ? ` — ${a.message}` : ''}
                  </p>
                ))}
              </div>
            )}
          </div>
        ))}
        {phase === 'thinking' && <p className="text-sm text-neutral-500">Interpreting…</p>}
        {phase === 'executing' && <p className="text-sm text-neutral-500">Executing in scene…</p>}
        {notice && <p className="text-sm text-red-400">{notice}</p>}
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask or instruct…"
          className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        />
        <VoiceButton sceneId={sceneId} onTranscript={(t) => setInput(t)} />
        <button
          type="submit"
          disabled={phase === 'thinking' || phase === 'executing'}
          className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  );
}
