import Link from 'next/link';
import AuthNav from '@/components/AuthNav';
import CaptureRecorder from '@/components/CaptureRecorder';
import { authEnabled, sessionUser } from '@/lib/authz';
import UploadForm from './UploadForm';

export default async function CapturePage() {
  const user = await sessionUser();
  const needsSignIn = authEnabled() && !user;

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs text-neutral-500">
            <a href="/" className="hover:text-white">Pixa</a>
          </p>
          <h1 className="mt-1 text-2xl font-semibold">Create your world</h1>
        </div>
        <AuthNav />
      </div>

      {needsSignIn ? (
        <div className="mt-6 rounded-xl border border-[#e2a63b]/40 bg-[#e2a63b]/10 px-5 py-4">
          <p className="text-sm font-medium text-[#e2a63b]">Sign in to save your world</p>
          <p className="mt-1 text-sm text-neutral-300">
            You can record and pick a video first — but creating the scene
            needs an account so progress and results are saved to you.
          </p>
          <Link
            href="/signin?callbackUrl=/capture"
            className="mt-3 inline-block rounded-md bg-white px-4 py-2 text-sm font-medium text-black transition-transform hover:scale-[1.02]"
          >
            Continue with Google
          </Link>
        </div>
      ) : (
        user && (
          <p className="mt-6 rounded-xl border border-white/10 bg-[#111113] px-5 py-3 text-sm text-neutral-300">
            Saving to <span className="font-medium text-white">{user.name ?? user.email ?? 'your account'}</span>
            {' '}— track progress in <Link href="/worlds" className="underline underline-offset-4 hover:text-white">My Worlds</Link>.
          </p>
        )
      )}

      <ol className="mt-6 list-decimal space-y-1 pl-5 text-sm text-neutral-400">
        <li>Choose a video of the environment (record above or upload a file).</li>
        <li>Pixa analyzes and reconstructs the scene — you can leave and come back.</li>
        <li>Explore the resulting 3D environment.</li>
      </ol>
      <p className="mt-3 text-xs text-neutral-500">
        Tip: record 30–120 s of one connected indoor space — move slowly, keep
        overlapping views, cover corners and doorways.
        {needsSignIn
          ? ' If you submit while signed out, your video is kept and restored after you sign in.'
          : ' Your world is saved to your account.'}
      </p>
      <CaptureRecorder />
      <h2 className="mt-10 text-lg font-medium">Or upload a file</h2>
      <UploadForm />
    </main>
  );
}
