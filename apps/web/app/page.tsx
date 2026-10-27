import Link from 'next/link';

const STAGES = [
  { n: 0, title: 'Scaffold + API access', state: 'done' },
  { n: 1, title: 'Real 3D pipeline', state: 'pending — needs fixture video + KIRI/RunPod' },
  { n: 2, title: 'Capture + upload', state: 'done' },
  { n: 3, title: 'Scene index', state: 'pending' },
  { n: 4, title: 'Scene graph', state: 'pending' },
  { n: 5, title: 'NL scene actions', state: 'pending' },
  { n: 6, title: 'Voice', state: 'pending' },
  { n: 7, title: 'Grounding + capture director', state: 'pending' },
  { n: 8, title: 'P1 features', state: 'pending' },
  { n: 9, title: 'Polish + demo', state: 'pending' },
] as const;

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-4xl font-semibold tracking-tight">WorldLens</h1>
      <p className="mt-3 text-neutral-400">
        Phone video → reconstructed 3D environment → natural-language exploration.
      </p>
      <div className="mt-8 flex gap-3">
        <Link
          href="/capture"
          className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black"
        >
          Capture a space
        </Link>
      </div>
      <h2 className="mt-12 text-sm font-medium uppercase tracking-wider text-neutral-500">
        Build stages
      </h2>
      <ol className="mt-4 space-y-2">
        {STAGES.map((s) => (
          <li
            key={s.n}
            className="flex items-center gap-3 rounded-md border border-neutral-800 px-4 py-2.5"
          >
            <span className="text-xs text-neutral-500">Stage {s.n}</span>
            <span className="text-sm">{s.title}</span>
            <span className="ml-auto text-xs text-neutral-500">{s.state}</span>
          </li>
        ))}
      </ol>
    </main>
  );
}
