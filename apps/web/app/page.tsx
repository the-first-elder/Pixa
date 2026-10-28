import Link from 'next/link';
import LiveDemo from '@/components/landing/LiveDemo';
import Reveal from '@/components/landing/Reveal';

const DEMO_SCENE = '/scenes/scene_5abb5015';

export default function Home() {
  return (
    <main className="bg-[#0a0a0b] text-[#f5f1e8]">
      {/* Floating nav */}
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/5 bg-[#0a0a0b]/80 backdrop-blur">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5" aria-label="Primary">
          <Link href="/" className="font-display text-xl tracking-tight">
            Pixa
          </Link>
          <div className="hidden items-center gap-7 text-sm text-neutral-300 md:flex">
            <Link href="#how" className="transition-colors hover:text-white">How it works</Link>
            <Link href="#explore" className="transition-colors hover:text-white">Explore</Link>
            <Link href="#ask" className="transition-colors hover:text-white">Ask</Link>
            <Link href="#capture" className="transition-colors hover:text-white">Capture</Link>
          </div>
          <Link
            href="/capture"
            className="rounded-md bg-[#e2a63b] px-4 py-2 text-sm font-medium text-black transition-transform hover:scale-[1.03]"
          >
            Explore Pixa
          </Link>
        </nav>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden pt-28 md:pt-36">
        <div className="mx-auto grid max-w-6xl gap-10 px-6 pb-16 md:grid-cols-[1.05fr_1fr] md:items-center md:pb-24">
          <div>
            <Reveal>
              <p className="text-xs font-medium uppercase tracking-[0.25em] text-[#e2a63b]">
                Spatial AI, made explorable
              </p>
            </Reveal>
            <Reveal delay={90}>
              <h1 className="font-display mt-5 text-5xl leading-[1.04] tracking-tight md:text-7xl">
                Your world.
                <br />
                A new dimension.
              </h1>
            </Reveal>
            <Reveal delay={180}>
              <p className="mt-6 max-w-md text-base leading-relaxed text-neutral-300 md:text-lg">
                Turn a simple video into an interactive 3D space. Explore the places you
                know, discover what&rsquo;s inside, and ask questions about your surroundings.
              </p>
            </Reveal>
            <Reveal delay={260}>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link
                  href={DEMO_SCENE}
                  className="rounded-md bg-[#e2a63b] px-6 py-3 text-sm font-medium text-black transition-transform hover:scale-[1.03]"
                >
                  Explore Pixa
                </Link>
                <Link
                  href="#how"
                  className="rounded-md border border-neutral-700 px-6 py-3 text-sm text-neutral-200 transition-colors hover:border-neutral-400"
                >
                  See how it works
                </Link>
              </div>
              <p className="mt-4 text-xs text-neutral-500">
                Opens a real reconstructed living room — no sign-up.
              </p>
            </Reveal>
          </div>
          <Reveal delay={150}>
            <figure className="relative overflow-hidden rounded-xl border border-white/10">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/landing/hero-frame.jpg"
                alt="Phone capture of a living room with sofa, pictures, and fan"
                className="hero-drift aspect-[4/5] w-full object-cover"
              />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-4 pt-10">
                <div className="flex flex-wrap gap-1.5">
                  {['sofa', 'television', 'standing fan', 'curtain'].map((t) => (
                    <span key={t} className="rounded-full border border-white/20 bg-black/60 px-2.5 py-1 text-[11px] text-neutral-200">
                      {t}
                    </span>
                  ))}
                </div>
                <figcaption className="mt-2 text-[11px] text-neutral-400">
                  A real capture. Pixa found and located each tagged object.
                </figcaption>
              </div>
            </figure>
          </Reveal>
        </div>
      </section>

      {/* Transformation */}
      <section id="how" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-16 md:py-24">
        <Reveal>
          <p className="text-xs font-medium uppercase tracking-[0.25em] text-[#e2a63b]">From reality to world</p>
          <h2 className="font-display mt-4 max-w-xl text-3xl tracking-tight md:text-5xl">
            One video. A whole new perspective.
          </h2>
        </Reveal>
        <div className="mt-10 grid gap-4 md:grid-cols-[1.2fr_0.7fr_1.2fr]">
          <Reveal>
            <figure className="overflow-hidden rounded-xl border border-white/10">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/landing/capture-grid.jpg" alt="Contact sheet of phone frames walking through a room" className="aspect-[4/3] w-full object-cover" loading="lazy" />
              <figcaption className="border-t border-white/10 px-4 py-3 text-xs text-neutral-400">
                <span className="text-[#e2a63b]">01 — Capture.</span> A phone walkthrough; overlapping views of one room.
              </figcaption>
            </figure>
          </Reveal>
          <Reveal delay={120}>
            <div className="flex h-full flex-col justify-center rounded-xl border border-white/10 bg-[#111113] p-6">
              <p className="text-xs uppercase tracking-widest text-neutral-500">02 — Reconstruct</p>
              <ul className="mt-3 space-y-2 text-sm text-neutral-300">
                <li>Frames extracted, poses estimated</li>
                <li>150/150 views registered</li>
                <li>Gaussian splats trained on-device</li>
              </ul>
              <p className="mt-4 text-[11px] text-neutral-500">Real pipeline stages from an actual Pixa scene.</p>
            </div>
          </Reveal>
          <Reveal delay={200}>
            <figure className="overflow-hidden rounded-xl border border-white/10">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/landing/room-3d.jpg" alt="The same room rendered as a navigable 3D reconstruction" className="aspect-[4/3] w-full object-cover" loading="lazy" />
              <figcaption className="border-t border-white/10 px-4 py-3 text-xs text-neutral-400">
                <span className="text-[#e2a63b]">03 — Explore.</span> The actual reconstruction, navigable in a browser.
              </figcaption>
            </figure>
          </Reveal>
        </div>
      </section>

      {/* Live demo */}
      <section id="explore" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-16 md:py-24">
        <Reveal>
          <p className="text-xs font-medium uppercase tracking-[0.25em] text-[#e2a63b]">Interactive</p>
          <h2 className="font-display mt-4 max-w-xl text-3xl tracking-tight md:text-5xl">
            Not just a view. A place you can navigate.
          </h2>
          <p className="mt-4 max-w-lg text-neutral-300">
            This is the live product, not a mockup — the same reconstruction engine,
            running here. Drag to look around, or open it full-screen.
          </p>
        </Reveal>
        <Reveal delay={120}>
          <div className="mt-8">
            <LiveDemo />
          </div>
        </Reveal>
      </section>

      {/* Ask */}
      <section id="ask" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-16 md:py-24">
        <div className="grid gap-10 md:grid-cols-2 md:items-start">
          <Reveal>
            <p className="text-xs font-medium uppercase tracking-[0.25em] text-[#e2a63b]">Grounded AI</p>
            <h2 className="font-display mt-4 text-3xl tracking-tight md:text-5xl">
              Your space has answers.
            </h2>
            <p className="mt-4 max-w-md text-neutral-300">
              Questions are answered from the reconstructed scene itself — objects the
              system actually located, with the evidence to show. When something
              wasn&rsquo;t captured, Pixa says so instead of inventing it.
            </p>
            <Link href={DEMO_SCENE} className="mt-6 inline-block text-sm text-[#e2a63b] underline underline-offset-4">
              Try it in the live scene →
            </Link>
          </Reveal>
          <Reveal delay={140}>
            <div className="rounded-xl border border-white/10 bg-[#111113] p-5">
              <p className="text-[11px] uppercase tracking-widest text-neutral-500">Real exchange from a Pixa scene</p>
              <div className="mt-4 space-y-4 text-sm">
                <div className="ml-auto w-fit max-w-[90%] rounded-lg bg-neutral-800 px-3.5 py-2.5">
                  Where is the table?
                </div>
                <div className="max-w-[95%] rounded-lg border border-white/10 px-3.5 py-2.5 text-neutral-200">
                  The table is near the sofa, beside the window — found in frames 33–37,
                  with its 3D position triangulated from three viewpoints.
                  <span className="mt-1.5 block text-[11px] text-[#e2a63b]">● Highlighted in the scene</span>
                </div>
                <div className="ml-auto w-fit max-w-[90%] rounded-lg bg-neutral-800 px-3.5 py-2.5">
                  What&rsquo;s behind the closed door?
                </div>
                <div className="max-w-[95%] rounded-lg border border-white/10 px-3.5 py-2.5 text-neutral-200">
                  That area was never captured, so I can&rsquo;t say — here&rsquo;s what
                  the recording does show near the door instead.
                  <span className="mt-1.5 block text-[11px] text-neutral-400">○ Answered with uncertainty, not a guess</span>
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Capture */}
      <section id="capture" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-16 md:py-24">
        <div className="grid gap-10 md:grid-cols-[1fr_1.1fr] md:items-center">
          <Reveal>
            <p className="text-xs font-medium uppercase tracking-[0.25em] text-[#e2a63b]">Guided capture</p>
            <h2 className="font-display mt-4 text-3xl tracking-tight md:text-5xl">
              Better captures. Better worlds.
            </h2>
            <p className="mt-4 max-w-md text-neutral-300">
              Pixa watches while you record — pacing, sharpness, light, and which
              directions you&rsquo;ve covered — and flags problems before processing,
              with a capture report before anything is submitted.
            </p>
            <Link
              href="/capture"
              className="mt-6 inline-block rounded-md bg-[#e2a63b] px-5 py-2.5 text-sm font-medium text-black transition-transform hover:scale-[1.03]"
            >
              Record a space
            </Link>
          </Reveal>
          <Reveal delay={140}>
            <ul className="space-y-3">
              {[
                ['Live pace meter', 'Warns the moment overlap breaks down from moving too fast.'],
                ['Sharpness + light checks', 'Catches blur, darkness, and blank walls as they happen.'],
                ['Coverage compass', 'Shows filmed directions; points out what you missed.'],
                ['Capture report', 'Measured stats, gaps, and recapture advice before you submit.'],
              ].map(([t, d]) => (
                <li key={t} className="rounded-xl border border-white/10 bg-[#111113] px-5 py-4">
                  <p className="text-sm font-medium">{t}</p>
                  <p className="mt-1 text-sm text-neutral-400">{d}</p>
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
      </section>

      {/* Possibilities */}
      <section className="mx-auto max-w-6xl px-6 py-16 md:py-24">
        <Reveal>
          <p className="text-xs font-medium uppercase tracking-[0.25em] text-[#e2a63b]">Possibilities</p>
          <h2 className="font-display mt-4 max-w-xl text-3xl tracking-tight md:text-5xl">
            One captured space. Many possibilities.
          </h2>
        </Reveal>
        <div className="mt-10 grid gap-x-10 gap-y-8 md:grid-cols-2">
          {[
            ['Property & interiors', 'Walk a space before visiting — every corner explorable, every object findable.'],
            ['Learning in place', 'Museums, workshops, and labs you can question, not just view.'],
            ['Tourism & culture', 'Cultural spaces that answer back when visitors ask.'],
            ['Workplace records', 'Document facilities, showrooms, and sites as navigable evidence.'],
            ['Access & discovery', 'Explore layout, obstacles, and routes before arriving in person.'],
          ].map(([t, d], i) => (
            <Reveal key={t} delay={i * 60}>
              <div className="border-t border-white/15 pt-5">
                <p className="font-display text-xl">{t}</p>
                <p className="mt-2 max-w-md text-sm leading-relaxed text-neutral-400">{d}</p>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal>
          <p className="mt-8 text-xs text-neutral-500">
            Exploratory directions — not certified surveying, measurement, or safety tooling.
          </p>
        </Reveal>
      </section>

      {/* Final CTA */}
      <section className="relative overflow-hidden border-t border-white/10">
        <div className="mx-auto max-w-6xl px-6 py-20 text-center md:py-28">
          <Reveal>
            <h2 className="font-display mx-auto max-w-2xl text-4xl tracking-tight md:text-6xl">
              Your world is waiting.
            </h2>
            <p className="mx-auto mt-4 max-w-md text-neutral-300">
              Capture a place. Step inside. See it differently.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link
                href={DEMO_SCENE}
                className="rounded-md bg-[#e2a63b] px-6 py-3 text-sm font-medium text-black transition-transform hover:scale-[1.03]"
              >
                Explore Pixa
              </Link>
              <Link
                href="/capture"
                className="rounded-md border border-neutral-700 px-6 py-3 text-sm text-neutral-200 transition-colors hover:border-neutral-400"
              >
                Capture your own space
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/10">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-8 text-sm text-neutral-400 md:flex-row md:items-center md:justify-between">
          <p className="font-display text-lg text-[#f5f1e8]">Pixa</p>
          <nav className="flex gap-6" aria-label="Footer">
            <Link href="/capture" className="transition-colors hover:text-white">Capture</Link>
            <Link href={DEMO_SCENE} className="transition-colors hover:text-white">Demo scene</Link>
            <Link href="#how" className="transition-colors hover:text-white">How it works</Link>
          </nav>
          <p className="text-xs text-neutral-600">Reconstructed from real footage · AI answers grounded in scene evidence</p>
        </div>
      </footer>
    </main>
  );
}
