/**
 * @pi-desktop/ui — Pi Desktop design system, rebuilt strictly FROM the
 * Claude/Codex component spec book (element-extraction/spec-book/). Every
 * component styles exclusively through --pd-* tokens so one component renders
 * faithfully in both flavors; consumers load `@pi-desktop/ui/styles.css` once
 * at the root, after `@pi-desktop/themes/themes.css`.
 */

export type {
  ActivityFile,
  ActivityGroupCardProps,
  ActivityRowProps,
  DiffStatProps,
} from './components/activity.tsx';
export {
  ActivityGroupCard,
  ActivityRow,
  DiffStat,
  RollingNumber,
} from './components/activity.tsx';
export type {
  ActivityChainProps,
  ActivityStatus,
  ActivityStepData,
  ActivityStepKind,
  ActivityStepProps,
} from './components/activity-chain.tsx';
export {
  ActivityChain,
  ActivityStep,
  activitySummary,
  formatDuration,
  summarizeActivity,
} from './components/activity-chain.tsx';
export type {
  ComposerAddMenuProps,
  GenActionDescriptor,
  GenActionHandlers,
  GenActionKey,
} from './components/add-menu.tsx';
export { COMPOSER_GEN_ACTIONS, ComposerAddMenu, selectGenAction } from './components/add-menu.tsx';
export type { ArtifactPanelProps, ArtifactPanelState } from './components/artifact-panel.tsx';
export { ArtifactPanel } from './components/artifact-panel.tsx';
export type {
  ButtonProps,
  ButtonSize,
  ButtonVariant,
  IconButtonProps,
} from './components/button.tsx';
export { Button, buttonClass, IconButton } from './components/button.tsx';
export type {
  TaskChecklistItem,
  TaskChecklistProps,
  TaskChecklistSubagents,
  TaskState,
} from './components/checklist.tsx';
export { TaskChecklist } from './components/checklist.tsx';
export type {
  AttachmentPillProps,
  BadgeProps,
  BadgeTone,
  ChipProps,
  FloatingPillProps,
  KbdProps,
} from './components/chip.tsx';
export { AttachmentPill, Badge, Chip, FloatingPill, Kbd } from './components/chip.tsx';
export type { CodeBlockProps, ProseProps } from './components/code-block.tsx';
export { CodeBlock, Prose } from './components/code-block.tsx';
export type { ComposerProps } from './components/composer.tsx';
export { Composer, ComposerDivider } from './components/composer.tsx';
export type { ContextMenuItemProps } from './components/context-menu.tsx';
export {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './components/context-menu.tsx';
export type { ContextGaugeTooltipProps } from './components/context-tooltip.tsx';
export { ContextGaugeTooltip } from './components/context-tooltip.tsx';
export type {
  CheckboxProps,
  SegmentedControlOption,
  SegmentedControlProps,
  SwitchProps,
} from './components/controls.tsx';
export {
  Checkbox,
  SegmentedControl,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from './components/controls.tsx';
export type {
  CopyButtonProps,
  CopyFeedback,
  UseCopyFeedbackOptions,
} from './components/copy-button.tsx';
export { COPY_FEEDBACK_MS, CopyButton, useCopyFeedback } from './components/copy-button.tsx';
export type { CurtainProps, DialogContentProps } from './components/dialog.tsx';
export {
  Curtain,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './components/dialog.tsx';
export type {
  DiffFileData,
  DiffLine,
  DiffLineKind,
  DiffViewProps,
} from './components/diff-view.tsx';
export { DiffView } from './components/diff-view.tsx';
export type {
  DropdownMenuCheckboxItemProps,
  DropdownMenuItemProps,
  DropdownMenuRadioItemProps,
  DropdownMenuSubTriggerProps,
} from './components/dropdown-menu.tsx';
export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './components/dropdown-menu.tsx';
export type { EffortSliderProps } from './components/effort-slider.tsx';
export { EffortSlider, pointerToIndex } from './components/effort-slider.tsx';
export type { FileDropZoneProps } from './components/file-input.tsx';
export { FileDropZone } from './components/file-input.tsx';
export type { IconStrokeControlProps } from './components/icon-stroke-control.tsx';
export {
  clampIconStroke,
  ICON_STROKE_MAX,
  ICON_STROKE_MIN,
  IconStrokeControl,
} from './components/icon-stroke-control.tsx';
export * from './components/icons.tsx';
export type { ContextGaugeProps, ProgressBarProps } from './components/indicators.tsx';
export { ContextGauge, ProgressBar } from './components/indicators.tsx';
export type {
  CollapsibleSearchProps,
  InputProps,
  SearchInputProps,
  TextAreaProps,
} from './components/input.tsx';
export { CollapsibleSearch, Input, SearchInput, TextArea } from './components/input.tsx';
export type { MarkdownProps } from './components/markdown.tsx';
export { Markdown } from './components/markdown.tsx';
export type {
  MessageActionsProps,
  MessageFootnoteProps,
  ModelFootnoteProps,
  ResponseSpeedProps,
} from './components/message-actions.tsx';
export {
  MessageActions,
  MessageFootnote,
  ModelFootnote,
  ResponseSpeed,
} from './components/message-actions.tsx';
export type { BranchSwitcherProps, EditableMessageProps } from './components/message-edit.tsx';
export { BranchSwitcher, EditableMessage } from './components/message-edit.tsx';
export type { MessageRowProps, ThreadProps } from './components/message-row.tsx';
export { MessageRow, Thread } from './components/message-row.tsx';
export type { EffortOption, ModelOption, ModelPickerProps } from './components/model-picker.tsx';
export { ModelPicker } from './components/model-picker.tsx';
export type { PopoverContentProps } from './components/popover.tsx';
export {
  Popover,
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from './components/popover.tsx';
export type {
  QuestionAnswer,
  QuestionCardProps,
  QuestionMode,
  QuestionOption,
} from './components/question-card.tsx';
export { QuestionCard } from './components/question-card.tsx';
export type { ScrollAreaProps } from './components/scroll-area.tsx';
export { ScrollArea } from './components/scroll-area.tsx';
export type { SelectItemProps, SelectTriggerProps } from './components/select.tsx';
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './components/select.tsx';
export type { ShimmerTextProps, ThinkingBlockProps } from './components/shimmer.tsx';
export {
  isLongThought,
  LONG_THINKING_THRESHOLD,
  ShimmerText,
  ThinkingBlock,
  thinkingLabel,
} from './components/shimmer.tsx';
export type {
  SidebarFooterProps,
  SidebarProps,
  SidebarRowProps,
  SidebarSectionProps,
} from './components/sidebar.tsx';
export {
  Sidebar,
  SidebarFooter,
  SidebarRow,
  SidebarScroll,
  SidebarSection,
} from './components/sidebar.tsx';
export type { SliderProps } from './components/slider.tsx';
export { Slider } from './components/slider.tsx';
export type { SpinnerProps } from './components/spinner.tsx';
export { Spinner } from './components/spinner.tsx';
export type { SuggestionItem, SuggestionListProps } from './components/suggestion-list.tsx';
export { SuggestionList } from './components/suggestion-list.tsx';
export type { ToastProps, ToastTone } from './components/toast.tsx';
export { Toast, ToastAction, ToastProvider, ToastViewport } from './components/toast.tsx';
export type {
  FileExtIconProps,
  ToolIconKind,
  ToolIconProps,
} from './components/tool-icons.tsx';
export { FileExtIcon, fileExt, ToolIcon, toolIcon } from './components/tool-icons.tsx';
export type { TooltipProps } from './components/tooltip.tsx';
export { Tooltip, TooltipProvider } from './components/tooltip.tsx';
export type { MainSurfaceProps, TopBarProps } from './components/top-bar.tsx';
export { MainSurface, TopBar, TopBarTitle } from './components/top-bar.tsx';
export type {
  WebSearchResultData,
  WebSearchResultItemProps,
  WebSearchResultsProps,
} from './components/web-search.tsx';
export { WebSearchResultItem, WebSearchResults } from './components/web-search.tsx';
export type { VariantProps, VariantSelection, VariantsConfig } from './define-variants.ts';
export { defineVariants } from './define-variants.ts';
