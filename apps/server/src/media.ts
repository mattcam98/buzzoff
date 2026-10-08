/** Uploaded question media. Files are identified by content, not by what the browser claims. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GameError, type Media } from '@buzzoff/shared';
import { randomId } from './util';

interface Kind {
  ext: string;
  kind: Media['kind'];
  test: (b: Buffer) => boolean;
}

const ascii = (b: Buffer, start: number, text: string) => b.subarray(start, start + text.length).toString('latin1') === text;

/** Recognised by magic bytes. SVG and HTML are deliberately absent: they can carry scripts. */
const KINDS: Kind[] = [
  { ext: 'png', kind: 'image', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', kind: 'image', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', kind: 'image', test: (b) => ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a') },
  { ext: 'webp', kind: 'image', test: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP') },
  { ext: 'wav', kind: 'audio', test: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE') },
  { ext: 'mp3', kind: 'audio', test: (b) => ascii(b, 0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  { ext: 'ogg', kind: 'audio', test: (b) => ascii(b, 0, 'OggS') },
  { ext: 'm4a', kind: 'audio', test: (b) => ascii(b, 4, 'ftypM4A') },
  { ext: 'mp4', kind: 'video', test: (b) => ascii(b, 4, 'ftyp') },
  { ext: 'webm', kind: 'video', test: (b) => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) },
];

export async function storeMedia(dir: string, data: Buffer): Promise<Media> {
  const type = KINDS.find((k) => data.length > 12 && k.test(data));
  if (!type) throw new GameError('bad_media', 'Use a PNG, JPEG, GIF, WebP, MP3, WAV, OGG, M4A, MP4 or WebM file');
  await mkdir(dir, { recursive: true });
  const name = `${randomId(12)}.${type.ext}`;
  await writeFile(path.join(dir, name), data, { flag: 'wx' });
  return { kind: type.kind, url: `/media/${name}` };
}
