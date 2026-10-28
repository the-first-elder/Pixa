'use client';

import type { CaptureReport } from '@/lib/capture-report';

/** Truthful pre-reconstruction report. Shows measured values, gaps, and what
 *  was NOT evaluated — never a success guarantee. */
export default function CaptureReportView({ report }: { report: CaptureReport }) {
  const verdict =
    report.verdict === 'likely-ok'
      ? 'Looks recordable'
      : report.verdict === 'needs-work'
        ? 'Needs work before submitting'
        : 'Not enough data';
  return (
    <div className="mt-3 rounded-md border border-neutral-800 px-4 py-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium">Capture report</span>
        <span
          className={
            report.verdict === 'likely-ok'
              ? 'text-green-400'
              : report.verdict === 'needs-work'
                ? 'text-amber-400'
                : 'text-neutral-400'
          }
        >
          {verdict}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-400">
        <dt>Duration</dt>
        <dd className="text-right text-neutral-200">{report.durationSec}s</dd>
        <dt>Est. size</dt>
        <dd className="text-right text-neutral-200">~{Math.max(1, Math.round(report.estimatedBytes / 1048576))} MB ({report.mimeType})</dd>
        <dt>Blurry frames</dt>
        <dd className="text-right text-neutral-200">{report.sharpness.blurrySharePct}%</dd>
        <dt>Dark frames</dt>
        <dd className="text-right text-neutral-200">{report.exposure.darkSharePct}%</dd>
        <dt>Fast-motion share</dt>
        <dd className="text-right text-neutral-200">{report.motion.fastSharePct}%</dd>
        <dt>Tracking losses</dt>
        <dd className="text-right text-neutral-200">{report.motion.trackingLossEvents}</dd>
        <dt>Look directions</dt>
        <dd className="text-right text-neutral-200">{report.orientation.yawSectorsCovered ?? 'no sensors'}</dd>
      </dl>
      {report.recommendations.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-300">
          {report.recommendations.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
      {report.unevaluated.length > 0 && (
        <div className="mt-2 text-xs text-neutral-500">
          <p>Not evaluated on-device:</p>
          <ul className="list-disc pl-5">
            {report.unevaluated.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
