import CaptureRecorder from '@/components/CaptureRecorder';
import UploadForm from './UploadForm';

export default function CapturePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-2xl font-semibold">Capture a space</h1>
      <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm text-neutral-400">
        <li>Record 30–120 s of one connected indoor space (see docs/capture-protocol.md).</li>
        <li>Move slowly; keep surfaces in overlapping views; cover corners and doorways.</li>
        <li>Upload below. Processing runs asynchronously — the page reports real job stages.</li>
      </ol>
      <CaptureRecorder />
      <h2 className="mt-10 text-lg font-medium">Or upload a file</h2>
      <UploadForm />
    </main>
  );
}
