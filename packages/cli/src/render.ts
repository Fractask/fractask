import type { Task, TaskTree } from '@getshit/core';

export function statusBadge(status: Task['status']): string {
  switch (status) {
    case 'open':
      return '[ ]';
    case 'doing':
      return '[~]';
    case 'review':
      return '[?]';
    case 'done':
      return '[x]';
    case 'archived':
      return '[a]';
    case 'snoozed':
      return '[z]';
  }
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function formatLine(task: Task): string {
  return `${statusBadge(task.status)} ${shortId(task.id)}  ${task.title}`;
}

export function renderFlat(tasks: Task[]): string {
  if (tasks.length === 0) return '(no tasks)';
  return tasks.map(formatLine).join('\n');
}

export function renderTree(tree: TaskTree): string {
  const lines: string[] = [formatLine(tree)];
  walkTree(tree.children, '', lines);
  return lines.join('\n');
}

function walkTree(children: TaskTree[], prefix: string, lines: string[]): void {
  children.forEach((child, idx) => {
    const last = idx === children.length - 1;
    const connector = last ? '└── ' : '├── ';
    lines.push(`${prefix}${connector}${formatLine(child)}`);
    const nextPrefix = prefix + (last ? '    ' : '│   ');
    walkTree(child.children, nextPrefix, lines);
  });
}

export function renderForest(trees: TaskTree[]): string {
  if (trees.length === 0) return '(no tasks)';
  return trees.map(renderTree).join('\n\n');
}
