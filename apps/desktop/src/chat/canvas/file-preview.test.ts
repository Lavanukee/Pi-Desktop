/**
 * Pure coverage for the binary-modality preview mapping (UI#8 multi-modal canvas):
 * which extensions open which surface, and the `pd-file://` URL encoding main
 * decodes + fences.
 */
import { describe, expect, it } from 'vitest';
import { pdFileUrl, previewKindForExt } from './file-preview';

describe('previewKindForExt', () => {
  it('routes image extensions to the image surface (incl. heic/heif)', () => {
    const exts = [
      'png',
      'jpg',
      'jpeg',
      'gif',
      'webp',
      'bmp',
      'ico',
      'avif',
      'apng',
      'heic',
      'heif',
    ];
    for (const ext of exts) {
      expect(previewKindForExt(ext)).toEqual({ kind: 'image', mediaType: ext.toUpperCase() });
    }
  });

  it('routes video / audio / pdf extensions to their surfaces', () => {
    expect(previewKindForExt('mp4')).toEqual({ kind: 'video', mediaType: 'MP4' });
    expect(previewKindForExt('mov')).toEqual({ kind: 'video', mediaType: 'MOV' });
    expect(previewKindForExt('mp3')).toEqual({ kind: 'audio', mediaType: 'MP3' });
    expect(previewKindForExt('flac')).toEqual({ kind: 'audio', mediaType: 'FLAC' });
    expect(previewKindForExt('pdf')).toEqual({ kind: 'pdf', mediaType: 'PDF' });
  });

  it('routes 3D model extensions to the model surface', () => {
    for (const ext of ['glb', 'gltf', 'obj', 'stl', 'ply']) {
      expect(previewKindForExt(ext)).toEqual({ kind: 'model', mediaType: ext.toUpperCase() });
    }
  });

  it('routes docx/pptx to one `doc` kind, distinguished by mediaType', () => {
    expect(previewKindForExt('docx')).toEqual({ kind: 'doc', mediaType: 'DOCX' });
    expect(previewKindForExt('pptx')).toEqual({ kind: 'doc', mediaType: 'PPTX' });
  });

  it('leaves svg + text/code + legacy office formats to the file surface (null)', () => {
    // svg keeps its raw↔rendered text surface; .doc/.ppt are unsupported binaries.
    for (const ext of ['svg', 'ts', 'md', 'txt', 'json', 'doc', 'ppt', '']) {
      expect(previewKindForExt(ext)).toBeNull();
    }
  });
});

describe('pdFileUrl', () => {
  it('builds a pd-file://f URL whose pathname is the absolute path', () => {
    expect(pdFileUrl('/Users/jedd/pic.png')).toBe('pd-file://f/Users/jedd/pic.png');
  });

  it('percent-encodes spaces / unicode / reserved chars but keeps the separators', () => {
    const url = pdFileUrl('/Users/jedd/My Photos/a b?#.png');
    expect(url).toBe('pd-file://f/Users/jedd/My%20Photos/a%20b%3F%23.png');
    // Round-trips the way the main-process handler decodes it.
    expect(decodeURIComponent(new URL(url).pathname)).toBe('/Users/jedd/My Photos/a b?#.png');
    expect(new URL(url).host).toBe('f');
  });
});
