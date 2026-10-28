'use client';

import { useEffect } from 'react';
import { signIn } from 'next-auth/react';

/**
 * In-context sign-in: overlay modal instead of a full page navigation.
 * Used everywhere the app needs an account mid-flow (capture, create).
 * After the Google round-trip the user lands on callbackUrl and any
 * stashed file is restored by the capture form. /signin remains as the
 * fallback for direct visits and server-side redirects.
 */
export default function SignInModal({
  open,
  onClose,
  callbackUrl,
}: {
  open: boolean;
  onClose: () => void;
  callbackUrl: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Sign in"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-white/10 bg-[#111113] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <h2 className="font-display text-xl tracking-tight">Your world, saved.</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sign in"
            className="rounded px-2 py-0.5 text-lg leading-none text-neutral-500 hover:bg-neutral-800 hover:text-white"
          >
            ×
          </button>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-neutral-300">
          Sign in to create your 3D scene, track its progress, and return when it&rsquo;s ready.
        </p>
        <button
          type="button"
          onClick={() => void signIn('google', { callbackUrl })}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-md bg-white px-5 py-3 text-sm font-medium text-black transition-transform hover:scale-[1.02]"
        >
          <span aria-hidden>◉</span> Continue with Google
        </button>
        <p className="mt-3 text-xs text-neutral-500">
          Pixa stores only your account ID, email, and display name — nothing else.
        </p>
      </div>
    </div>
  );
}
