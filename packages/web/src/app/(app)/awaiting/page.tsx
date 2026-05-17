import { redirect } from 'next/navigation';

// /awaiting used to be a separate bucket of pending agent prompts. The
// "needs your input" set lives in /reviews now — tasks with pending prompts
// are auto-bumped to status='review', so the Reviews list already covers
// both approvals and questions. Keep this redirect for any saved bookmarks.
export default function AwaitingRedirect() {
  redirect('/reviews');
}
