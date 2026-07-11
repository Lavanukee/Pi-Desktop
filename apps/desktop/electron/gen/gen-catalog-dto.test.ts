import { getModel, MODALITY_CATALOG } from '@pi-desktop/gen-service';
import { describe, expect, it } from 'vitest';
import { toModalityCatalogEntry } from './gen-catalog-dto';

describe('toModalityCatalogEntry', () => {
  it('flattens a recommended, commercial-clean image row', () => {
    const flux = getModel('flux2-klein-4b');
    expect(flux).toBeDefined();
    if (flux === undefined) return;
    const dto = toModalityCatalogEntry(flux);
    expect(dto).toMatchObject({
      id: 'flux2-klein-4b',
      modality: 'image',
      backend: 'mflux',
      commercialUse: true,
      recommended: true,
      reserved: false,
      runsLocally: true,
    });
    expect(dto.approxSizeGB).toBeGreaterThan(0);
  });

  it('normalises the optional reserved/recommended flags to booleans', () => {
    for (const m of MODALITY_CATALOG) {
      const dto = toModalityCatalogEntry(m);
      expect(typeof dto.reserved).toBe('boolean');
      expect(typeof dto.recommended).toBe('boolean');
    }
  });

  it('carries the gate signal for a non-commercial row (flux1-dev = CC-BY-NC)', () => {
    const dev = getModel('flux1-dev-gguf');
    expect(dev).toBeDefined();
    if (dev === undefined) return;
    const dto = toModalityCatalogEntry(dev);
    expect(dto.commercialUse).toBe(false);
    expect(dto.license).toBe('cc-by-nc-4.0');
  });

  it('maps every catalog row 1:1 (id/label/modality preserved)', () => {
    const dtos = MODALITY_CATALOG.map(toModalityCatalogEntry);
    expect(dtos).toHaveLength(MODALITY_CATALOG.length);
    for (const [i, dto] of dtos.entries()) {
      const src = MODALITY_CATALOG[i];
      expect(src).toBeDefined();
      if (src === undefined) continue;
      expect(dto.id).toBe(src.id);
      expect(dto.label).toBe(src.label);
      expect(dto.modality).toBe(src.modality);
      expect(dto.backend).toBe(src.backend);
    }
  });

  it('surfaces at least one recommended pick per surfaced modality', () => {
    const dtos = MODALITY_CATALOG.map(toModalityCatalogEntry);
    for (const modality of ['image', 'audio', 'video', '3d'] as const) {
      const recommended = dtos.filter((d) => d.modality === modality && d.recommended);
      expect(recommended.length).toBeGreaterThan(0);
    }
  });
});
