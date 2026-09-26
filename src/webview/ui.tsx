import type { ButtonHTMLAttributes } from 'react';

export const pulseClass = (sequence: number): string => `flash pulse-${sequence % 2 ? 'a' : 'b'}`;

export function Button({ title, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" title={title} aria-label={title} {...props}>{children}</button>;
}

export function FileStatus({ status }: { status: string }) {
  return <span className={`file-status status-${status}`}>{status === '?' ? 'A' : status}</span>;
}
