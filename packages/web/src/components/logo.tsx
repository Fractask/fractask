/**
 * Brand mark — a checkmark inside a rounded square. Visually mirrors the
 * `[x]` done-task badge the CLI prints, which is the hook for the product:
 * everything you do is a checkable item in a tree. Renders in `currentColor`
 * so it inherits foreground from whatever surface it's placed on.
 */
export function LogoMark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <rect x="3" y="3" width="26" height="26" rx="6" />
      <path d="M9 16.5 L14 21.5 L23 11.5" />
    </svg>
  );
}

/**
 * Mark + wordmark inline. `variant` switches between the compact "Fractask"
 * wordmark and the longer "Fractask method" form.
 */
export function Logo({
  size = 22,
  variant = 'short',
  className,
}: {
  size?: number;
  variant?: 'short' | 'full' | 'mark';
  className?: string;
}) {
  return (
    <div className={`inline-flex items-center gap-2 text-(--color-fg) ${className ?? ''}`}>
      <LogoMark size={size} />
      {variant !== 'mark' && (
        <span className="font-medium tracking-tight">
          {variant === 'full' ? 'Fractask method' : 'Fractask'}
        </span>
      )}
    </div>
  );
}
