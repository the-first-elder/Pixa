/**
 * Stream a file to the client without buffering it in memory.
 * readFileSync on a 39-452MB splat blocks the Node event loop for every
 * concurrent viewer; a read stream + ETag keeps the server responsive and
 * lets repeat loads answer 304. Single-range requests are honored (media
 * and large-asset clients probe with them); multi-range falls back to 200.
 */
import 'server-only';
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';

export function streamFile(
  path: string,
  contentType: string,
  req?: Request,
): Response {
  const stat = statSync(path);
  const etag = `"${stat.size}-${Math.round(stat.mtimeMs)}"`;
  const cache = 'private, max-age=3600';
  if (req?.headers.get('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': cache },
    });
  }
  const range = req?.headers.get('range');
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m) {
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
    if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < stat.size) {
      const body = Readable.toWeb(createReadStream(path, { start, end }));
      return new Response(body as unknown as BodyInit, {
        status: 206,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          ETag: etag,
          'Cache-Control': cache,
        },
      });
    }
  }
  const body = Readable.toWeb(createReadStream(path));
  return new Response(body as unknown as BodyInit, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Cache-Control': cache,
    },
  });
}
