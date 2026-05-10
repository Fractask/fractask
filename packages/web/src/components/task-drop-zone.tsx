'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { moveTaskAction } from '@/app/actions';
import { ConfirmMoveModal } from './confirm-move-modal';
import { TASK_DRAG_MIME } from './task-list';

type Payload = { id: string; title: string };

export function TaskDropZone({
  targetId,
  targetTitle,
  className,
  activeClassName = 'ring-2 ring-(--color-accent) ring-inset rounded-md',
  children,
}: {
  targetId: string | null;
  targetTitle: string;
  className?: string | undefined;
  activeClassName?: string | undefined;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [over, setOver] = useState(false);
  const [pending, setPending] = useState<Payload | null>(null);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
          setOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const raw =
          e.dataTransfer.getData(TASK_DRAG_MIME) ||
          e.dataTransfer.getData('text/plain');
        if (!raw) return;
        try {
          const payload = JSON.parse(raw) as Payload;
          if (!payload?.id || payload.id === targetId) return;
          setPending(payload);
        } catch {
          /* not our payload */
        }
      }}
      className={`${className ?? ''} ${over ? activeClassName : ''}`.trim()}
    >
      {children}
      {pending && (
        <ConfirmMoveModal
          source={pending}
          target={{ id: targetId, title: targetTitle }}
          onCancel={() => setPending(null)}
          onConfirm={async () => {
            const p = pending;
            setPending(null);
            const r = await moveTaskAction(p.id, targetId);
            if (r.ok) router.refresh();
          }}
        />
      )}
    </div>
  );
}
