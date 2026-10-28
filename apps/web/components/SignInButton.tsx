'use client';

import { useState } from 'react';
import SignInModal from './SignInModal';

/**
 * Sign-in trigger that opens the in-context modal instead of navigating
 * to /signin. Drop-in replacement for the old "Sign in" links.
 */
export default function SignInButton({
  callbackUrl = '/worlds',
  label = 'Sign in',
  className,
}: {
  callbackUrl?: string;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        {label}
      </button>
      <SignInModal open={open} onClose={() => setOpen(false)} callbackUrl={callbackUrl} />
    </>
  );
}
