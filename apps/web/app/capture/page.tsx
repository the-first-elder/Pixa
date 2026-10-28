import AuthNav from '@/components/AuthNav';
import CaptureRecorder from '@/components/CaptureRecorder';
import UploadForm from './UploadForm';

export default function CapturePage() {
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
      <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm text-neutral-400">
        <li>Choose a video of the environment (record above or upload a file).</li>
        <li>Pixa analyzes and reconstructs the scene — you can leave and come back.</li>
        <li>Explore the resulting 3D environment.</li>
      </ol>
      <p className="mt-3 text-xs text-neutral-500">
        Tip: record 30–120 s of one connected indoor space — move slowly, keep
        overlapping views, cover corners and doorways. You&rsquo;ll sign in when
        you submit, so your world is saved to your account.
      </p>
      <CaptureRecorder />
      <h2 className="mt-10 text-lg font-medium">Or upload a file</h2>
      <UploadForm />
    </main>
  );
}
