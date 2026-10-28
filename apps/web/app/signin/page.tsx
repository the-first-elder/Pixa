'use client';

import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function SignInForm() {
  const params = useSearchParams();
  const callbackUrl = params.get('callbackUrl') || '/worlds';
  const safe = callbackUrl.startsWith('/') && !callbackUrl.startsWith('//') ? callbackUrl : '/worlds';
  const error = params.get('error');

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-6 py-16">
      <h1 className="font-display text-3xl tracking-tight">Your world, saved.</h1>
      <p className="mt-3 text-sm leading-relaxed text-neutral-300">
        Sign in to create your 3D scene, track its progress, and return when it&rsquo;s ready.
      </p>
      {error && (
        <p className="mt-4 rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          Sign-in didn&rsquo;t complete ({error}). Please try again — nothing was created.
        </p>
      )}
      <button
        type="button"
        onClick={() => signIn('google', { callbackUrl: safe })}
        className="mt-6 flex items-center justify-center gap-2 rounded-md bg-white px-5 py-3 text-sm font-medium text-black transition-transform hover:scale-[1.02]"
      >
        <span aria-hidden>◉</span> Continue with Google
      </button>
      <p className="mt-4 text-xs text-neutral-500">
        Pixa stores only your account ID, email, and display name — nothing else.
      </p>
    </main>
  );
}

export default function SignInPage() {
  return (
    <Suspense>
      <SignInForm />
    </Suspense>
  );
}
