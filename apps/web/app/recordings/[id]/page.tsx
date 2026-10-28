import RecordingView from '@/components/RecordingView';

export default async function RecordingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <RecordingView recordingId={id} />
    </main>
  );
}
