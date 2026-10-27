/**
 * Stage 0 live verification of Meta Model API adapters.
 * Run: npx -y tsx scripts/verify-meta.ts
 * Reads META_API_KEY from repo-root .env. Prints NO secrets.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envText = readFileSync(join(root, '.env'), 'utf8');
const apiKey = envText
  .split('\n')
  .find((l) => l.startsWith('META_API_KEY='))
  ?.slice('META_API_KEY='.length)
  .trim();
if (!apiKey) throw new Error('META_API_KEY missing in .env');

for (const k of Object.keys(process.env)) {
  if (/key|token|secret/i.test(k)) delete process.env[k];
}
process.env.META_API_KEY = apiKey;
process.env.META_API_BASE = 'https://api.meta.ai/v1';

const { listModels, chat, segmentImage, transcribe, generateImage } = await import(
  '@worldlens/model-adapters'
);

// 1. Free access check.
const models = await listModels();
console.log('MODELS marina:', JSON.stringify(models));

// 2. Tiny Spark chat (pennies). Validates auth + chat/completions contract.
const reply = await chat({
  messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
  maxTokens: 2048,
});
console.log('SPARK model:', reply.model);
console.log('SPARK reply:', JSON.stringify(reply.content));
console.log('SPARK toolcalls:', JSON.stringify(reply.toolCalls));
console.log('SPARK usage:', JSON.stringify(reply.usage));

// 3. Tiny SAM call on a synthetic frame (validates /responses contract +
//    special-token parsing). Synthetic red square on black, 640x480 PNG.
const png = '/tmp/wl-sam-test.png';
execFileSync('ffmpeg', [
  '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:size=640x480:duration=1',
  '-vf', 'drawbox=x=200:y=140:w=240:h=200:color=red:thickness=fill',
  '-frames:v', '1', png,
]);
const b64 = readFileSync(png).toString('base64');
for (const prompt of ['square', 'red square', 'box']) {
  const seg = await segmentImage({
    image: `data:image/png;base64,${b64}`,
    prompt,
  });
  console.log(`SAM prompt=${JSON.stringify(prompt)} raw bytes:`, seg.rawOutput.length);
  console.log(`SAM prompt=${JSON.stringify(prompt)} raw head:`, JSON.stringify(seg.rawOutput.slice(0, 200)));
  console.log(`SAM prompt=${JSON.stringify(prompt)} boxes:`, JSON.stringify(seg.boxes));
}
console.log('VERIFY DONE — no secrets printed above.');

// 4. Voice plumbing check on a synthetic tone (validates multipart contract;
//    a sine tone carries no speech — transcript content is meaningless here).
//    Run explicitly: VERIFY_VOICE=1 npx tsx scripts/verify-meta.mts
if (process.env.VERIFY_VOICE === '1') {
  const wav = '/tmp/wl-tone.wav';
  execFileSync('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', wav,
  ]);
  const result = await transcribe({ wav: readFileSync(wav) });
  console.log('VOICE session:', result.sessionId);
  console.log('VOICE durationMs:', result.audioDurationMs);
  console.log('VOICE transcript:', JSON.stringify(result.transcript));
}

// 5. Image generation contract check ($0.01). Optional concept imagery only.
//    Run explicitly: VERIFY_IMAGE=1 npx tsx scripts/verify-meta.mts
if (process.env.VERIFY_IMAGE === '1') {
  const img = await generateImage({
    prompt: 'A minimal line icon of a doorway, flat design',
    size: '1024x1024',
  });
  console.log('IMAGE count:', img.images.length, 'format:', img.outputFormat);
  if (img.images[0]?.b64_json) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync('/tmp/wl-image-test.png', Buffer.from(img.images[0].b64_json, 'base64'));
    console.log('IMAGE saved to /tmp/wl-image-test.png (generated concept art, NOT evidence)');
  }
}
