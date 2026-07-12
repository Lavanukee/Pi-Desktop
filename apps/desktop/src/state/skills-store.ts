/**
 * Renderer skills state for the connectors screen's Skills tab. Mirrors the
 * bundled-skills catalog + install state owned by the main process
 * (`~/.pi/agent/skills/<id>`, via the skills:* IPC). Installing/removing a skill
 * round-trips through IPC and adopts the returned list so the tab stays in sync;
 * the pi engine picks up an installed skill on the next session/spawn.
 */
import { create } from 'zustand';
import type { SkillListItem } from '../../electron/skills/skills-contract';

interface SkillsStoreState {
  skills: SkillListItem[];
  loaded: boolean;
  busyId: string | null;
  error: string | null;
  load: () => Promise<void>;
  /** Copy a bundled skill into the agent skills dir. */
  install: (id: string) => Promise<void>;
  /** Remove an installed skill from the agent skills dir. */
  remove: (id: string) => Promise<void>;
  /** Install when off, remove when on (the Skills-tab enable toggle). */
  toggle: (id: string, next: boolean) => Promise<void>;
  /** Read a bundled skill's SKILL.md body for the skill detail view. */
  readSkill: (id: string) => Promise<{ body: string; error?: string }>;
}

export const useSkillsStore = create<SkillsStoreState>((set, get) => ({
  skills: [],
  loaded: false,
  busyId: null,
  error: null,

  load: async () => {
    const { skills } = await window.piDesktop.invoke('skills:list', undefined);
    set({ skills, loaded: true });
  },

  install: async (id) => {
    set({ busyId: id, error: null });
    try {
      const { skills, error } = await window.piDesktop.invoke('skills:install', { id });
      set({ skills, error: error ?? null });
    } finally {
      set({ busyId: null });
    }
  },

  remove: async (id) => {
    set({ busyId: id, error: null });
    try {
      const { skills, error } = await window.piDesktop.invoke('skills:remove', { id });
      set({ skills, error: error ?? null });
    } finally {
      set({ busyId: null });
    }
  },

  toggle: async (id, next) => {
    await (next ? get().install(id) : get().remove(id));
  },

  readSkill: async (id) => {
    return window.piDesktop.invoke('skills:read', { id });
  },
}));
