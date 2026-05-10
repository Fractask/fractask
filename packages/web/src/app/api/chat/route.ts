import { NextRequest } from 'next/server';
import { getTask } from '@getshit/core';
import { streamChat, type ChatMessage } from '@/lib/llm';
import { getRequestContext } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { messages?: ChatMessage[]; taskId?: string; modelId?: string };
  try {
    body = await req.json();
  } catch {
    return new Response('invalid JSON', { status: 400 });
  }

  const messages = body.messages ?? [];
  if (messages.length === 0) {
    return new Response('messages required', { status: 400 });
  }
  const modelId = body.modelId ?? 'anthropic:claude-sonnet-4-6';

  let systemContext = 'You are a helpful task-management assistant inside the "Fractask" app (built on the Fractask method).';
  if (body.taskId) {
    try {
      const ctx = await getRequestContext();
      const task = await getTask(ctx, body.taskId);
      if (task) {
        const childList =
          task.children.length === 0
            ? '(no subtasks yet)'
            : task.children.map((c) => `- [${c.status}] ${c.title}`).join('\n');
        systemContext += `\n\nCurrent focus:\nTitle: ${task.title}\nDescription: ${task.description ?? '(none)'}\nSubtasks:\n${childList}`;
      }
    } catch {
      // ignore — chat still works without context
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of streamChat({
          modelId,
          system: systemContext,
          messages,
        })) {
          controller.enqueue(encoder.encode(chunk));
        }
      } catch (err) {
        controller.enqueue(
          encoder.encode(`\n\n[stream error: ${err instanceof Error ? err.message : 'unknown'}]`),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
    },
  });
}
