/**
 * Animation-preset previews: short REAL skeletal-animation videos rendered
 * offline on the Mixamo humanoid dummy (~/Downloads/model.fbx) — the Macarena
 * clip for dance_01, procedurally-authored bone clips for the rest (see
 * scripts note in AnimatePanel). Cards show the mid-motion JPEG poster and
 * play the webm on hover. Generated assets — do not hand-edit.
 */
export interface AnimPreview {
  readonly video: string;
  readonly poster: string;
}

export const ANIM_PREVIEWS: Record<string, AnimPreview> = {
  angry_01: {
    video: new URL('./angry_01.webm', import.meta.url).href,
    poster: new URL('./angry_01.jpg', import.meta.url).href,
  },
  afraid: {
    video: new URL('./afraid.webm', import.meta.url).href,
    poster: new URL('./afraid.jpg', import.meta.url).href,
  },
  agree: {
    video: new URL('./agree.webm', import.meta.url).href,
    poster: new URL('./agree.jpg', import.meta.url).href,
  },
  angry_02: {
    video: new URL('./angry_02.webm', import.meta.url).href,
    poster: new URL('./angry_02.jpg', import.meta.url).href,
  },
  cheer: {
    video: new URL('./cheer.webm', import.meta.url).href,
    poster: new URL('./cheer.jpg', import.meta.url).href,
  },
  clap: {
    video: new URL('./clap.webm', import.meta.url).href,
    poster: new URL('./clap.jpg', import.meta.url).href,
  },
  dance_01: {
    video: new URL('./dance_01.webm', import.meta.url).href,
    poster: new URL('./dance_01.jpg', import.meta.url).href,
  },
  hello: {
    video: new URL('./hello.webm', import.meta.url).href,
    poster: new URL('./hello.jpg', import.meta.url).href,
  },
  idle: {
    video: new URL('./idle.webm', import.meta.url).href,
    poster: new URL('./idle.jpg', import.meta.url).href,
  },
  jump: {
    video: new URL('./jump.webm', import.meta.url).href,
    poster: new URL('./jump.jpg', import.meta.url).href,
  },
  kick: {
    video: new URL('./kick.webm', import.meta.url).href,
    poster: new URL('./kick.jpg', import.meta.url).href,
  },
  point: {
    video: new URL('./point.webm', import.meta.url).href,
    poster: new URL('./point.jpg', import.meta.url).href,
  },
  run: {
    video: new URL('./run.webm', import.meta.url).href,
    poster: new URL('./run.jpg', import.meta.url).href,
  },
  sad_01: {
    video: new URL('./sad_01.webm', import.meta.url).href,
    poster: new URL('./sad_01.jpg', import.meta.url).href,
  },
  walk: {
    video: new URL('./walk.webm', import.meta.url).href,
    poster: new URL('./walk.jpg', import.meta.url).href,
  },
  wave: {
    video: new URL('./wave.webm', import.meta.url).href,
    poster: new URL('./wave.jpg', import.meta.url).href,
  },
};
