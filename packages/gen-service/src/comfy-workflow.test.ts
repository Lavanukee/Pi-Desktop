import { describe, expect, it } from 'vitest';
import { MODALITY_CATALOG } from './catalog.ts';
import {
  fillWorkflow,
  getWorkflowTemplate,
  WORKFLOW_TEMPLATES,
  type WorkflowTemplate,
} from './comfy-workflow.ts';
import type { ComfyJobSpec } from './protocol.ts';

/** Read a value at a dotted node-input path out of a filled graph (test helper). */
function at(graph: unknown, dottedPath: string): unknown {
  let cur: unknown = graph;
  for (const seg of dottedPath.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

const LTX_SPEC: ComfyJobSpec = {
  prompt: 'a crane folding paper',
  modelId: 'ltx-2',
  workflowTemplate: 'ltx-2-distilled-gguf',
  inputs: {
    prompt: 'a crane folding paper',
    negativePrompt: 'blurry, low quality',
    width: 704,
    height: 480,
    length: 97,
    steps: 8,
  },
  seeds: [111, 222],
};

describe('fillWorkflow', () => {
  it('splices each input at its paramMap node path and stamps the candidate seed', () => {
    const graph = fillWorkflow(LTX_SPEC, 111);
    expect(at(graph, '6.inputs.text')).toBe('a crane folding paper');
    expect(at(graph, '7.inputs.text')).toBe('blurry, low quality');
    expect(at(graph, '70.inputs.width')).toBe(704);
    expect(at(graph, '70.inputs.height')).toBe(480);
    expect(at(graph, '70.inputs.length')).toBe(97);
    expect(at(graph, '72.inputs.steps')).toBe(8);
    expect(at(graph, '73.inputs.noise_seed')).toBe(111);
  });

  it('produces a distinct seed per candidate without mutating the base template', () => {
    const a = fillWorkflow(LTX_SPEC, 111);
    const b = fillWorkflow(LTX_SPEC, 222);
    expect(at(a, '73.inputs.noise_seed')).toBe(111);
    expect(at(b, '73.inputs.noise_seed')).toBe(222);
    // The registry's base template is untouched (deep-cloned per fill).
    const base = getWorkflowTemplate('ltx-2-distilled-gguf');
    expect(at(base?.graph, '73.inputs.noise_seed')).toBe(0);
    expect(at(base?.graph, '6.inputs.text')).toBe('');
  });

  it('the per-candidate seed argument wins over any seed present in inputs', () => {
    const spec: ComfyJobSpec = { ...LTX_SPEC, inputs: { ...LTX_SPEC.inputs, seed: 999 } };
    const graph = fillWorkflow(spec, 42);
    expect(at(graph, '73.inputs.noise_seed')).toBe(42);
  });

  it('preserves untouched nodes (class_type + unrelated inputs stay intact)', () => {
    const graph = fillWorkflow(LTX_SPEC, 111);
    expect(at(graph, '73.class_type')).toBe('KSamplerSelect');
    expect(at(graph, '73.inputs.sampler_name')).toBe('euler'); // Euler default preserved
    expect(at(graph, '9.class_type')).toBe('SaveVideo');
  });

  it('throws on an unknown template id', () => {
    const spec: ComfyJobSpec = { ...LTX_SPEC, workflowTemplate: 'does-not-exist' };
    expect(() => fillWorkflow(spec, 1)).toThrow(/unknown ComfyUI workflow template/);
  });

  it('throws when an input has no paramMap binding in the template', () => {
    const spec: ComfyJobSpec = { ...LTX_SPEC, inputs: { ...LTX_SPEC.inputs, bogusParam: 5 } };
    expect(() => fillWorkflow(spec, 1)).toThrow(/no paramMap binding for input "bogusParam"/);
  });

  it('fills the ACE-Step music template (tags/lyrics/seconds/steps/seed)', () => {
    const spec: ComfyJobSpec = {
      prompt: 'lofi hip hop, mellow',
      modelId: 'ace-step',
      workflowTemplate: 'ace-step-music',
      inputs: { prompt: 'lofi hip hop, mellow', lyrics: 'la la la', seconds: 30, steps: 50 },
      seeds: [7],
    };
    const graph = fillWorkflow(spec, 7);
    expect(at(graph, '14.inputs.tags')).toBe('lofi hip hop, mellow');
    expect(at(graph, '14.inputs.lyrics')).toBe('la la la');
    expect(at(graph, '17.inputs.seconds')).toBe(30);
    expect(at(graph, '3.inputs.steps')).toBe(50);
    expect(at(graph, '3.inputs.seed')).toBe(7);
  });
});

describe('workflow registry ↔ catalog consistency', () => {
  const comfyEntries = MODALITY_CATALOG.filter((m) => m.comfy !== undefined);

  it('the catalog actually has comfyui-backed entries to check', () => {
    expect(comfyEntries.length).toBeGreaterThan(0);
  });

  it('every catalog comfy.workflowTemplate resolves to a registered template', () => {
    for (const m of comfyEntries) {
      const tmpl = getWorkflowTemplate(m.comfy?.workflowTemplate ?? '');
      expect(tmpl, `missing template for ${m.id}`).toBeDefined();
    }
  });

  it("each registered template's paramMap matches its catalog entry's comfy.paramMap", () => {
    for (const m of comfyEntries) {
      const tmpl = getWorkflowTemplate(m.comfy?.workflowTemplate ?? '') as WorkflowTemplate;
      expect(tmpl.paramMap, `paramMap drift for ${m.id}`).toEqual(m.comfy?.paramMap);
    }
  });

  it('every template graph node referenced by a paramMap path exists in the graph', () => {
    for (const tmpl of Object.values(WORKFLOW_TEMPLATES)) {
      for (const path of Object.values(tmpl.paramMap)) {
        const nodeId = path.split('.')[0] ?? '';
        expect(tmpl.graph[nodeId], `${tmpl.id} missing node ${nodeId}`).toBeDefined();
      }
    }
  });
});
