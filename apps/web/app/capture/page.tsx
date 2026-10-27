/**
 * Stage 2 builds the real capture page here (upload/record, preview,
 * processing status, capture-quality warnings, supplemental workflow).
 * Placeholder route so navigation exists from Stage 0.
 */
export default function CapturePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-2xl font-semibold">Capture a space</h1>
      <p className="mt-3 text-neutral-400">
        Stage 2: video upload, validation, preprocessing, and processing jobs.
        See docs/capture-protocol.md for the recording procedure.
      </p>
    </main>
  );
}
