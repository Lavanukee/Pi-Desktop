/**
 * Semantic design-token vocabulary for Pi Desktop and the four theme
 * definitions (claude|codex x light|dark) that fill it.
 *
 * Values are hand-reviewed distillations of the dev-machine token harvest
 * (scripts/capture-tokens; see docs/theming notes in docs/architecture.md).
 * The component-level slots (sidebar/selected/track surfaces, bubble, tooltip,
 * inline-code/code-block, diff, scrollbar, semantic radii, layout metrics and
 * the motion-preset parameters) come from the component spec book
 * (element-extraction/spec-book/_new-tokens.md), reconciled 2026-07-08.
 * Sources per slot:
 *   - claude: Claude Desktop windowShared chrome ramp + CDS tokens.vanilla.css
 *     export (slots the chrome ramp lacks: popover surface, shadows, warning,
 *     radius/spacing/motion).
 *   - codex: Codex Desktop .electron-light/.electron-dark semantic tokens over
 *     Tailwind v4 primitives.
 * Slots with no harvested source are derived and marked with "derived:".
 *
 * Only derived token *values* live here (colors/sizes/curves as data). No CSS
 * was copied wholesale and no proprietary fonts are referenced or bundled.
 */

export type ThemeFlavor = 'claude' | 'codex' | 'bobble';
export type ThemeMode = 'light' | 'dark';
export type ThemeId = `${ThemeFlavor}-${ThemeMode}`;

/** Type scale slots shared by font sizes and line heights. */
export type TypeScaleSlot = 'caption' | 'footnote' | 'body' | 'code' | 'heading' | 'title';

export type StatusKind = 'info' | 'success' | 'warning' | 'danger';

export interface StatusTokens {
  /** Tinted background for banners/badges. */
  bg: string;
  /** Foreground/text color carrying the status. */
  fg: string;
  /** Border for outlined status surfaces. */
  border: string;
}

export interface ThemeTokens {
  bg: {
    /** App/window background. */
    base: string;
    /** Cards, composer, elevated panels. */
    raised: string;
    /** Popovers, menus, dialogs. */
    overlay: string;
    /** Wells, code blocks, kbd chips — recessed surfaces. */
    inset: string;
    /** Hover wash composited over any surface (alpha color). */
    hover: string;
    /** Active/pressed wash composited over any surface (alpha color). */
    active: string;
    /** Modal scrim behind dialogs. */
    backdrop: string;
    /** Sidebar / top-tray chrome surface (spec-sidebar). */
    sidebar: string;
    /** Persistent selected wash — distinct from transient hover (spec-sidebar). */
    selected: string;
    /** Segmented-control / slider track (spec-model-picker). */
    track: string;
  };
  text: {
    primary: string;
    secondary: string;
    muted: string;
    /** Text on inverted surfaces (e.g. tooltips using text.primary as bg). */
    inverse: string;
    /** Text on accent.primary fills. */
    onAccent: string;
    /** Hyperlinks. Claude keeps a separate blue; codex uses its accent blue. */
    link: string;
    /** Input/composer placeholder text (spec-composer). */
    placeholder: string;
    /** Ghost text — collapsed reasoning headers, fg @30% (spec-thinking-block). */
    ghost: string;
  };
  border: {
    subtle: string;
    default: string;
    strong: string;
    focus: string;
  };
  accent: {
    /** Primary action fill. Claude: brand clay. Codex: near-black/white pill. */
    primary: string;
    hover: string;
    active: string;
    /** Accent-tinted background (selection, info-ish chips). */
    subtle: string;
  };
  status: Record<StatusKind, StatusTokens>;
  /** User message bubble (spec-message-row). */
  bubble: {
    bg: string;
    fg: string;
  };
  /** Tooltip surface. Claude: theme-invariant black glass; codex: theme pill. */
  tooltip: {
    bg: string;
    fg: string;
  };
  /** Inline-code chip + code-block panel (spec-markdown). */
  codeSurface: {
    inlineBg: string;
    /** Claude signature: danger-tinted inline code text; codex stays neutral. */
    inlineFg: string;
    inlineBorder: string;
    blockBg: string;
    blockBorder: string;
  };
  /** Git-decoration colors, distinct from status ramps (spec-diff-view). */
  diff: {
    addedFg: string;
    deletedFg: string;
    modifiedFg: string;
  };
  scrollbar: {
    thumb: string;
    thumbHover: string;
  };
  /**
   * Sidebar treatment (spec-sidebar round-3). Claude floats a bordered, rounded
   * panel over the page bg; codex frosts it into translucent glass.
   */
  sidebar: {
    /** Floating-panel border (claude); hairline for codex. */
    border: string;
    /** Floating-panel drop shadow so it reads lifted (claude); `none` for codex. */
    shadow: string;
    /** Surface opacity — claude 1 (opaque float), codex <1 (frosted). */
    translucency: string;
    /** Backdrop blur behind the surface — codex frosted glass; claude 0. */
    blur: string;
  };
  shimmer: {
    /** Resting text color of "thinking" shimmer content. */
    base: string;
    /** Sweeping highlight color. */
    highlight: string;
  };
  font: {
    sans: string;
    serif: string;
    mono: string;
    size: Record<TypeScaleSlot, string>;
    leading: Record<TypeScaleSlot, string>;
    weight: {
      regular: string;
      medium: string;
      semibold: string;
      bold: string;
      /** Default body copy weight — codex signature is 430. */
      body: string;
    };
    /** Assistant response voice — THE serif-vs-sans flavor split (spec-markdown). */
    response: {
      family: string;
      size: string;
      leading: string;
      /** font-variation-settings; claude dark drops serif wght 400 -> 360. */
      variation: string;
    };
  };
  radius: {
    xs: string;
    sm: string;
    md: string;
    lg: string;
    full: string;
    /** Composer / dialog cards (spec-composer, spec-dialog). */
    surface: string;
    /** Menus, tooltips, palettes (spec-dropdown-menu). */
    popover: string;
    /** Sidebar/list rows — codex signature is the full pill (spec-sidebar). */
    row: string;
    /** User message bubble (spec-message-row). */
    bubble: string;
    /** Buttons — claude rounded-lg vs codex pill (spec-buttons). */
    button: string;
    /** Menu item highlight (spec-dropdown-menu; codex 8px -> 10px squircle). */
    menuItem: string;
  };
  shadow: {
    sm: string;
    md: string;
    lg: string;
    popover: string;
    /** The shared hairline-as-0.5px-box-shadow idiom (cross-cutting DNA). */
    hairline: string;
  };
  /** Translucent-surface treatment (codex vibrancy; claude stays opaque). */
  surface: {
    /** Overlay-surface opacity: claude 1.0 (opaque), codex 0.9. */
    translucency: string;
    /** backdrop-filter blur for popover surfaces (codex 8px; scale up for dialogs). */
    blurOverlay: string;
    /** backdrop-filter blur on the dialog scrim (claude 2px). */
    blurBackdrop: string;
  };
  motion: {
    duration: {
      fast: string;
      base: string;
      slow: string;
      /** Dialogs close faster than they open in both apps (asymmetric). */
      dialogIn: string;
      dialogOut: string;
      menu: string;
      toast: string;
    };
    easing: {
      standard: string;
      enter: string;
      exit: string;
      press: string;
      /** Claude press-release overshoot spring; codex has none (= enter). */
      spring: string;
      toast: string;
    };
    /** Button :active scale. Codex presses with alpha only (scale 1). */
    pressScale: string;
    /** Small-control press scale (claude nested controls use 0.96). */
    pressScaleSmall: string;
    shimmerDuration: string;
    /** Codex signature: steps(48, end); claude sweeps smoothly. */
    shimmerEasing: string;
    /** Menu enter preset params: claude panel-in vs codex dropdown-enter. */
    menuEnterDistance: string;
    menuEnterScale: string;
    /** Per-item entrance stagger — claude 30ms, codex none. */
    menuStagger: string;
    /** Codex menu items rest at 75% opacity; claude at 100%. */
    menuItemRestingOpacity: string;
    /** Dialog enter preset params: claude zoom (.95) vs codex rise (8px, .98). */
    dialogEnterScale: string;
    dialogEnterTranslate: string;
    dialogOrigin: string;
    /** Toast entrance offset: claude slides in on x, codex drops in on y. */
    toastEnterX: string;
    toastEnterY: string;
  };
  spacing: {
    xs: string;
    sm: string;
    md: string;
    lg: string;
    xl: string;
    xxl: string;
    xxxl: string;
  };
  control: {
    sm: string;
    md: string;
    lg: string;
    /** Default icon glyph size. */
    icon: string;
    /**
     * Default stroke width for stroked icons, in SVG user units (unitless).
     * Consumed globally via `--pd-icon-stroke` by `.pd-icon`; the app's
     * settings can override it live on the document root.
     */
    iconStroke: string;
  };
  /** Structural metrics that flavor the app shell (spec-book layout tokens). */
  layout: {
    /** Sidebar/list row height — drives the parametric row system. */
    rowHeight: string;
    sidebarWidth: string;
    topbarHeight: string;
    threadWidth: string;
    /** Assistant prose cap inside the thread column. */
    proseWidth: string;
    thinkingPreviewHeight: string;
    /** Menu panel padding: claude 0 + roomy items, codex 4px + tight items. */
    menuPadding: string;
  };
}

/* ------------------------------------------------------------------ */
/* Flavor-level constants (mode-independent within a flavor)           */
/* ------------------------------------------------------------------ */

const claudeFont: Omit<ThemeTokens['font'], 'response'> = {
  // Anthropic Sans/Serif are proprietary; Inter + Source Serif 4 (both OFL,
  // bundled via fontsource) stand in, with the harvested fallback stacks.
  sans: "'Inter Variable', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  serif: "'Source Serif 4 Variable', ui-serif, Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  // CDS px scale. Footnote bumped 13->14 (jedd round-2 THEME 5: still too small)
  // so message/model footnotes read at body size while staying muted.
  size: {
    caption: '12px',
    footnote: '14px',
    body: '14px',
    code: '13px',
    heading: '15px',
    title: '22px',
  },
  leading: {
    caption: '14px',
    footnote: '19px',
    body: '20px',
    code: '19px',
    heading: '20px',
    title: '26px',
  },
  weight: { regular: '400', medium: '500', semibold: '600', bold: '700', body: '400' },
};

/** Claude response voice: serif 16px/1.5; dark drops variable wght to 360. */
function claudeResponse(mode: ThemeMode): ThemeTokens['font']['response'] {
  return {
    family: claudeFont.serif,
    size: '16px',
    leading: '24px', // 1.5 at 16px
    variation: mode === 'dark' ? "'wght' 360" : 'normal',
  };
}

const codexFont: Omit<ThemeTokens['font'], 'response'> = {
  // Codex ships no UI font: pure system stack.
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  // derived: codex has no serif face (Carlito exists only for pptx); generic stack.
  serif: "ui-serif, Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  // xs 11 / sm 12 / base 14 / lg 16 / heading-lg 24. Footnote bumped 12->13
  // (jedd round-2 THEME 5: still too small) for legible muted footnotes.
  size: {
    caption: '11px',
    footnote: '13px',
    body: '14px',
    code: '12px',
    heading: '16px',
    title: '24px',
  },
  // derived: computed from codex line-height ratios (1.333/1.4/1.5/1.55/1.25), rounded.
  leading: {
    caption: '15px',
    footnote: '18px',
    body: '21px',
    code: '17px',
    heading: '25px',
    title: '30px',
  },
  weight: { regular: '400', medium: '500', semibold: '600', bold: '700', body: '430' },
};

/** Codex response voice: sans 14px, line-height = size + 8px (spec-markdown). */
const codexResponse: ThemeTokens['font']['response'] = {
  family: codexFont.sans,
  size: '14px',
  leading: '22px',
  variation: 'normal',
};

const claudeRadius: ThemeTokens['radius'] = {
  xs: '4px',
  sm: '6px',
  md: '8px', // --radius: 8px is the CDS anchor
  lg: '12px',
  full: '9999px',
  surface: '16px', // composer/dialog rounded-2xl
  popover: '8px', // menu panel rounded-lg
  row: '8px', // dframe row pill (compact 6)
  bubble: '10px', // user bubble rounded-r7 — deliberately smaller than composer
  button: '8px', // default button; sizes scale 6-9.6 via calc
  menuItem: '4px', // classic full-row highlight radius
};

// Codex base radii; the squircle @supports block scales these x1.25, which
// reproduces the runtime-observed values (surface 25, popover 15, bubble 20,
// menu item 10) on engines with corner-shape support.
const codexRadius: ThemeTokens['radius'] = {
  xs: '4px',
  sm: '6px',
  md: '8px',
  lg: '10px', // --radius-lg-base .625rem
  full: '9999px',
  surface: '20px', // radius-3xl (25px observed w/ squircle)
  popover: '12px', // radius-xl (15px observed)
  row: '9999px', // full-pill rows — the codex signature
  bubble: '16px', // 20px computed at runtime = 16 x 1.25 squircle
  button: '9999px', // pills everywhere (icon/toolbar stay radius-md in CSS)
  menuItem: '8px', // 10px observed w/ squircle
};

const claudeMotion: ThemeTokens['motion'] = {
  duration: {
    fast: '100ms',
    base: '150ms',
    slow: '250ms',
    dialogIn: '250ms', // --modal-animation-duration
    dialogOut: '125ms', // asymmetric close = half of open
    menu: '200ms', // _panelIn
    toast: '200ms',
  },
  easing: {
    standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
    enter: 'cubic-bezier(0.165, 0.84, 0.44, 1)', // CDS --ease-out
    exit: 'cubic-bezier(0.4, 0, 1, 1)',
    press: 'cubic-bezier(0.165, 0.85, 0.45, 1)', // Anthropic press/settle curve
    // --cds-btn-spring release overshoot (~.3-.45s), sampled linear() curve.
    spring: 'linear(0, 0.3505, 0.7432, 0.9336, 0.9951, 1.0062, 1.0045, 1.0019, 1.0005, 1)',
    toast: 'cubic-bezier(0.16, 1, 0.3, 1)', // Radix toast translateX-in
  },
  pressScale: '0.98',
  pressScaleSmall: '0.96',
  shimmerDuration: '2.25s', // shimmertext 2.25s infinite
  shimmerEasing: 'ease-in-out', // smooth variant; codex owns the stepped look
  menuEnterDistance: '4px', // panel-in 4px rise
  menuEnterScale: '1',
  menuStagger: '30ms', // per-child animation-delay stagger
  menuItemRestingOpacity: '1',
  dialogEnterScale: '0.95', // zoom .95 -> 1
  dialogEnterTranslate: '0px',
  dialogOrigin: 'center',
  toastEnterX: '16px', // slides in from the side
  toastEnterY: '0px',
};

const codexMotion: ThemeTokens['motion'] = {
  duration: {
    fast: '100ms',
    base: '150ms',
    slow: '300ms',
    dialogIn: '300ms', // codex-dialog-enter
    dialogOut: '150ms',
    menu: '150ms', // dropdown-content-enter
    toast: '250ms', // toast-open
  },
  easing: {
    standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
    enter: 'cubic-bezier(0.19, 1, 0.22, 1)', // --cubic-enter
    exit: 'cubic-bezier(0.65, 0, 0.4, 1)', // --cubic-exit-snappy
    press: 'cubic-bezier(0.65, 0, 0.4, 1)', // derived: codex has no press curve
    spring: 'cubic-bezier(0.19, 1, 0.22, 1)', // no spring — expo-out is the flavor
    toast: 'cubic-bezier(0.175, 0.885, 0.32, 1)', // back-out
  },
  pressScale: '1', // codex buttons never scale; hover/active are alpha overlays
  pressScaleSmall: '1',
  shimmerDuration: '2s',
  shimmerEasing: 'steps(48, end)', // signature 48fps quantized sweep
  menuEnterDistance: '2px', // dropdown-enter 2px slide
  menuEnterScale: '0.98',
  menuStagger: '0ms', // no stagger — restraint is the flavor
  menuItemRestingOpacity: '0.75',
  dialogEnterScale: '0.98',
  dialogEnterTranslate: '8px', // rise from 8px below, origin top
  dialogOrigin: 'top',
  toastEnterX: '0px',
  toastEnterY: '-4px', // toast-open drops in from -4px
};

// Both apps sit on a 4px grid; CDS pad/gap scale matches.
const spacing: ThemeTokens['spacing'] = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
  xxl: '32px',
  xxxl: '40px',
};

const claudeControl: ThemeTokens['control'] = {
  sm: '24px', // derived: between --h-control-nested 22 and --h-control 32
  md: '32px', // --h-control
  lg: '40px', // derived: +8 step
  icon: '20px', // --icon
  iconStroke: '1.25', // lighter than the old hardcoded 1.5 (jedd: icons too thick)
};

const codexControl: ThemeTokens['control'] = {
  sm: '24px', // derived: composer small button is 20px; 24 keeps hit targets sane
  md: '28px', // --spacing-token-button-composer (7 x 4px)
  lg: '36px', // --height-toolbar-sm
  icon: '16px', // derived: codex glyphs render at 16px in 28px controls
  iconStroke: '1.25', // global icon stroke; single value across flavors
};

const claudeLayout: ThemeTokens['layout'] = {
  rowHeight: '32px', // --df-row-h (compact 26; claude.ai Home ~40 — conflict flagged)
  sidebarWidth: '288px', // --df-sidebar-width
  topbarHeight: '46px', // observed 44-48; spec recommends 46
  threadWidth: '840px',
  proseWidth: '576px', // 36rem max-w-xl assistant prose cap
  thinkingPreviewHeight: '72px',
  menuPadding: '0px', // classic full-row highlight, no panel inset
};

const codexLayout: ThemeTokens['layout'] = {
  rowHeight: '30px', // --height-token-row = 14px*1.5 + 2*4px
  sidebarWidth: '240px',
  topbarHeight: '46px', // --height-toolbar
  threadWidth: '736px',
  proseWidth: '640px', // 40rem markdown text column
  thinkingPreviewHeight: '72px', // adopted from claude (no codex evidence against)
  menuPadding: '4px',
};

const claudeSurface: ThemeTokens['surface'] = {
  translucency: '1', // claude stays opaque
  blurOverlay: '0px',
  blurBackdrop: '2px', // dialog overlay backdrop-blur
};

const codexSurface: ThemeTokens['surface'] = {
  translucency: '0.9', // menus/dialogs at 90% + blur
  blurOverlay: '8px', // menus 8 / composer 16 / dialogs 24 (scale by calc)
  blurBackdrop: '0px',
};

// Codex shadows are mode-independent; sm is derived (codex has md/xl/2xl only).
const codexShadowBase = {
  sm: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
  md: '0 2px 4px -1px rgba(0, 0, 0, 0.08)',
  lg: '0 8px 16px -4px rgba(0, 0, 0, 0.12)',
  popover: '0 16px 32px -8px rgba(0, 0, 0, 0.19)',
};

/* ------------------------------------------------------------------ */
/* Theme definitions                                                   */
/* ------------------------------------------------------------------ */

const claudeLight: ThemeTokens = {
  bg: {
    base: '#faf9f5', // --bg-100 warm ivory
    raised: '#ffffff', // --bg-000
    overlay: '#ffffff', // CDS --surface-popover
    inset: '#f5f4ed', // --bg-200
    hover: '#0b0b0b0d', // CDS --fill-ghost-hover (neutral-900 @ 5%)
    active: '#0b0b0b1a', // CDS --fill-control (neutral-900 @ 10%)
    backdrop: '#00000066', // CDS --backdrop rgb(0 0 0 / 0.4)
    sidebar: '#ffffff', // observed sidebar surface on Home
    selected: '#e7e7e7', // --df-selected / --cds-alpha-2 (observed on New chat)
    track: '#f3f3f3', // segmented-control track (observed)
  },
  text: {
    primary: '#141413', // --text-100
    secondary: '#3d3d3a', // --text-200
    muted: '#73726c', // --text-400
    inverse: '#ffffff',
    onAccent: '#ffffff', // --oncolor-100
    link: '#2c84db', // --accent-100
    placeholder: '#7b7a75', // text-500 (observed)
    ghost: '#1414134d', // derived: text-100 @ 30%
  },
  border: {
    subtle: '#0b0b0b1a', // CDS --border (neutral-900 @ 10%)
    // jedd round-5 #9: composer/divider/box borders read too dark — lighten the
    // warm border ramp (25% -> 15%, 65% -> 38%) so boxes sit as light as the
    // sidebar/input hairline without washing out.
    default: '#706b5726', // --claude-border (warm 15%)
    strong: '#706b5761', // --claude-border-300-more (38%)
    focus: '#2c84db', // --accent-100
  },
  accent: {
    primary: '#d97757', // clay
    hover: '#c86848', // --clay-hover
    active: '#c6613f', // --clay-emphasized
    subtle: '#d977571f', // derived: clay @ 12%
  },
  status: {
    info: { bg: '#cde2fb', fg: '#184f95', border: '#86b6ef' }, // blue-100/600/250
    success: { bg: '#caeac7', fg: '#006300', border: '#73cb6d' }, // green-100/600/250
    warning: { bg: '#f9dca4', fg: '#734500', border: '#eda100' }, // yellow-100/600/250
    danger: { bg: '#fad6d6', fg: '#8e2626', border: '#f09595' }, // red-100/600/250
  },
  bubble: {
    // jedd round-5 #10: the user bubble was clay/orange-tinted — swap to a
    // NEUTRAL surface (text-primary @ ~8%), a subtle warm-gray card, no accent.
    bg: '#14141314', // neutral: text.primary @ ~8%
    fg: '#141413', // --ui-user-message-primary-text = text.primary
  },
  tooltip: {
    bg: '#000000cc', // theme-invariant black glass (always-black @ 80%)
    fg: '#ffffff', // always-white
  },
  codeSurface: {
    inlineBg: '#3d3d3a0d', // text-200 @ 5%
    inlineFg: '#8e2626', // danger-tinted inline code — the claude signature
    inlineBorder: '#706b5740', // border-300 @ 25%, drawn at 0.5px
    blockBg: '#ffffff80', // bg-000 @ 50% translucent panel
    // jedd round-5 #6/#9: was border-strong (dark). Lightened to the input/box
    // hairline weight so tool boxes + code panels read light.
    blockBorder: '#706b5726', // warm border @ ~15% (= border.default)
  },
  diff: {
    addedFg: '#006300', // success-600 — claude aliases diff to its status ramps
    deletedFg: '#8e2626',
    modifiedFg: '#734500',
  },
  scrollbar: {
    thumb: '#7b7a75cc', // text-500 @ 80% (editorial 4px pill)
    thumbHover: '#7b7a75',
  },
  sidebar: {
    // claude: floating bordered panel over the warm-ivory page bg.
    border: '#0b0b0b1a', // CDS --border hairline
    shadow: '0 6px 20px -6px rgba(11, 11, 11, 0.14)',
    translucency: '1',
    blur: '0px',
  },
  shimmer: {
    base: '#14141373', // derived: text.primary @ 45%
    highlight: '#141413c7', // derived: text.primary @ 78%
  },
  font: { ...claudeFont, response: claudeResponse('light') },
  radius: claudeRadius,
  shadow: {
    sm: '0 1px 2px 0 rgba(11, 11, 11, 0.06), 0 2px 8px 0 rgba(11, 11, 11, 0.08)',
    md: '0 2px 4px 0 rgba(11, 11, 11, 0.07), 0 6px 16px 0 rgba(11, 11, 11, 0.08)',
    lg: '0 4px 8px 0 rgba(11, 11, 11, 0.08), 0 12px 28px -2px rgba(11, 11, 11, 0.08)',
    popover: '0 8px 24px rgba(0, 0, 0, 0.12), 0 2px 6px rgba(0, 0, 0, 0.08)',
    hairline: '0 0 0 0.5px rgba(0, 0, 0, 0.1)', // shadow-element hairline
  },
  surface: claudeSurface,
  motion: claudeMotion,
  spacing,
  control: claudeControl,
  layout: claudeLayout,
};

const claudeDark: ThemeTokens = {
  bg: {
    base: '#262624', // --bg-100
    raised: '#30302e', // --bg-000 (dark ramp inverts: raised is lighter)
    overlay: '#383835', // CDS --surface-3
    inset: '#1f1e1d', // --bg-200
    hover: '#ffffff0d', // CDS dark alpha ramp flips to white @ 5%
    active: '#ffffff1a', // white @ 10%
    backdrop: '#00000080', // CDS --backdrop dark rgb(0 0 0 / 0.5)
    sidebar: '#1f1e1df2', // gray-860 family @ 95% (vibrancy; solid-ish fallback)
    selected: '#ffffff1a', // white @ 10% persistent selected wash
    track: '#ffffff14', // derived: white @ 8%
  },
  text: {
    primary: '#faf9f5',
    secondary: '#c2c0b6',
    muted: '#9c9a92',
    inverse: '#0b0b0b', // CDS --on-primary dark
    onAccent: '#ffffff', // clay fills keep white text in dark mode
    link: '#74abe2', // --accent-000 dark
    placeholder: '#a6a39b', // text-500 dark
    ghost: '#faf9f54d', // derived: text-100 dark @ 30%
  },
  border: {
    subtle: '#eaddd81a', // --claude-border dark hairline
    // jedd round-5 #9: lighten the dark border ramp too (25% -> 18%, 58% -> 38%).
    default: '#6c6a602e', // --claude-border-300 dark (controls) @ ~18%
    strong: '#6c6a6061', // --claude-border-300-more dark @ ~38%
    focus: '#74abe2',
  },
  accent: {
    primary: '#d97757', // clay unchanged in dark
    hover: '#c86848',
    active: '#c6613f',
    subtle: '#d9775726', // derived: clay @ 15%
  },
  status: {
    info: { bg: '#032042', fg: '#6da7ec', border: '#0d366b' }, // blue-800/300/700
    success: { bg: '#11260f', fg: '#0ca30c', border: '#074506' }, // green-800/400/700
    warning: { bg: '#311a00', fg: '#db9300', border: '#512e00' }, // yellow-800/300/700
    danger: { bg: '#3c0e0e', fg: '#ec7e7e', border: '#641919' }, // red-800/300/700
  },
  bubble: {
    // jedd round-5 #10: neutral (warm-white @ ~10%), no clay tint.
    bg: '#faf9f51a', // neutral: text.primary @ ~10% dark
    fg: '#faf9f5',
  },
  tooltip: {
    bg: '#000000cc', // black glass in both modes
    fg: '#ffffff',
  },
  codeSurface: {
    inlineBg: '#c2c0b60d', // text-200 dark @ 5%
    inlineFg: '#ec7e7e', // danger-000 dark family
    inlineBorder: '#6c6a6040',
    blockBg: '#30302e80', // bg-000 dark @ 50%
    // jedd round-5 #6/#9: lightened from border-strong to the box hairline weight.
    blockBorder: '#6c6a602e', // warm border @ ~18% dark (= border.default)
  },
  diff: {
    addedFg: '#0ca30c',
    deletedFg: '#ec7e7e',
    modifiedFg: '#db9300',
  },
  scrollbar: {
    thumb: '#a6a39bcc', // text-500 dark @ 80%
    thumbHover: '#a6a39b',
  },
  sidebar: {
    // claude dark: floating panel lifts off the darker page bg with a soft shadow.
    border: '#eaddd81a', // warm-white hairline dark
    shadow: '0 6px 20px -6px rgba(0, 0, 0, 0.4)',
    translucency: '1',
    blur: '0px',
  },
  shimmer: {
    base: '#faf9f573', // derived: text.primary @ 45%
    highlight: '#faf9f5c7', // derived: text.primary @ 78%
  },
  font: { ...claudeFont, response: claudeResponse('dark') },
  radius: claudeRadius,
  shadow: {
    // CDS --shadow-color dark = rgba(0,0,0,.24); popover from CDS dark override.
    sm: '0 1px 2px 0 rgba(0, 0, 0, 0.06), 0 2px 8px 0 rgba(0, 0, 0, 0.24)',
    md: '0 2px 4px 0 rgba(0, 0, 0, 0.07), 0 6px 16px 0 rgba(0, 0, 0, 0.24)',
    lg: '0 4px 8px 0 rgba(0, 0, 0, 0.08), 0 12px 28px -2px rgba(0, 0, 0, 0.24)',
    popover: '0 8px 24px rgba(0, 0, 0, 0.32), 0 2px 6px rgba(0, 0, 0, 0.2)',
    hairline: '0 0 0 0.5px rgba(234, 221, 216, 0.1)', // warm white hairline dark
  },
  surface: claudeSurface,
  motion: claudeMotion,
  spacing,
  control: claudeControl,
  layout: claudeLayout,
};

const codexLight: ThemeTokens = {
  bg: {
    base: '#ffffff', // --color-background-surface (gray-0)
    raised: '#ffffff', // elevated-primary-opaque (translucency needs vibrancy)
    overlay: '#ffffff', // elevated surfaces; the popover shadow does the lifting
    inset: '#1a1c1f05', // elevated-secondary: fg @ 2%
    hover: '#1a1c1f0d', // hover grammar: fg @ 5%
    active: '#1a1c1f1a', // fg @ 10%
    backdrop: '#0000001a', // --color-simple-scrim (10%) — codex scrims are airy
    sidebar: '#f6f6f6', // app-shell-left-panel (solid fallback of the editor mix)
    selected: '#1a1c1f0d', // rgba(26,28,31,.049) persistent selected wash
    track: '#ffffff', // input-background; the 0.5px border-heavy hairline defines it
  },
  text: {
    primary: '#1a1c1f', // --color-text-foreground
    secondary: '#1a1c1fb3', // fg @ 70%
    muted: '#1a1c1f80', // fg @ 50%
    inverse: '#ffffff',
    onAccent: '#ffffff', // --color-text-button-primary
    link: '#339cff', // --color-text-accent (blue-300)
    placeholder: '#1a1c1f7e', // input-placeholder: fg @ 49.5%
    ghost: '#1a1c1f4d', // conversation-header: fg @ 30%
  },
  border: {
    subtle: '#1a1c1f0d', // border-light: fg @ 5%
    default: '#1a1c1f14', // --color-border: fg @ 8%
    strong: '#1a1c1f1f', // border-heavy: fg @ 12%
    focus: '#339cff', // --color-border-focus (blue-300)
  },
  accent: {
    primary: '#1a1c1f', // primary button is near-black; blue is links/focus only
    hover: '#2c2e31', // derived: composed white @ 8% overlay on primary
    active: '#3f4043', // derived: composed white @ 16% overlay
    subtle: '#e5f3ff', // --color-background-accent (blue-50)
  },
  status: {
    info: { bg: '#e5f3ff', fg: '#0285ff', border: '#339cff26' }, // blue-50/400; border derived @ 15%
    success: { bg: '#00a24012', fg: '#00a240', border: '#00a24026' }, // green @ 7%; green-500; derived @ 15%
    warning: { bg: '#ffe7d9', fg: '#e25507', border: '#e2550726' }, // orange-50/500; orange @ 15%
    danger: { bg: '#ffd9d9', fg: '#e02e2a', border: '#e02e2a26' }, // red-50/500; red @ 15%
  },
  bubble: {
    bg: '#1a1c1f0d', // bg-token-foreground/5 (computed oklab ~5%)
    fg: '#1a1c1f',
  },
  tooltip: {
    bg: '#ffffff', // = bg.overlay — codex tooltip is a theme pill
    fg: '#1a1c1f',
  },
  codeSurface: {
    inlineBg: '#1a1c1f17', // mix(list-hover 60%, fg 6%) ≈ fg @ 9%
    inlineFg: '#1a1c1f', // neutral — no danger tint in codex
    inlineBorder: '#00000000', // none
    blockBg: '#1a1c1f08', // code-block wash ~3%
    blockBorder: '#1a1c1f0d', // border-light, drawn at 1px
  },
  diff: {
    addedFg: '#00a240', // git-decoration-added
    deletedFg: '#ba2623', // git-decoration-deleted (computed)
    modifiedFg: '#923b0f',
  },
  scrollbar: {
    thumb: '#1a1c1f14', // token-scrollbar-slider: fg @ 7.8%
    thumbHover: '#1a1c1f1e', // fg @ 11.7%
  },
  sidebar: {
    // codex: frosted glass — translucent surface + backdrop blur, minimal frame.
    border: '#1a1c1f0d', // border-light: fg @ 5%
    shadow: 'none',
    translucency: '0.72',
    blur: '18px',
  },
  shimmer: {
    base: '#1a1c1f8c', // --shimmer-text-secondary: fg @ 55%
    highlight: '#1a1c1fc7', // --shimmer-contrast: fg @ 78%
  },
  font: { ...codexFont, response: codexResponse },
  radius: codexRadius,
  shadow: {
    ...codexShadowBase,
    hairline: '0 0 0 0.5px rgba(26, 28, 31, 0.12)', // elevation-stroke: fg @ 12%
  },
  surface: codexSurface,
  motion: codexMotion,
  spacing,
  control: codexControl,
  layout: codexLayout,
};

const codexDark: ThemeTokens = {
  bg: {
    base: '#181818', // gray-900
    raised: '#212121', // gray-800 (elevated-primary is #212121f5 over vibrancy)
    overlay: '#282828', // gray-750 (elevated-primary-opaque)
    inset: '#ffffff08', // elevated-secondary: white @ 3%
    hover: '#ffffff14', // white @ 8%
    active: '#ffffff1f', // white @ 12%
    backdrop: '#00000066', // derived: black @ 40% (harvest scrim is vibrancy-bound)
    sidebar: '#181818', // solid fallback of color-mix(editor-bg 55%) over vibrancy
    selected: '#ffffff14', // derived: white @ 8% persistent wash
    track: '#282828', // dropdown-bg
  },
  text: {
    primary: '#ffffff',
    secondary: '#ffffffb3', // white @ 70%
    muted: '#ffffff80', // white @ 50%
    inverse: '#0d0d0d', // gray-1000
    onAccent: '#0d0d0d', // white pill carries near-black text
    link: '#99ceff', // --color-text-accent dark (blue-100)
    placeholder: '#ffffff80', // white @ 50%
    ghost: '#ffffff4d', // white @ 30%
  },
  border: {
    subtle: '#ffffff0a', // white @ 4%
    default: '#ffffff14', // white @ 8%
    strong: '#ffffff29', // white @ 16%
    focus: '#339cffb3', // blue-300 @ 70%
  },
  accent: {
    // The shipped CSS sets bg AND text to gray-1000; the visible white pill is
    // composed at runtime (harvest conflict #4) — we bake the composition in.
    primary: '#ffffff',
    hover: '#f0f0f0', // derived: gray-1000 @ 6% over white
    active: '#e7e7e7', // derived: gray-1000 @ 10% over white
    subtle: '#00284d', // --color-background-accent dark (blue-900)
  },
  status: {
    info: { bg: '#00284d', fg: '#99ceff', border: '#339cff66' }, // blue-900/100; border derived @ 40%
    success: { bg: '#04b84c29', fg: '#40c977', border: '#40c97766' }, // green @ 16%; green-300; derived @ 40%
    warning: { bg: '#4a2206', fg: '#ff8549', border: '#ff854966' }, // orange-900/300; orange @ 40%
    danger: { bg: '#4d100e', fg: '#ff6764', border: '#fa423e66' }, // red-900/300; red-400 @ 40%
  },
  bubble: {
    bg: '#ffffff0d', // white @ 5% (derived)
    fg: '#ffffff',
  },
  tooltip: {
    bg: '#282828', // = bg.overlay
    fg: '#ffffff',
  },
  codeSurface: {
    inlineBg: '#ffffff17', // white @ 9% (derived)
    inlineFg: '#ffffff',
    inlineBorder: '#00000000',
    blockBg: '#ffffff08',
    blockBorder: '#ffffff0a',
  },
  diff: {
    addedFg: '#40c977',
    deletedFg: '#fa423e',
    modifiedFg: '#ff8549',
  },
  scrollbar: {
    thumb: '#ffffff14', // white @ 8%
    thumbHover: '#ffffff1f', // white @ 12%
  },
  sidebar: {
    // codex dark: frosted glass over the near-black shell.
    border: '#ffffff0a', // white @ 4%
    shadow: 'none',
    translucency: '0.55',
    blur: '18px',
  },
  shimmer: {
    base: '#ffffff94', // fg @ 58%
    highlight: '#ffffffc7', // fg @ 78%
  },
  font: { ...codexFont, response: codexResponse },
  radius: codexRadius,
  shadow: {
    ...codexShadowBase,
    hairline: '0 0 0 0.5px rgba(255, 255, 255, 0.12)', // white @ 12% dark
  },
  surface: codexSurface,
  motion: codexMotion,
  spacing,
  control: codexControl,
  layout: codexLayout,
};

/* ------------------------------------------------------------------ */
/* Bobble — the app's OWN identity (neither claude nor codex).          */
/*                                                                      */
/* Design brief (jedd): unique but not flashy — the Apple-app aesthetic:*/
/* liquid-glass frosted surfaces, hairline borders, neutral ink on      */
/* soft gray, one restrained system-blue accent, sheet-style motion.    */
/* Deliberately NO gradients and NO violet/purple wash anywhere — the   */
/* brand gradient lives only in the app icon + agent cursor, never the  */
/* UI chrome. All values are original (Apple-LIKE, nothing harvested).  */
/* ------------------------------------------------------------------ */

const bobbleFont: Omit<ThemeTokens['font'], 'response'> = {
  // Pure system stack — SF Pro on macOS, the native feel with zero bundling.
  sans: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', system-ui, 'Segoe UI', sans-serif",
  serif: "'New York', ui-serif, Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  size: {
    caption: '12px',
    footnote: '13px',
    body: '14px',
    code: '13px',
    heading: '16px',
    title: '22px',
  },
  leading: {
    caption: '16px',
    footnote: '18px',
    body: '20px',
    code: '18px',
    heading: '21px',
    title: '28px',
  },
  weight: { regular: '400', medium: '500', semibold: '600', bold: '700', body: '400' },
};

/** Bobble response voice: comfortable system sans — 15px like Apple body copy. */
const bobbleResponse: ThemeTokens['font']['response'] = {
  family: bobbleFont.sans,
  size: '15px',
  leading: '23px',
  variation: 'normal',
};

// Apple-like continuous-feel rounding: a touch softer than claude, never pills.
const bobbleRadius: ThemeTokens['radius'] = {
  xs: '5px',
  sm: '7px',
  md: '10px',
  lg: '14px',
  full: '9999px',
  surface: '18px', // composer/dialog cards
  popover: '14px', // menus — visibly softer than claude's 8
  row: '9px',
  bubble: '16px',
  button: '10px', // rounded-rect, deliberately NOT a pill
  menuItem: '7px',
};

// Sheet-like motion: Apple's decelerating curves, gentle press, no theatrics.
const bobbleMotion: ThemeTokens['motion'] = {
  duration: {
    fast: '120ms',
    base: '180ms',
    slow: '300ms',
    dialogIn: '320ms',
    dialogOut: '160ms',
    menu: '180ms',
    toast: '240ms',
  },
  easing: {
    standard: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
    enter: 'cubic-bezier(0.32, 0.72, 0, 1)', // the Apple sheet curve
    exit: 'cubic-bezier(0.4, 0, 1, 1)',
    press: 'cubic-bezier(0.3, 0.7, 0.4, 1)',
    // Gentle settle with a whisper of overshoot — felt, not seen.
    spring: 'linear(0, 0.4038, 0.8093, 0.9834, 1.0243, 1.0176, 1.0055, 1.0004, 1)',
    toast: 'cubic-bezier(0.32, 0.72, 0, 1)',
  },
  pressScale: '0.97',
  pressScaleSmall: '0.95',
  shimmerDuration: '2.4s',
  shimmerEasing: 'ease-in-out',
  menuEnterDistance: '6px',
  menuEnterScale: '0.97',
  menuStagger: '0ms',
  menuItemRestingOpacity: '1',
  dialogEnterScale: '0.96',
  dialogEnterTranslate: '10px', // rises like a sheet
  dialogOrigin: 'center',
  toastEnterX: '0px',
  toastEnterY: '-8px',
};

const bobbleControl: ThemeTokens['control'] = {
  sm: '26px',
  md: '32px',
  lg: '40px',
  icon: '18px',
  iconStroke: '1.25',
};

const bobbleLayout: ThemeTokens['layout'] = {
  rowHeight: '32px',
  sidebarWidth: '272px',
  topbarHeight: '48px',
  threadWidth: '800px',
  proseWidth: '620px',
  thinkingPreviewHeight: '72px',
  menuPadding: '5px',
};

// THE bobble signature: liquid glass. Overlays/menus/dialogs are translucent
// with a heavy backdrop blur; the scrim itself frosts what's behind it.
const bobbleSurface: ThemeTokens['surface'] = {
  translucency: '0.78',
  blurOverlay: '20px',
  blurBackdrop: '8px',
};

// Soft, diffuse, low-contrast elevation — depth from blur, not darkness.
const bobbleShadowBase = {
  sm: '0 1px 3px rgba(0, 0, 0, 0.07)',
  md: '0 4px 14px rgba(0, 0, 0, 0.09)',
  lg: '0 12px 32px -6px rgba(0, 0, 0, 0.14)',
  popover: '0 18px 50px -10px rgba(0, 0, 0, 0.22)',
};

const bobbleLight: ThemeTokens = {
  bg: {
    base: '#f5f5f7', // Apple's soft platform gray
    raised: '#ffffff',
    overlay: '#fbfbfdd9', // translucent white — frosts via surface.blurOverlay
    inset: '#ececee',
    hover: '#0000000a',
    active: '#00000014',
    backdrop: '#00000059',
    sidebar: '#f2f2f7a6', // frosted glass over the window
    selected: '#7878801f', // Apple quaternary fill
    track: '#7878801f',
  },
  text: {
    primary: '#1d1d1f', // Apple ink
    secondary: '#424245',
    muted: '#86868b',
    inverse: '#ffffff',
    onAccent: '#ffffff',
    link: '#0066cc',
    placeholder: '#9d9da3',
    ghost: '#1d1d1f4d',
  },
  border: {
    subtle: '#0000000f', // hairlines everywhere
    default: '#0000001a',
    strong: '#00000038',
    focus: '#0071e3',
  },
  accent: {
    primary: '#0071e3', // restrained system blue — the ONLY accent in the chrome
    hover: '#0077ed',
    active: '#0062c4',
    subtle: '#0071e31a',
  },
  status: {
    info: { bg: '#e8f2fd', fg: '#0058b0', border: '#a7cdf7' },
    success: { bg: '#e4f7e9', fg: '#1d7a3b', border: '#93dcae' },
    warning: { bg: '#fdf0dd', fg: '#9a5b00', border: '#f5c26b' },
    danger: { bg: '#fde8e7', fg: '#c0271f', border: '#f5a49f' },
  },
  bubble: {
    bg: '#7878801f', // neutral fill, no accent tint
    fg: '#1d1d1f',
  },
  tooltip: {
    bg: '#2c2c2ee6', // dark glass
    fg: '#ffffff',
  },
  codeSurface: {
    inlineBg: '#7878801f',
    inlineFg: '#1d1d1f', // neutral — no claude red
    inlineBorder: '#00000000',
    blockBg: '#f6f6f8',
    blockBorder: '#0000000f',
  },
  diff: {
    addedFg: '#248a3d', // Apple system green (light)
    deletedFg: '#d70015', // system red (light)
    modifiedFg: '#c04c00', // system orange (light, darkened for contrast)
  },
  scrollbar: {
    thumb: '#00000026',
    thumbHover: '#00000040',
  },
  sidebar: {
    border: '#0000000d',
    shadow: 'none', // glass, not a floating card
    translucency: '0.65',
    blur: '24px',
  },
  shimmer: {
    base: '#1d1d1f8c',
    highlight: '#1d1d1fd9',
  },
  font: { ...bobbleFont, response: bobbleResponse },
  radius: bobbleRadius,
  shadow: {
    ...bobbleShadowBase,
    hairline: '0 0 0 0.5px rgba(0, 0, 0, 0.10)',
  },
  surface: bobbleSurface,
  motion: bobbleMotion,
  spacing,
  control: bobbleControl,
  layout: bobbleLayout,
};

const bobbleDark: ThemeTokens = {
  bg: {
    base: '#151517', // graphite, never pure black
    raised: '#1e1e21',
    overlay: '#232327d9', // translucent — frosts via surface.blurOverlay
    inset: '#121214',
    hover: '#ffffff0f',
    active: '#ffffff1a',
    backdrop: '#00000080',
    sidebar: '#1c1c1f8c', // frosted glass
    selected: '#ffffff17',
    track: '#7878805c', // Apple dark segmented track fill
  },
  text: {
    primary: '#f5f5f7',
    secondary: '#d6d6db',
    muted: '#98989f',
    inverse: '#1d1d1f',
    onAccent: '#ffffff',
    link: '#2997ff',
    placeholder: '#7c7c85',
    ghost: '#f5f5f74d',
  },
  border: {
    subtle: '#ffffff14',
    default: '#ffffff1f',
    strong: '#ffffff3d',
    focus: '#2997ff',
  },
  accent: {
    primary: '#0a84ff', // system blue (dark)
    hover: '#2997ff',
    active: '#006edb',
    subtle: '#0a84ff29',
  },
  status: {
    info: { bg: '#0a84ff24', fg: '#6cb2ff', border: '#0a84ff66' },
    success: { bg: '#30d15824', fg: '#30d158', border: '#30d15866' },
    warning: { bg: '#ff9f0a24', fg: '#ffb340', border: '#ff9f0a66' },
    danger: { bg: '#ff453a24', fg: '#ff6961', border: '#ff453a66' },
  },
  bubble: {
    bg: '#7878802e',
    fg: '#f5f5f7',
  },
  tooltip: {
    bg: '#38383ce6',
    fg: '#ffffff',
  },
  codeSurface: {
    inlineBg: '#78788033',
    inlineFg: '#f5f5f7',
    inlineBorder: '#00000000',
    blockBg: '#ffffff0a',
    blockBorder: '#ffffff0f',
  },
  diff: {
    addedFg: '#30d158',
    deletedFg: '#ff453a',
    modifiedFg: '#ff9f0a',
  },
  scrollbar: {
    thumb: '#ffffff21',
    thumbHover: '#ffffff38',
  },
  sidebar: {
    border: '#ffffff0f',
    shadow: 'none',
    translucency: '0.55',
    blur: '24px',
  },
  shimmer: {
    base: '#f5f5f794',
    highlight: '#f5f5f7d1',
  },
  font: { ...bobbleFont, response: bobbleResponse },
  radius: bobbleRadius,
  shadow: {
    // Dark glass needs slightly stronger separation than light.
    sm: '0 1px 3px rgba(0, 0, 0, 0.28)',
    md: '0 4px 14px rgba(0, 0, 0, 0.34)',
    lg: '0 12px 32px -6px rgba(0, 0, 0, 0.45)',
    popover: '0 18px 50px -10px rgba(0, 0, 0, 0.55)',
    hairline: '0 0 0 0.5px rgba(255, 255, 255, 0.14)',
  },
  surface: bobbleSurface,
  motion: bobbleMotion,
  spacing,
  control: bobbleControl,
  layout: bobbleLayout,
};

export const themes: Record<ThemeId, ThemeTokens> = {
  'claude-light': claudeLight,
  'claude-dark': claudeDark,
  'codex-light': codexLight,
  'codex-dark': codexDark,
  'bobble-light': bobbleLight,
  'bobble-dark': bobbleDark,
};

export const themeIds = Object.keys(themes) as ThemeId[];

export function parseThemeId(id: ThemeId): { flavor: ThemeFlavor; mode: ThemeMode } {
  const [flavor, mode] = id.split('-') as [ThemeFlavor, ThemeMode];
  return { flavor, mode };
}
